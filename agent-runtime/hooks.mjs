// Phase 1 / R1 — the LIFECYCLE HOOK DISPATCHER.
//
// WHAT IT IS: one choke point that fires named, INTERNAL functions at fixed moments of an
// engine turn. It is the seam that lets a quality gate, a scrub, a learning write or a
// veto run at the right instant without every one of them growing its own call site
// inside engineDispatch.
//
// LAW 5, AND WHY IT IS NOT NEGOTIABLE: a hook is an INTERNAL MODULE FUNCTION, never an
// operator-configurable command string. ruflo's hook system takes shell commands from
// settings.json; that is a remote-code-execution surface wearing a configuration hat, and
// it is the single reason its hook design was rejected during the adoption review while
// its hook SHAPE was adopted. Config here may only toggle a known event on or off. It can
// never say WHAT runs. `registerHook` is called from server.mjs with real functions; there
// is no path from a JSON file to executable code.
//
// A HOOK MUST NEVER BREAK A TURN. Every handler runs inside its own try/catch. A throwing
// hook is logged and skipped — the turn continues. The one exception is a deliberate VETO
// (see below), which is a decision, not a fault.
//
// THE VETO. `pre-task` and `post-edit` handlers may return `{ abort: true, reason }`. That
// stops the turn and produces a structured refusal the engine's existing self-heal path
// classifies like any other failure. This is the mechanism that turns "the quality gate
// noticed a problem" into "the run stopped before minting a Delivery" — the difference
// between catching a fault mid-run and paying for a full spawn to produce something the
// operator then has to reject.

/** The CLOSED lifecycle event set. A sixth event is a code change, never a config value. */
export const HOOK_EVENTS = Object.freeze([
  "pre-task",     // before dispatch. May VETO.
  "post-edit",    // after the model wrote into the worktree, before the diff is read. May VETO.
  "post-task",    // after a turn settles successfully.
  "on-error",     // after a turn throws or returns an error.
  "session-end",  // after the turn is fully done, success or not. Never vetoes.
]);
const EVENT_SET = new Set(HOOK_EVENTS);

/** Events whose handlers are allowed to stop the turn. */
export const VETO_EVENTS = Object.freeze(new Set(["pre-task", "post-edit"]));

export function createHooks(deps = {}) {
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const emit = typeof deps.emit === "function" ? deps.emit : () => {};
  // Config may only ENABLE/DISABLE a known event. It cannot introduce one, and it cannot
  // say what runs. An unknown key is ignored rather than honoured.
  const enabled = new Map(HOOK_EVENTS.map((e) => [e, true]));
  for (const [k, v] of Object.entries(deps.enabled || {})) {
    if (EVENT_SET.has(k)) enabled.set(k, v !== false);
  }

  /** event → [{ name, fn }] */
  const handlers = new Map(HOOK_EVENTS.map((e) => [e, []]));

  /**
   * Register an internal handler. Throws on an unknown event — a typo must fail loudly at
   * boot, not silently never fire.
   */
  function register(event, name, fn) {
    if (!EVENT_SET.has(event)) throw new Error(`hooks.register: unknown event '${event}'`);
    if (typeof fn !== "function") throw new Error(`hooks.register: '${name}' is not a function`);
    handlers.get(event).push({ name, fn });
    return () => {
      const list = handlers.get(event);
      const i = list.findIndex((h) => h.fn === fn);
      if (i >= 0) list.splice(i, 1);
    };
  }

  /**
   * Fire every handler for `event` in registration order.
   *
   * Returns { fired, aborted, reason, by } — `aborted` is true only when a veto-capable
   * event had a handler return { abort: true }. The FIRST veto wins and short-circuits the
   * rest (later handlers cannot un-veto).
   *
   * Never throws.
   */
  async function fire(event, ctx = {}) {
    if (!EVENT_SET.has(event)) {
      log(`[hooks] refused unknown event '${event}'`);
      return { fired: 0, aborted: false };
    }
    if (!enabled.get(event)) return { fired: 0, aborted: false, skipped: "disabled" };

    let fired = 0;
    for (const { name, fn } of handlers.get(event)) {
      let out;
      try {
        out = await fn(ctx);
        fired++;
      } catch (e) {
        // A broken hook degrades to a no-op. It must never take the turn with it.
        log(`[hooks] ${event}/${name} threw: ${e?.message || e}`);
        continue;
      }
      if (out && out.abort === true) {
        if (!VETO_EVENTS.has(event)) {
          // A non-veto event returning abort is a programming error, not a decision.
          log(`[hooks] ${event}/${name} returned abort but '${event}' cannot veto — ignored`);
          continue;
        }
        const reason = String(out.reason || `${name} vetoed the turn`).slice(0, 500);
        try {
          emit("run.killed", {
            taskId: ctx.taskId ?? null,
            agentId: ctx.agentId ?? null,
            event,
            reason,
          });
        } catch { /* the bus is observational — a veto still stands without it */ }
        return { fired, aborted: true, reason, by: name };
      }
    }
    return { fired, aborted: false };
  }

  /** Introspection for doctor / tests. Never exposes the functions themselves. */
  function describe() {
    return HOOK_EVENTS.map((e) => ({
      event: e,
      enabled: enabled.get(e),
      canVeto: VETO_EVENTS.has(e),
      handlers: handlers.get(e).map((h) => h.name),
    }));
  }

  return { register, fire, describe, HOOK_EVENTS };
}
