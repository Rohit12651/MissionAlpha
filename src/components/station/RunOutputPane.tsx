import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "lucide-react";
import { tok } from "../../lib/agentMeta";
import type { RuntimeEvent } from "../../lib/useRuntimeEvents";
import { getEngineRuns, getRunOutput, latestTaskIdFor, type RunOutputDoc } from "../../lib/stationClient.ts";

// MUNDER-ADOPTION A6 — the read-only run window. CLOSED BY DEFAULT and opened on
// demand: the whole point of the Inbox is that nobody babysits agents, so the raw
// stream is an inspection channel, not a landing surface. Read-only BY CONSTRUCTION —
// there is no write route behind it and no input element in it.
//
// Data path: taskId derived from GET /runtime/engine/runs (same derivation LoopStream
// uses), text from the gated GET /runtime/engine/output. While open, a `run.output`
// frame for this task triggers a re-read (identity-only frame → re-fetch contract).

export function RunOutputPane({ agentId, lastEvent }: { agentId: string; lastEvent?: RuntimeEvent | null }) {
  const [open, setOpen] = useState(false);
  const [doc, setDoc] = useState<RunOutputDoc | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "empty" | "error">("idle");
  const taskRef = useRef<string | null>(null);
  const seenRef = useRef<RuntimeEvent | null>(null);
  const preRef = useRef<HTMLPreElement | null>(null);

  const load = useCallback(async () => {
    setState("loading");
    try {
      const runs = await getEngineRuns();
      const taskId = latestTaskIdFor(runs.tasks, agentId);
      taskRef.current = taskId;
      if (!taskId) { setDoc(null); setState("empty"); return; }
      const out = await getRunOutput(taskId);
      if (out && typeof out.text === "string") { setDoc(out); setState("idle"); }
      else { setDoc(null); setState("empty"); }
    } catch {
      // 404 = nothing buffered (never spawned / evicted) — honest empty, not an error.
      setDoc(null); setState("empty");
    }
  }, [agentId]);

  useEffect(() => { if (open) void load(); }, [open, load]);

  // Re-read on a run.output frame for the derived task, only while open.
  useEffect(() => {
    if (!open || !lastEvent || lastEvent.name !== "run.output") return;
    if (seenRef.current === lastEvent) return;
    seenRef.current = lastEvent;
    const d = lastEvent.data as { taskId?: unknown; agentId?: unknown };
    if (d.agentId !== agentId && d.taskId !== taskRef.current) return;
    void load();
  }, [open, lastEvent, agentId, load]);

  // Keep the tail in view — the newest output is what the operator opened this for.
  useEffect(() => {
    if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight;
  }, [doc]);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded px-2 py-1 font-mono text-[10.5px] outline-none transition-colors duration-150 hover:bg-panel-2 active:opacity-80 focus-visible:ring-2 focus-visible:ring-accent-cyan"
        style={{ color: tok("muted"), border: `1px dashed ${tok("border")}` }}
      >
        <Terminal size={11} aria-hidden />
        {open ? "close run output" : "inspect run output"}
      </button>
      <span className="ml-2 font-mono text-[9.5px]" style={{ color: tok("muted") }}>
        read-only · write stays gated
      </span>

      {open && (
        <div className="mt-2">
          {state === "loading" && <p className="text-[11px] text-muted">reading the run buffer…</p>}
          {state === "empty" && (
            <p className="text-[11px] text-muted">
              no output buffered for this station's latest task — it has not spawned yet, or the buffer rotated out.
            </p>
          )}
          {doc && state === "idle" && (
            <>
              <pre
                ref={preRef}
                className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words rounded-md p-2 font-mono text-[10px] leading-relaxed"
                style={{ backgroundColor: tok("bg"), border: `1px solid ${tok("border")}`, color: tok("muted"), overscrollBehavior: "contain" }}
                aria-label={`Raw output of task ${doc.taskId}, ${doc.bytes} bytes, read only`}
              >
                {doc.text}
              </pre>
              <p className="mt-1 font-mono text-[9.5px] tabular-nums" style={{ color: tok("muted") }}>
                {doc.taskId} · {doc.bytes.toLocaleString()} bytes{doc.trimmed ? " · older output trimmed" : ""}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
