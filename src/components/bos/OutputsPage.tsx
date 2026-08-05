// B7 — the Outputs page (nav id `outputs`). The artifact registry: the REAL always-available
// generators the runtime reports (currently the P8 audit export) on top, then the artifacts it
// has actually produced (newest first). Each row is a brass icon well · label · faint meta, and
// a generator/downloadable row carries a mono Download control.
//
// LAZY BY CONSTRUCTION: App imports this with React.lazy, so none of it — the page, its icons,
// the outputs client, the blob-download helper — is in the main index chunk (hard 194,560 B gz
// ceiling). Headroom is thin, so this page adds no new dependency: download is fetch → blob.
//
// HONEST BY CONSTRUCTION: the list is `{ generators, outputs }` from GET /runtime/outputs —
// never a fabricated file list. Empty produced set → the generator + an honest empty note. The
// audit bundle is fetched token-gated (a browser <a download> cannot set x-runtime-token), and a
// failed download surfaces an inline mono error, never a silent no-op.
//
// LIVE: an `output.created` frame triggers the authoritative re-read; `liveNonce` (bumped on
// resync) does too. NO innerHTML — every label/meta is a React text node.

import { useEffect, useMemo, useRef, useState } from "react";
import { FileDown, ScrollText, Boxes } from "lucide-react";
import type { RuntimeEvent } from "../../lib/useRuntimeEvents";
import {
  AUDIT_KIND,
  downloadAudit,
  generatorRow,
  listOutputs,
  outputRow,
  type OutputGenerator,
  type OutputRecord,
  type AuditFormat,
} from "../../lib/outputsClient";
import { BosTopbar } from "./BosTopbar";

export interface OutputsPageProps {
  /** The venture scope from the sidebar switcher; null = all ventures. */
  venture: string | null;
  /** Newest catalog frame from the app-wide SSE subscription. */
  lastEvent: RuntimeEvent | null;
  /** Bumped on every SSE resync — triggers the authoritative re-read. */
  liveNonce: number;
}

/** The brass icon well glyph for a kind — audit gets the scroll, produced artifacts the box. */
function KindIcon({ kind }: { kind: string }) {
  const Glyph = kind === AUDIT_KIND ? ScrollText : Boxes;
  return (
    <span className="bos-out-icon" aria-hidden>
      <Glyph size={15} />
    </span>
  );
}

export function OutputsPage({ venture, lastEvent, liveNonce }: OutputsPageProps) {
  const [gens, setGens] = useState<OutputGenerator[] | null>(null);
  const [rows, setRows] = useState<OutputRecord[] | null>(null);
  const [error, setError] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);

  // Per-generator busy + error, keyed by kind, so one failing download never blanks the page.
  const [busyKind, setBusyKind] = useState<string | null>(null);
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

  async function runDownload(format: AuditFormat) {
    setBusyKind(AUDIT_KIND);
    setDlError(null);
    try {
      await downloadAudit({ format });
      // A produced audit row is recorded server-side → output.created re-reads the list.
    } catch (e) {
      setDlError(e instanceof Error ? e.message : "download failed");
    } finally {
      setBusyKind(null);
    }
  }

  const scopeLabel = (venture ?? "all ventures").toUpperCase();
  const count = (gens?.length ?? 0) + (rows?.length ?? 0);

  const producedList = useMemo(() => rows ?? [], [rows]);

  return (
    <div className="bos-deck bos-outputs">
      <BosTopbar
        eyebrow={`OUTPUTS · ${scopeLabel}`}
        title="Outputs"
        chips={
          gens !== null ? (
            <span className="helm-chip">{count} available</span>
          ) : undefined
        }
      />

      {error ? (
        <p className="bos-wf-note helm-mono">
          outputs unavailable — runtime not reachable{" "}
          <button type="button" className="bos-vault-retry" onClick={() => setRetryNonce((n) => n + 1)}>Retry</button>
        </p>
      ) : gens === null ? (
        <p className="bos-wf-note helm-mono">reading…</p>
      ) : (
        <div className="bos-out-list" role="list" aria-label="Outputs and generators">
          {/* Generators — always-available capabilities. The audit export downloads a real bundle. */}
          {gens.map((g) => {
            const vm = generatorRow(g);
            const busy = busyKind === g.kind;
            return (
              <div key={`gen:${g.kind}`} role="listitem" className="bos-out-row" data-gen="true">
                <KindIcon kind={g.kind} />
                <span className="bos-out-body">
                  <span className="bos-out-name">{vm.label}</span>
                  <span className="bos-out-meta helm-mono">{vm.meta}</span>
                </span>
                {g.kind === AUDIT_KIND ? (
                  <span className="bos-out-actions">
                    <button
                      type="button"
                      className="bos-out-dl"
                      data-busy={busy ? "true" : undefined}
                      disabled={busy}
                      onClick={() => void runDownload("json")}
                    >
                      <FileDown size={13} aria-hidden /> {busy ? "…" : "JSON"}
                    </button>
                    <button
                      type="button"
                      className="bos-out-dl"
                      disabled={busy}
                      onClick={() => void runDownload("csv")}
                    >
                      <FileDown size={13} aria-hidden /> CSV
                    </button>
                  </span>
                ) : null}
              </div>
            );
          })}

          {/* Produced artifacts — real rows only, newest first. */}
          {producedList.map((o) => {
            const vm = outputRow(o);
            const downloadable = typeof o.ref === "string" && o.ref.startsWith("/");
            return (
              <div key={`out:${o.id}`} role="listitem" className="bos-out-row">
                <KindIcon kind={o.kind} />
                <span className="bos-out-body">
                  <span className="bos-out-name">{vm.label}</span>
                  <span className="bos-out-meta helm-mono">{vm.meta}</span>
                </span>
                {downloadable && o.kind === AUDIT_KIND ? (
                  <span className="bos-out-actions">
                    <button type="button" className="bos-out-dl" onClick={() => void runDownload("json")}>
                      <FileDown size={13} aria-hidden /> Download
                    </button>
                  </span>
                ) : null}
              </div>
            );
          })}

          {producedList.length === 0 && (
            <p className="bos-wf-note helm-mono" style={{ marginTop: "6px" }}>
              No exports produced yet — generate an audit bundle above.
            </p>
          )}
        </div>
      )}

      {dlError && <p className="bos-wf-error helm-mono" role="alert">export failed — {dlError}</p>}
    </div>
  );
}
