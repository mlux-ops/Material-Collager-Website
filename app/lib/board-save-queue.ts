// Pending edits for one review board, and the order they reach the server in.
//
// A note is typed a character at a time, so edits are coalesced for a moment
// before they are sent; a dropdown change goes at once. Three rules matter:
//
// - Coalescing merges `notes` per slot. A shallow merge replaced the whole
//   notes object, so a second note typed inside the debounce window silently
//   dropped the first before anything was sent.
// - At most one write is ever in flight. While one is out, a debounce tick or
//   saveNow only updates `pending` — it never starts a second, overlapping
//   send. Two writes to the server that don't know about each other is what
//   let a later edit lose to an earlier one: each write's failure handler
//   restores its own patch from what it remembers, and if a second write was
//   already out when the first one failed, that restore could land on top of
//   the second write's own (later, more current) failure — or success.
// - flush() is the barrier a paid render waits on: it forces anything pending
//   out now (cancelling its debounce), rides through the current write and
//   any it goes on to trigger, and rejects if that fails — so a render can
//   only start once the queue has genuinely emptied.
//
// A failed write's patch is merged back beneath `pending` rather than on top
// of it, and only for the fields whose control still shows the edit (the
// text inputs: instruction, notes) — a dropdown reverts to the last saved
// value and reports the error instead, so resending its stale value here
// could apply it to a later, unrelated save. No automatic retry: the kept
// edit waits for the next save or flush. Framework-free so node --test can
// exercise it without a DOM.

export type BoardPatch = {
  instruction?: string;
  heroItemId?: string | null;
  quality?: string | null;
  background?: string | null;
  notes?: Record<string, string>;
};

export function mergeBoardPatch(older: BoardPatch | null, newer: BoardPatch): BoardPatch {
  const merged: BoardPatch = { ...(older ?? {}), ...newer };
  if (older?.notes && newer.notes) merged.notes = { ...older.notes, ...newer.notes };
  return merged;
}

// After a failed write, only the fields whose control still shows the edit
// are worth re-queuing. The textarea and note inputs keep whatever the
// reviewer typed even after an error; the dropdowns (quality, background,
// hero slot) revert to the last confirmed value and show the error instead —
// so resending them here would resurrect a value the screen no longer shows.
function keepEditedFields(patch: BoardPatch): BoardPatch {
  const kept: BoardPatch = {};
  if (patch.instruction !== undefined) kept.instruction = patch.instruction;
  if (patch.notes !== undefined) kept.notes = patch.notes;
  return kept;
}

// A failed dropdown-only patch keeps nothing (keepEditedFields drops every
// field it had), and merging "nothing" beneath a `pending` that is itself
// null would otherwise leave `pending` as `{}` — truthy, so every check
// against `pending === null` below would treat it as unfinished work and try
// to resend an empty patch, forever, if the resend also failed.
function normalizePending(patch: BoardPatch): BoardPatch | null {
  return Object.keys(patch).length > 0 ? patch : null;
}

// String(cause) can itself throw — Object.create(null) has no toString to
// fall back to (probe 9). This must never throw: it runs ahead of the
// pending-restore and dropped-counter updates in the failure handler below,
// which a throw here would otherwise skip entirely.
function safeErrorMessage(cause: unknown): string {
  try {
    return String(cause);
  } catch {
    return "a rejection value that could not be converted to a message";
  }
}

export type BoardSaveQueue = {
  /** Coalesces `patch` with anything pending; sends after `debounceMs` of quiet. */
  saveSoon(patch: BoardPatch): void;
  /** Sends `patch`, with anything pending, now. The result reflects whichever write actually ends up carrying it, not just this call's own send: false only when the attempt drainOrThrow itself starts and awaits fails outright; a failure on a write it merely rode along on (one a success handler started) can be silently requeued and retried within the same call, still resolving true. Either way, onError already reported the failure. */
  saveNow(patch: BoardPatch): Promise<boolean>;
  /** Sends anything pending and waits for every write in flight; rejects if the attempt it makes fails, or if a write it only waited on failed on a dropdown value nothing newer replaced. */
  flush(): Promise<void>;
  /** Removes and returns what has not been sent yet, without sending it. Used by tests; production code flushes instead, so nothing bypasses the queue. */
  takePending(): BoardPatch | null;
};

