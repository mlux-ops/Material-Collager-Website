// Pending edits for one review board, and the order they reach the server in.
//
// A note is typed a character at a time, so edits are coalesced for a moment
// before they are sent; a dropdown change goes at once. Two rules matter:
//
// - Coalescing merges `notes` per slot. A shallow merge replaced the whole
//   notes object, so a second note typed inside the debounce window silently
//   dropped the first before anything was sent.
// - flush() is the barrier a paid render waits on. It sends whatever is still
//   pending, waits for every write already in flight, and rejects if the last
//   attempt failed. The render route reads board state from D1, so once flush
//   resolves the render sees what the reviewer typed — and a save that failed
//   stops the render instead of paying for one built from stale text.
//
// Writes go out one at a time. A failed write's patch is kept, beneath
// anything typed since, and goes out with the next save or flush, so nothing
// typed is lost to a transient error. Framework-free so node --test can
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

export type BoardSaveQueue = {
  /** Coalesces `patch` with anything pending; sends after `debounceMs` of quiet. */
  saveSoon(patch: BoardPatch): void;
  /** Sends `patch`, with anything pending, now. Resolves false on failure (reported through onError). */
  saveNow(patch: BoardPatch): Promise<boolean>;
  /** Sends anything pending and waits for every write in flight; rejects if the last write failed. */
  flush(): Promise<void>;
  /** Removes and returns what has not been sent yet, for a last-chance send on unmount. */
  takePending(): BoardPatch | null;
};

export function createBoardSaveQueue(options: {
  send: (patch: BoardPatch) => Promise<void>;
  debounceMs: number;
  onError?: (error: Error) => void;
}): BoardSaveQueue {
  let pending: BoardPatch | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<void> = Promise.resolve();

  const takePending = (): BoardPatch | null => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const taken = pending;
    pending = null;
    return taken;
  };

  const enqueue = (patch: BoardPatch): Promise<void> => {
    const write = chain
      .then(() => options.send(patch))
      .catch((cause: unknown) => {
        pending = mergeBoardPatch(patch, pending ?? {});
        const error = cause instanceof Error ? cause : new Error(String(cause));
        options.onError?.(error);
        throw error;
      });
    chain = write.catch(() => undefined);
    return write;
  };

  return {
    saveSoon(patch) {
      pending = mergeBoardPatch(pending, patch);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const queued = takePending();
        if (queued) enqueue(queued).catch(() => undefined);
      }, options.debounceMs);
    },
    async saveNow(patch) {
      try {
        await enqueue(mergeBoardPatch(takePending(), patch));
        return true;
      } catch {
        return false;
      }
    },
    async flush() {
      await chain;
      const queued = takePending();
      if (queued) await enqueue(queued);
    },
    takePending,
  };
}
