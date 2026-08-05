import { useCallback, useEffect, useState } from "react";
import { ShieldAlert, Loader2, Plus, X } from "lucide-react";
import { tok } from "../../lib/agentMeta";
import { PermissionGate } from "../PermissionGate";
import {
  getPolicy,
  putPolicy,
  setBand,
  addDeny,
  removeDeny,
  BEHAVIOR_OPTIONS,
  BEHAVIOR_LABEL,
  type PolicyBands,
} from "../../lib/inboxClient";

/*
  P6 / ADR-053 — the BOSS-editable risk policy.

  Per-band behaviour dropdowns + an always-human deny-list editor. The server is the
  authority: it schema-validates every save and, if the stored file is ever corrupt,
  falls back to all-human (surfaced here as a warning). The save is F3-gated — auto-
  approving code is consequential, so the operator confirms through the PermissionGate
  before it takes effect (and it reloads live, no restart).
*/

const BANDS: (keyof PolicyBands)[] = ["low", "medium", "high"];
const BAND_LABEL: Record<keyof PolicyBands, string> = { low: "Low risk", medium: "Medium risk", high: "High risk" };

export function PolicyEditor() {
  const [bands, setBands] = useState<PolicyBands | null>(null);
  const [deny, setDeny] = useState<string[]>([]);
  const [valid, setValid] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gateOpen, setGateOpen] = useState(false);
  const [newGlob, setNewGlob] = useState("");

  const load = useCallback(() => {
    getPolicy()
      .then((p) => { setBands(p.bands); setDeny(p.denyList ?? []); setValid(p.valid); setDirty(false); setError(null); })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "could not read the policy"));
  }, []);
  useEffect(() => { load(); }, [load]);

  const mutateBand = <K extends keyof PolicyBands>(band: K, value: PolicyBands[K]) => {
    if (!bands) return;
    setBands(setBand(bands, band, value));
    setDirty(true);
  };
  const addGlob = () => { const next = addDeny(deny, newGlob); if (next.length !== deny.length) { setDeny(next); setDirty(true); } setNewGlob(""); };
  const dropGlob = (g: string) => { setDeny(removeDeny(deny, g)); setDirty(true); };

  const doSave = async () => {
    if (!bands) return;
    setGateOpen(false);
    setBusy(true);
    setError(null);
    try {
      const r = await putPolicy({ bands, denyList: deny });
      if (r.error) { setError(r.error); return; }
      if (r.bands) setBands(r.bands);
      if (r.denyList) setDeny(r.denyList);
      if (typeof r.valid === "boolean") setValid(r.valid);
      setDirty(false);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "save failed");
    } finally {
      setBusy(false);
    }
  };

  const inputStyle = { backgroundColor: tok("panel-2"), color: tok("text"), border: `1px solid ${tok("border")}` };

  return (
    <section className="border-t border-border/50 py-4">
      <div className="mb-3 flex items-center gap-2">
        <span style={{ color: tok("accent-cyan") }}><ShieldAlert size={15} aria-hidden /></span>
        <h3 className="text-sm font-semibold tracking-tight">Risk policy</h3>
      </div>
      <p className="mb-3 text-[12px] text-muted">
        Per-band routing for the anti-approval-fatigue engine. Auto-approve is deny-by-default; the
        deny-list forces a human regardless of band, and high risk can never auto-apply.
      </p>

      {!bands ? (
        <p className="text-[12px] text-muted" role="status">{error ?? "Reading the policy…"}</p>
      ) : (
        <div className="flex flex-col gap-3">
          {!valid && (
            <p className="rounded-md px-3 py-2 text-[11px]" role="alert" style={{ color: tok("stale-red"), border: `1px solid ${tok("stale-red")}` }}>
              The stored policy file was unreadable — the runtime is running in the safest all-human mode. Saving here repairs it.
            </p>
          )}

          {BANDS.map((band) => (
            <label key={band} className="flex items-center justify-between gap-4">
              <span className="text-[13px] text-text">{BAND_LABEL[band]}</span>
              <select
                className="rounded-md px-2.5 py-1.5 font-mono text-[11px] outline-none focus-visible:ring-2"
                style={inputStyle}
                aria-label={`${BAND_LABEL[band]} behaviour`}
                value={bands[band]}
                onChange={(e) => mutateBand(band, e.target.value as PolicyBands[typeof band])}
              >
                {(BEHAVIOR_OPTIONS[band] as string[]).map((opt) => (
                  <option key={opt} value={opt}>{BEHAVIOR_LABEL[opt] ?? opt}</option>
                ))}
              </select>
            </label>
          ))}

          <div className="flex flex-col gap-1.5">
            <span className="text-[11px]" style={{ color: tok("muted") }}>Always-human deny-list (path globs)</span>
            <div className="flex flex-wrap gap-1.5" role="list" aria-label="Deny-list globs">
              {deny.length === 0 && <span className="text-[11px]" style={{ color: tok("muted") }}>None — using nothing but the band rules.</span>}
              {deny.map((g) => (
                <span key={g} role="listitem" className="flex items-center gap-1 rounded-md px-2 py-1 font-mono text-[11px]" style={{ backgroundColor: tok("panel-2"), border: `1px solid ${tok("border")}` }}>
                  {g}
                  <button type="button" aria-label={`Remove ${g}`} onClick={() => dropGlob(g)} className="outline-none focus-visible:ring-2" style={{ color: tok("muted") }}>
                    <X size={11} aria-hidden />
                  </button>
                </span>
              ))}
            </div>
            <div className="flex gap-1.5">
              <input
                className="flex-1 rounded-md px-2.5 py-1.5 font-mono text-[11px] outline-none focus-visible:ring-2"
                style={inputStyle}
                placeholder="**/secrets/**"
                aria-label="New deny-list glob"
                value={newGlob}
                onChange={(e) => setNewGlob(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addGlob(); } }}
              />
              <button type="button" onClick={addGlob} disabled={!newGlob.trim()} className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-[11px] outline-none focus-visible:ring-2 disabled:opacity-40" style={{ color: tok("accent-cyan"), border: `1px solid color-mix(in oklch, ${tok("accent-cyan")} 30%, transparent)` }}>
                <Plus size={12} aria-hidden /> Add
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setGateOpen(true)}
              disabled={busy || !dirty}
              className="flex items-center gap-2 rounded-md px-3 py-1.5 text-[12px] outline-none transition-colors focus-visible:ring-2 disabled:opacity-40"
              style={{ backgroundColor: `color-mix(in oklch, ${tok("accent-cyan")} 14%, transparent)`, color: tok("accent-cyan"), border: `1px solid color-mix(in oklch, ${tok("accent-cyan")} 30%, transparent)` }}
            >
              {busy ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <ShieldAlert size={13} aria-hidden />}
              {busy ? "Saving…" : "Save policy"}
            </button>
            {error && <p className="text-[11px]" style={{ color: tok("stale-red") }} role="alert">{error}</p>}
          </div>
        </div>
      )}

      <PermissionGate
        open={gateOpen}
        title="Save risk policy"
        summary={
          bands && bands.low === "auto_approve"
            ? "Low-risk deliveries will AUTO-APPLY through the broker without you. The deny-list and high-risk typed confirm still hold."
            : "Update the per-band routing and deny-list. No band is set to auto-apply."
        }
        affected={[]}
        confirmLabel="Save policy"
        accent="blocked-amber"
        onConfirm={() => void doSave()}
        onCancel={() => setGateOpen(false)}
      />
    </section>
  );
}
