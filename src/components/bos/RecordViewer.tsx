// B2 — one record, opened. Provenance header (who wrote it, into which venture, when,
// from which run) over the body.
//
// XSS INVARIANT (BLOCKING for B2): the body is AGENT-AUTHORED text. It is parsed into
// typed lines by `parseMdLines` and every line is rendered as a React TEXT NODE. There
// is no innerHTML and no dangerouslySetInnerHTML in this file or anywhere in the Vault
// UI — markup inside a record is DISPLAYED, never executed.
//
// MOTION: none beyond the shared hover-gated button transitions in bos.css.

import { memo } from "react";
import { ArrowLeft } from "lucide-react";
import { parseMdLines, recordDate, nodeLabel, type VaultRecord } from "../../lib/vaultClient";

export interface RecordViewerProps {
  record: VaultRecord;
  onBack: () => void;
}

export const RecordViewer = memo(function RecordViewer({ record, onBack }: RecordViewerProps) {
  const { meta, body } = record;
  const lines = parseMdLines(body);

  return (
    <article className="bos-vault-viewer" aria-labelledby="bos-vault-record-title">
      <button type="button" className="bos-vault-back" onClick={onBack}>
        <ArrowLeft size={13} aria-hidden />
        <span>Back to {nodeLabel(meta.node)}</span>
      </button>

      <header className="bos-vault-prov">
        <h3 id="bos-vault-record-title" className="bos-vault-record-title">{meta.title}</h3>
        <dl className="bos-vault-prov-grid helm-mono">
          <div>
            <dt>AUTHOR</dt>
            <dd>{meta.author}</dd>
          </div>
          <div>
            <dt>VENTURE</dt>
            <dd>{meta.venture}</dd>
          </div>
          <div>
            <dt>WRITTEN</dt>
            <dd>{recordDate(meta.createdAt) || "—"}</dd>
          </div>
          <div>
            <dt>SOURCE RUN</dt>
            <dd>{meta.sourceRun || "—"}</dd>
          </div>
        </dl>
      </header>

      <div className="bos-vault-body">
        {lines.length === 0 ? (
          <p className="bos-vault-note helm-mono">this record has no body</p>
        ) : (
          lines.map((l, i) => {
            // `l.text` is a string interpolated as a child — React escapes it. Each
            // branch below is a plain element with a text child; none of them takes
            // markup, which is what makes an agent-authored body safe to show.
            const key = `${i}-${l.kind}`;
            if (l.kind === "h1") return <h4 key={key} className="bos-vault-md-h1">{l.text}</h4>;
            if (l.kind === "h2") return <h5 key={key} className="bos-vault-md-h2">{l.text}</h5>;
            if (l.kind === "li") return <p key={key} className="bos-vault-md-li">{l.text}</p>;
            if (l.kind === "code") return <pre key={key} className="bos-vault-md-code helm-mono">{l.text}</pre>;
            return <p key={key} className="bos-vault-md-p">{l.text}</p>;
          })
        )}
      </div>
    </article>
  );
});
