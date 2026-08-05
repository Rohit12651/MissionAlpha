// Story-Pipeline S6 (react-review remediation) — a trailing coalescer. Collapses a burst of
// rapid bumps (an SSE story.changed storm) into a single trailing emit, so a live nonce does
// not drive one refetch per frame. Timer-injectable so the pure core is unit-testable with a
// fake clock (no DOM, no React) under `node --experimental-strip-types`.

/** The board + detail coalesce window (ms). One quiet window after the last bump → one emit. */
export const NONCE_COALESCE_MS = 150;

export interface Coalescer {
  /** Note a bump; (re)arms the single trailing emit. */
  bump(): void;
  /** Cancel any pending emit (effect cleanup / unmount) — leak-safe. */
  cancel(): void;
}

interface TimerLike {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const REAL_TIMER: TimerLike = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/**
 * Make a trailing coalescer around `emit`. Each `bump()` restarts the `waitMs` window; `emit`
 * fires once, `waitMs` after the LAST bump of a burst. `timer` is injected in tests.
 */
export function makeCoalescer(emit: () => void, waitMs: number = NONCE_COALESCE_MS, timer: TimerLike = REAL_TIMER): Coalescer {
  let handle: unknown = null;
  return {
    bump() {
      if (handle !== null) timer.clear(handle);
      handle = timer.set(() => {
        handle = null;
        emit();
      }, waitMs);
    },
    cancel() {
      if (handle !== null) {
        timer.clear(handle);
        handle = null;
      }
    },
  };
}
