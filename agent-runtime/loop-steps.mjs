// CC-Primitives P2 — agent loop step extraction + store.
//
// stepsFromLine() is a PURE mapper from one parsed CLI stream-json object to zero or
// more loop steps {kind, tool, summary}. Only discrete boundaries become steps —
// assistant text (think), assistant tool_use (tool), user tool_result (observe),
// result (result). stream_event deltas are IGNORED by design: that is the volume
// control (a turn yields dozens of steps, never hundreds of delta rows), so no
// batching/backpressure layer is needed on the bus.
//
// createLoopSteps() persists steps per task (ring buffer, cap 500) and emits an
// IDENTITY-ONLY `loop.step` frame ({agentId, taskId, seq, kind, tool}) — the summary
// stays behind the auth-gated GET /runtime/engine/steps, mirroring the vault.written
// rationale: a bus frame reaches every connected seat. Summaries are scrubbed BEFORE
// they land at rest.
const SUMMARY_MAX = 200;
// Parse-time cap is deliberately WIDER than the stored cap: the store scrubs BEFORE the
// final 200-char cut (sr-security P2 L1 — an exact-value secret straddling a tight
// truncation boundary would leave an unredacted prefix). 2000 bounds parser memory only.
const RAW_MAX = 2000;

const truncTo = (s, max) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
};
const trunc = (s) => truncTo(s, RAW_MAX);

// Extract plain text from a tool_result content field (string | [{type:"text",text}] | other).
function resultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === "string" ? c : c?.type === "text" ? c.text : "")).filter(Boolean).join(" ");
  }
  return "";
}

export function stepsFromLine(o) {
  if (!o || typeof o !== "object") return [];
  const out = [];
  if (o.type === "assistant" && Array.isArray(o.message?.content)) {
    for (const block of o.message.content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && block.text && String(block.text).trim()) {
        out.push({ kind: "think", tool: "", summary: trunc(block.text) });
      } else if (block.type === "tool_use") {
        let input = "";
        try { input = JSON.stringify(block.input ?? {}); } catch { input = ""; }
        const name = String(block.name || "").slice(0, 64);
        // CC-Primitives P3 — claude's own subagent spawn (Task/Agent tool) surfaces as
        // its own step kind, so the deck can show children without a second mechanism.
        const kind = /^(Task|Agent)$/.test(name) ? "subagent" : "tool";
        out.push({ kind, tool: name, summary: trunc(input) });
      }
    }
  } else if (o.type === "user" && Array.isArray(o.message?.content)) {
    for (const block of o.message.content) {
      if (block?.type === "tool_result") {
        out.push({ kind: "observe", tool: "", summary: trunc(resultText(block.content)) });
      }
    }
  } else if (o.type === "result") {
    out.push({ kind: "result", tool: "", summary: trunc(typeof o.result === "string" ? o.result : o.subtype || "") });
  }
  return out;
}

export function createLoopSteps({ db, emit, scrub, cap = 500, now = () => Date.now() }) {
  if (!db) throw new Error("createLoopSteps: db handle required");
  const clean = typeof scrub === "function" ? scrub : (s) => s;
  const say = typeof emit === "function" ? emit : () => {};
  const maxSeqStmt = db.prepare("SELECT MAX(seq) s FROM loop_steps WHERE task_id = ?");
  const insStmt = db.prepare("INSERT INTO loop_steps(task_id, seq, agent_id, kind, tool, summary, ts) VALUES(?, ?, ?, ?, ?, ?, ?)");
  const pruneStmt = db.prepare("DELETE FROM loop_steps WHERE task_id = ? AND seq <= ?");
  const listStmt = db.prepare("SELECT seq, agent_id AS agentId, kind, tool, summary, ts FROM loop_steps WHERE task_id = ? ORDER BY seq ASC");

  // Parse one stream-json object for a task; persist + emit any steps it yields.
  // Never throws — the engine's stdout parser must stay crash-proof.
  function record(agentId, taskId, lineObj) {
    if (!taskId) return 0;
    let steps;
    try { steps = stepsFromLine(lineObj); } catch { return 0; }
    if (!steps.length) return 0;
    // sr-security P2 M1 — the seq read must sit inside the crash-proof envelope too
    // (a closed/corrupt DB during shutdown would otherwise throw into the engine's
    // stdout 'data' handler and take the process down).
    let seq;
    try { seq = Number(maxSeqStmt.get(taskId)?.s || 0); } catch { return 0; }
    for (const st of steps) {
      seq += 1;
      try {
        // Scrub FIRST, then the stored 200-char cut (L1); tool name scrubbed too (L2).
        const summary = truncTo(clean(st.summary), SUMMARY_MAX);
        const tool = String(clean(st.tool) ?? "").slice(0, 64);
        insStmt.run(taskId, seq, String(agentId || ""), st.kind, tool, summary, now());
        if (seq > cap) pruneStmt.run(taskId, seq - cap);
        say("loop.step", { agentId: String(agentId || ""), taskId, seq, kind: st.kind, tool });
      } catch { /* observational — a bad row must never kill the spawn parser */ }
    }
    return steps.length;
  }

  function list(taskId) {
    try { return listStmt.all(taskId); } catch { return []; }
  }

  return { record, list };
}
