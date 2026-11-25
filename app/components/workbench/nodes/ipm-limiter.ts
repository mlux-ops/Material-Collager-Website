// FRAMEWORK-FREE images-per-minute limiter for Multi-Run (no DOM, no React,
// no "@/" alias, no node: builtins) so tests/*.test.mjs can drive it with a
// fake clock.
//
// OpenAI rate-limits the Images API by IMAGES per minute (IPM), not by
// requests: one call with n=10 spends ten. So the window counts images. A
// request for n images reserves n slots at the moment it is admitted and the
// slots free 60 seconds later -- a sliding window, not a fixed minute. A
// waiter is admitted when the images already reserved in the last 60 seconds
// plus its own n fit under ITS cap; each caller passes its own cap (a node's
// `ipm` param) while the reservations themselves are shared, so every
// Multi-Run node on the page draws on one budget.
//
// Waiters are served first come, first served: a large chunk at the head of
// the queue is never starved by smaller ones behind it, and chunks launch in
// the order they were planned. Abort removes a waiter without reserving
// anything.

export const IPM_WINDOW_MS = 60_000;

export type LimiterClock = {
  now: () => number;
  // Resolves after `ms`, or rejects with an AbortError as soon as `signal`
  // aborts. Injected so tests can drive time by hand.
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
};

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

export function realSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export const REAL_CLOCK: LimiterClock = { now: () => Date.now(), sleep: realSleep };

type Reservation = { at: number; images: number };

export class IpmLimiter {
  private readonly clock: LimiterClock;
  private reservations: Reservation[] = [];
  // Tail of the FIFO admission chain. Each acquire waits for the previous one
  // to settle (admitted OR aborted) before it competes for the window.
  private tail: Promise<void> = Promise.resolve();

  constructor(clock: LimiterClock = REAL_CLOCK) {
    this.clock = clock;
  }

  // Images reserved inside the current 60-second window.
  used(): number {
    this.prune();
    return this.reservations.reduce((sum, reservation) => sum + reservation.images, 0);
  }

  // How long until `images` more would fit under `cap`, or 0 when they fit now.
  waitFor(images: number, cap: number): number {
    this.prune();
    let used = this.used();
    if (used + images <= cap) return 0;
    const now = this.clock.now();
    for (const reservation of this.reservations) {
      used -= reservation.images;
      if (used + images <= cap) return Math.max(1, reservation.at + IPM_WINDOW_MS - now);
    }
    // Unreachable while images <= cap (an empty window always fits).
    return IPM_WINDOW_MS;
  }

  // Waits until `images` fit under `cap`, then reserves them, resolving to a
  // function that gives that exact reservation back (for a chunk that was
  // admitted but never sent because the run stopped meanwhile). Rejects with
  // an AbortError (reserving nothing) if `signal` aborts first, and with a
  // RangeError for a request no window could ever admit.
  acquire(images: number, cap: number, signal?: AbortSignal): Promise<() => void> {
    if (!Number.isInteger(images) || images < 1) return Promise.reject(new RangeError("A request must reserve at least one image."));
    if (!Number.isFinite(cap) || images > cap) {
      return Promise.reject(new RangeError(`A request for ${images} images can never fit an images-per-minute cap of ${cap}.`));
    }
    const previous = this.tail;
    const admitted = (async () => {
      // The previous waiter's outcome is irrelevant, only that it is done.
      await previous.catch(() => undefined);
      for (;;) {
        if (signal?.aborted) throw abortError();
        const wait = this.waitFor(images, cap);
        if (wait === 0) {
          const reservation: Reservation = { at: this.clock.now(), images };
          this.reservations.push(reservation);
          return () => this.release(reservation);
        }
        await this.clock.sleep(wait, signal);
      }
    })();
    this.tail = admitted.then(() => undefined, () => undefined);
    return admitted;
  }

  private release(reservation: Reservation): void {
    const index = this.reservations.indexOf(reservation);
    if (index >= 0) this.reservations.splice(index, 1);
  }

  private prune(): void {
    const cutoff = this.clock.now() - IPM_WINDOW_MS;
    while (this.reservations.length && this.reservations[0].at <= cutoff) this.reservations.shift();
  }
}

// Module-level singletons keyed by budget. Every Multi-Run node uses
// MULTI_RUN_BUDGET, so two nodes running at once (or a node pressed twice in
// quick succession) share one account-wide images-per-minute budget.
export const MULTI_RUN_BUDGET = "openai-images";
const limiters = new Map<string, IpmLimiter>();

export function sharedIpmLimiter(key: string = MULTI_RUN_BUDGET): IpmLimiter {
  let limiter = limiters.get(key);
  if (!limiter) {
    limiter = new IpmLimiter();
    limiters.set(key, limiter);
  }
  return limiter;
}
