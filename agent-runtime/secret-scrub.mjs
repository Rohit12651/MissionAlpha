// ADR-033 — per-spawn MCP credential egress scrub. Ref-counted so a cred shared by
// concurrent spawns is only dropped from the redaction set when the LAST spawn using
// it ends. Paired with once() so a single spawn's cleanup (which Node may trigger via
// BOTH 'error' and 'close') decrements EXACTLY once — never double-counting a sibling
// spawn's live cred out of the set (that would leak it into SSE).

// Wrap a fn so it runs at most once, regardless of how many times it's called.
export function once(fn) {
  let done = false;
  return (...a) => {
    if (done) return;
    done = true;
    return fn(...a);
  };
}

export function createSecretScrubber() {
  const counts = new Map(); // secret value → live refcount

  function add(list) {
    for (const s of list || []) if (s) counts.set(s, (counts.get(s) || 0) + 1);
  }
  function remove(list) {
    for (const s of list || []) {
      if (!s) continue;
      const n = (counts.get(s) || 0) - 1;
      if (n <= 0) counts.delete(s);
      else counts.set(s, n);
    }
  }
  // redact every currently-live secret value from a string about to egress.
  function scrub(text) {
    if (typeof text !== "string") return text;
    let out = text;
    for (const s of counts.keys()) out = out.split(s).join("[redacted-mcp-cred]");
    return out;
  }
  const active = () => counts.size;
  return { add, remove, scrub, active };
}
