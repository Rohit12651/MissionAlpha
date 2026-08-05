// Story-Pipeline S6 (react-review remediation) — the trailing coalescer that collapses an SSE
// story.changed storm into ONE refetch. Pure + timer-injected, so it runs under
// `node --experimental-strip-types --test` with a hand-rolled fake clock (no DOM, no React).

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeCoalescer, NONCE_COALESCE_MS } from "../coalesce.ts";

/** A deterministic fake clock: `set` returns an id; `tick(ms)` fires everything now due. */
function fakeClock() {
  let now = 0;
  let id = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    timer: {
      set(fn: () => void, ms: number) {
        const h = ++id;
        pending.set(h, { at: now + ms, fn });
        return h;
      },
      clear(h: unknown) {
        pending.delete(h as number);
      },
    },
    tick(ms: number) {
      now += ms;
      for (const [h, t] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now) {
          pending.delete(h);
          t.fn();
        }
      }
    },
    get pendingCount() {
      return pending.size;
    },
  };
}

test("a burst of bumps within the window coalesces to a single trailing emit", () => {
  const clock = fakeClock();
  let emits = 0;
  const c = makeCoalescer(() => emits++, 150, clock.timer);

  // Five bumps in quick succession (an SSE storm), each 10ms apart — all inside one 150ms window.
  for (let i = 0; i < 5; i++) {
    c.bump();
    clock.tick(10);
  }
  assert.equal(emits, 0, "nothing emits mid-burst (window keeps re-arming)");
  assert.equal(clock.pendingCount, 1, "only one timer is ever armed");

  clock.tick(150); // quiet window elapses after the last bump
  assert.equal(emits, 1, "exactly one emit for the whole burst");
});

test("bumps separated by more than the window each emit", () => {
  const clock = fakeClock();
  let emits = 0;
  const c = makeCoalescer(() => emits++, 150, clock.timer);

  c.bump();
  clock.tick(150);
  c.bump();
  clock.tick(150);
  assert.equal(emits, 2, "two well-separated bumps → two emits");
});

test("cancel() drops a pending emit (leak-safe on unmount)", () => {
  const clock = fakeClock();
  let emits = 0;
  const c = makeCoalescer(() => emits++, 150, clock.timer);

  c.bump();
  c.cancel();
  clock.tick(1000);
  assert.equal(emits, 0, "cancelled emit never fires");
  assert.equal(clock.pendingCount, 0, "no timer left armed");
});

test("default window is 150ms", () => {
  assert.equal(NONCE_COALESCE_MS, 150);
});
