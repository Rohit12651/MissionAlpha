// B7 — the Outputs page (nav id `outputs`). Phase G (ADR G-2): the approved mockup's
// `data-page="outputs"` — a `.grid2` of the Artifacts card (what the runtime has produced,
// newest first) and the Audit bundle card (JSON / CSV, the file it downloads, Download).
//
// LAZY BY CONSTRUCTION: App imports this with React.lazy, so none of it — the page, the
// outputs client, the blob-download helper — is in the main index chunk.
//
// D-7, HONEST BY CONSTRUCTION: rows are `outputs` from GET /runtime/outputs, never a made-up
// file list. A produced record carries no station and no size, so both read "—" in the
// mockup's shape. The bundle box shows the bundle's real SHAPE, not a preview: fetching the
// export records an artifact server-side (agent-runtime/server.mjs, P8 export), so a preview
// on page open would put a download nobody made into the registry. The file name is the one
// the server sends (`mission-audit-<UTC day>.<format>`). A failed download says so inline.
//
// LIVE: an `output.created` frame triggers the authoritative re-read; `liveNonce` (bumped on
// resync) does too. NO innerHTML — every label is a React text node.

import { useEffect, useRef, useState } from "react";
import type { RuntimeEvent } from "../../lib/useRuntimeEvents";
import { AUDIT_KIND, downloadAudit, listOutputs, type AuditFormat, type OutputGenerator, type OutputRecord } from "../../lib/outputsClient";
import { agoLabel } from "../../lib/storiesClient";
import { BosTopbar } from "./BosTopbar";

export interface OutputsPageProps {
  /** The venture scope from the sidebar switcher; null = all ventures. */
  venture: string | null;
  /** Newest catalog frame from the app-wide SSE subscription. */
  lastEvent: RuntimeEvent | null;
  /** Bumped on every SSE resync — triggers the authoritative re-read. */
  liveNonce: number;
}

/** What the export holds, section by section — mirrors the P8 export in agent-runtime/server.mjs. */
const BUNDLE_SHAPE: Record<AuditFormat, string> = {
  json: `// the bundle's shape; the runtime fills it on download
{
  "meta": { "generatedAt", "from", "to", "format": "json" },
  "deliveries": [{
    "id", "agentId", "source", "kind",
    "riskBand", "riskScore", "riskReasons",
    "status", "decidedBy", "decidedAt",
    "mode", "prUrl", "createdAt", "title"
  }],
  "decisions": [{ "id", "status", "decidedBy", "decidedAt", "feedback" }],
  "auditLog": [{ "at", "event", "data" }],
  "usage": {
    "rows": [{ "agentId", "threadId", "tier", "day", "inputTokens",
               "outputTokens", "turns", "contextPct", "estimated" }],
    "totals": { "inputTokens", "outputTokens", "turns", "byTier" }
  }
}`,
  csv: `# the bundle's sections; the runtime fills them on download
DELIVERIES
id,agentId,source,kind,riskBand,riskScore,riskReasons,status,decidedBy,decidedAt,mode,prUrl,createdAt,title

AUDIT_LOG
at,event,data

USAGE
agentId,threadId,tier,day,inputTokens,outputTokens,turns,contextPct

USAGE_TOTALS
scope,inputTokens,outputTokens,turns
all,…
tier:<tier>,…
`,
};

