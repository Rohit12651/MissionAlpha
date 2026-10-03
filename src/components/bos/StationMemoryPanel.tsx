// CC-Primitives P6 — the Vault's station memory editor. BOSS edits a station's
// CLAUDE.md (agent-runtime/station-memory.mjs) straight from the log, no separate
// surface for it.
//
// ROSTER: pulled from stationMeta.ts — the SAME client mirror of
// agent-runtime/seed-stations.mjs that already drives the deck — plus the Captain
// (CAPTAIN_ID). Never a second hardcoded id list.
//
// LIVE: `memoryLiveNonce` is bumped by the App on every `memory.changed` frame,
// mirroring VaultPage's own `liveNonce`/`vault.written` wiring. The panel re-READS
// the selected station's memory rather than trying to reconstruct it from the frame.
//
// WRITES: PUT is approver-gated server-side (station-memory is the most privileged
// prompt surface there is). A 403 renders as "approver seat required"
// (memoryErrorMessage); every other 400 is station-memory.mjs's own sentence,
// rendered verbatim — never invented here.
//
// UNTRUSTED TEXT: the memory body is BOSS-authored but still free text. It lives in
// a controlled <textarea> and reaches the DOM only as a React value — no innerHTML.

import { useEffect, useState } from "react";
import { DEFAULT_MEMORY_MAX, getMemory, memoryErrorMessage, putMemory } from "../../lib/stationClient";
import { CAPTAIN_ID, STATIONS } from "../../lib/stationMeta";

export interface StationMemoryPanelProps {
  /** Bumped by the App on every `memory.changed` frame — mirrors VaultPage's liveNonce. */
  memoryLiveNonce: number;
}

/** The six ids the deck already renders: five stations + the Captain. */
const ROSTER: readonly { id: string; name: string }[] = [
  ...STATIONS.map((s) => ({ id: s.id, name: s.name })),
  { id: CAPTAIN_ID, name: "Captain / CEO" },
];

export function StationMemoryPanel({ memoryLiveNonce }: StationMemoryPanelProps) {
  const [agentId, setAgentId] = useState(ROSTER[0].id);
  const [text, setText] = useState("");
  const [max, setMax] = useState(DEFAULT_MEMORY_MAX);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [savedAt, setSavedAt] = useState("");
  const [retryNonce, setRetryNonce] = useState(0);

  // ui-audit MED-2: blank the box the instant the station changes, so the previous
  // station's memory never lingers under the new picker value while the fetch is in
  // flight. Keyed on agentId ONLY — a live re-read must not wipe an in-progress edit.
  useEffect(() => { setText(""); setSaved(false); }, [agentId]);

  // ── read the selected station's memory — on pick, on Retry, and on every live
  // `memory.changed` frame (identity-only; re-read rather than guess who changed it) ──
  useEffect(() => {
    let live = true;
    setLoading(true);
    setLoadError(false);
    setSaveError(null);
    // `saved` is NOT reset here: a save emits memory.changed, and this re-read must not
    // erase the "Saved at" line it just earned (a station change resets it, above).
    getMemory(agentId)
      .then((doc) => {
        if (!live) return;
        if (doc.error) { setLoadError(true); return; }
        setText(doc.memory ?? "");
        if (typeof doc.max === "number" && doc.max > 0) setMax(doc.max);
      })
      .catch(() => { if (live) setLoadError(true); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [agentId, memoryLiveNonce, retryNonce]);

  const overCap = text.length > max;

  const onSave = async () => {
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    try {
      const r = await putMemory(agentId, text);
      if (r.error) { setSaveError(memoryErrorMessage(r.error)); return; }
      const d = new Date();
      setSavedAt(`${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`);
      setSaved(true);
    } catch {
      setSaveError("could not reach the runtime — nothing was saved");
    } finally {
      setSaving(false);
    }
  };

  // Phase G (ADR G-2): the mockup's Station memory card. APP-ONLY: the character count
  // against the server's cap (a save over it would be refused).
  return (
    <div className="card">
      <div className="card-h"><h2>Station memory</h2><span className="sub">what a station always knows</span></div>
      <div className="field">
        <label className="label" htmlFor="vt-st">Station</label>
        <select id="vt-st" value={agentId} onChange={(e) => setAgentId(e.target.value)} disabled={saving}>
          {ROSTER.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </div>
      {loadError ? (
        <div className="empty-note" style={{ marginTop: 10 }}>{"Could not read this station's memory. "}<button type="button" className="linkish" onClick={() => setRetryNonce((n) => n + 1)}>Retry</button></div>
      ) : (
        <>
          <div className="field" style={{ marginTop: 10 }}>
            <label className="label" htmlFor="vt-mem">Memory</label>
            <textarea id="vt-mem" rows={5} className="field-ta" value={text} onChange={(e) => { setText(e.target.value); setSaved(false); }} disabled={loading || saving} aria-describedby="vt-mem-scope" />
            {/* APP-ONLY: the most privileged prompt surface says what it is. */}
            <p className="hint" id="vt-mem-scope" data-app-only="memory-scope" style={{ margin: 0 }}>Injected into this station's system prompt on every wake.</p>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn btn-primary" type="button" onClick={() => void onSave()} disabled={loading || saving || overCap}>{saving ? "Saving…" : "Save memory"}</button>
            <span className="sub" role="status">{saved && !saveError ? `Saved at ${savedAt} · used from the station's next wake` : ""}</span>
            <span className="sub" data-app-only="memory-count" style={overCap ? { color: "var(--bad-ink)" } : undefined}>{loading ? "reading…" : `${text.length} / ${max}`}</span>
          </div>
        </>
      )}
      {saveError && <p className="sub" role="alert" style={{ color: "var(--bad-ink)", margin: "8px 0 0" }}>{saveError}</p>}
    </div>
  );
}