export function createBoardSaveQueue(options: {
  send: (patch: BoardPatch) => Promise<void>;
  debounceMs: number;
  onError?: (error: Error) => void;
}): BoardSaveQueue {
  let pending: BoardPatch | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // The one write currently out, if any — the single source of truth for
  // "is something in flight". It never rejects: a failed send updates
  // `pending` and resolves, so anything that only needs to know when the
  // current write settles (a debounce tick, saveNow riding along on someone
  // else's write) can await it without a try/catch of its own.
  let inFlight: Promise<void> | null = null;
  // Counts every failure that dropped a dropdown value nothing newer had
  // already replaced. drainOrThrow compares this against its own starting
  // count to tell "a write I only waited on just failed silently" from
  // "nothing has gone wrong since I started" — such a failure would
  // otherwise be invisible to a waiter who made no attempt of its own.
  let dropped = 0;
  let droppedError: Error | null = null;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  // Starts sending `pending`, unless a write is already out or there is
  // nothing to send — the one gate that keeps at most one write in flight at
  // a time. Returns the attempt it started (which DOES reject on failure), so
  // a caller that needs to know whether ITS trigger succeeded can await that
  // directly; everyone else just watches `inFlight` settle.
  function pump(): Promise<void> | null {
    if (inFlight || pending === null) return null;
    const patch = pending;
    pending = null;
    // send() is documented to return a Promise, but a synchronous throw (a
    // non-async implementation, or one that throws before its first await)
    // must not lose this patch, and must not escape uncaught from the plain
    // setTimeout callback that can also reach here — normalize it into a
    // rejection so the failure handler below runs exactly as it would for an
    // async one.
    let sending: Promise<void>;
    try {
      sending = options.send(patch);
    } catch (cause) {
      sending = Promise.reject(cause);
    }
    const attempt: Promise<void> = sending.then(
      () => {
        inFlight = null;
        // A no-op while typing is still debouncing — that timer owns
        // `pending` until it fires and calls pump() itself (see saveSoon).
        // Draining here unconditionally is what let a steady typist's own
        // debounce get run over by every write finishing in turn.
        if (timer === null) pump();
      },
      (cause: unknown) => {
        try {
          const error = cause instanceof Error ? cause : new Error(safeErrorMessage(cause));
          // `pending` here still holds exactly what accumulated while this
          // write was out — the restore below hasn't run yet — so this is
          // the only place a dropdown field's failure can still be told
          // apart from one a newer edit already replaced. A replaced value
          // is not something any drain should reject over: the newer one
          // is what a drain attempts instead (see drainOrThrow) — though
          // which write ends up resolving a caller's saveNow still depends
          // on timing (see its doc above).
          const droppedUnreplaced =
            (patch.quality !== undefined && pending?.quality === undefined) ||
            (patch.background !== undefined && pending?.background === undefined) ||
            (patch.heroItemId !== undefined && pending?.heroItemId === undefined);
          // Newer edits made while this was in flight are the only things
          // that belong in `pending` now; the failed patch (filtered to the
          // fields still shown as edited) goes back in beneath them, never
          // on top, so a stale value can never outrank an edit typed after
          // it.
          pending = normalizePending(mergeBoardPatch(keepEditedFields(patch), pending ?? {}));
          if (droppedUnreplaced) {
            dropped += 1;
            droppedError = error;
          }
          options.onError?.(error);
          // No auto-resend: the kept edit waits for the next save or flush.
          // Rethrown so `attempt` itself rejects — a direct awaiter (flush)
          // learns THIS attempt failed, instead of looping on a `pending`
          // that this same handler just refilled.
          throw error;
        } finally {
          // In a finally, not right after: onError is caller-supplied and can
          // itself throw, and the deliberate `throw error` above must still
          // clear this either way, or a wedged `inFlight` spins every later
          // drain forever on an already-settled promise.
          inFlight = null;
        }
      },
    );
    inFlight = attempt.catch(() => undefined);
    return attempt;
  }

  // Waits for anything already out, forces the rest of `pending` out
  // (cancelling its debounce), and rides through however many writes that
  // takes. Shared by saveNow and flush: rejects if the attempt it makes
  // itself fails, or if a write it only waited on dropped an unreplaced
  // dropdown value (`dropped`, above) — either way, no automatic retry
  // after. A waited-on write that failed but left something in `pending`
  // (a kept text field, or a newer dropdown value) is not a rejection here:
  // the loop below goes on to attempt that instead.
  async function drainOrThrow(): Promise<void> {
    const droppedAtStart = dropped;
    for (;;) {
      while (inFlight) await inFlight;
      if (pending === null) {
        if (dropped !== droppedAtStart) throw droppedError;
        return;
      }
      clearTimer(); // a save made during the wait above may have armed its own timer
      const attempt = pump();
      // Always starts an attempt: inFlight is null and pending isn't, so
      // pump() can't return null here.
      await attempt;
    }
  }

  return {
    saveSoon(patch) {
      pending = mergeBoardPatch(pending, patch);
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        pump();
      }, options.debounceMs);
    },
    async saveNow(patch) {
      pending = mergeBoardPatch(pending, patch);
      clearTimer();
      try {
        await drainOrThrow();
        return true;
      } catch {
        return false;
      }
    },
    async flush() {
      await drainOrThrow();
    },
    takePending() {
      clearTimer();
      const taken = pending;
      pending = null;
      return taken;
    },
  };
}