export function OutputsPage({ venture, lastEvent, liveNonce }: OutputsPageProps) {
  const [gens, setGens] = useState<OutputGenerator[] | null>(null);
  const [rows, setRows] = useState<OutputRecord[] | null>(null);
  const [error, setError] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const [fmt, setFmt] = useState<AuditFormat>("json");
  const [busy, setBusy] = useState(false);
  const [dlError, setDlError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setError(false);
    listOutputs(venture)
      .then((r) => { if (live) { setGens(r.generators ?? []); setRows(r.outputs ?? []); } })
      .catch(() => { if (live) { setGens(null); setRows(null); setError(true); } });
    return () => { live = false; };
  }, [venture, liveNonce, retryNonce]);

  // ── live tail: an output.created triggers the authoritative re-read ─────────
  const lastEventRef = useRef<RuntimeEvent | null>(null);
  useEffect(() => {
    if (!lastEvent || lastEvent === lastEventRef.current) return;
    lastEventRef.current = lastEvent;
    if (lastEvent.name === "output.created") setRetryNonce((n) => n + 1);
  }, [lastEvent]);

  async function runDownload() {
    setBusy(true);
    setDlError(null);
    try {
      await downloadAudit({ format: fmt });
      // The server records the bundle → output.created re-reads the list.
    } catch (e) {
      setDlError(e instanceof Error ? e.message : "download failed");
    } finally {
      setBusy(false);
    }
  }

  // The audit export is the one generator the runtime reports; without it there is no bundle card.
  const hasAudit = gens?.some((g) => g.kind === AUDIT_KIND) ?? false;

  return (
    <section className="page" aria-labelledby="h-outputs">
      <BosTopbar eyebrow={`Outputs · ${venture ?? "All ventures"}`} title="Outputs" tagline="what the team made" headingId="h-outputs" clock />
      {error ? (
        <div className="empty-note"><span className="script">Not reachable.</span><br />{"The runtime did not answer. "}<button type="button" className="linkish" onClick={() => setRetryNonce((n) => n + 1)}>Retry</button></div>
      ) : rows === null ? (
        <div className="empty-note" role="status">Reading the outputs…</div>
      ) : (
        <div className="grid2">
          <div className="card">
            <div className="card-h"><h2>Artifacts</h2><span className="sub">{`${rows.length} artifacts`}</span></div>
            <ul className="list">
              {rows.length === 0 ? (
                <li className="empty-note"><span className="script">Nothing yet.</span><br />Download an audit bundle to make the first.</li>
              ) : rows.map((o) => (
                <li key={o.id} className="row-btn" style={{ cursor: "default" }}>
                  <span className="well" style={{ width: 34, height: 34, border: "1px solid var(--hair)", borderRadius: 8, display: "grid", placeItems: "center", color: "var(--brand)" }}>
                    <svg width="18" height="18" aria-hidden="true"><use href="#i-outputs" /></svg>
                  </span>
                  <span>
                    <b className="mono" style={{ fontSize: ".8125rem", overflowWrap: "anywhere" }}>{o.label}</b>
                    <span className="sub" style={{ display: "block" }}>{`${o.kind} · — · ${agoLabel(o.createdAt)}`}</span>
                  </span>
                  <span className="sub" title="The runtime does not record a size">—</span>
                </li>
              ))}
            </ul>
          </div>
          {hasAudit && (
            <div className="card">
              <div className="card-h">
                <h2>Audit bundle</h2>
                <div className="seg" aria-label="Format">
                  {(["json", "csv"] as const).map((f) => (
                    <button key={f} type="button" aria-pressed={fmt === f} onClick={() => setFmt(f)}>{f.toUpperCase()}</button>
                  ))}
                </div>
              </div>
              <div className="diff" style={{ marginTop: 0 }}>
                <div className="diff-h">
                  <span className="mono">{`mission-audit-${new Date().toISOString().slice(0, 10)}.${fmt}`}</span>
                  <button className="btn btn-primary" type="button" style={{ minHeight: 34, padding: "6px 14px" }} disabled={busy} onClick={() => void runDownload()}>
                    {busy ? "Downloading…" : "Download"}
                  </button>
                </div>
                <pre>{BUNDLE_SHAPE[fmt]}</pre>
              </div>
              {dlError && <p className="sub" role="alert" style={{ color: "var(--bad-ink)", margin: "8px 0 0" }}>{`The export failed: ${dlError}`}</p>}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
