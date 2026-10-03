// B2 — the Knowledge Vault page (nav id `vault`, master spec §9). Phase G (ADR G-2): the
// approved mockup's `data-page="vault"` — a search field over a `.vsplit`: the memory graph,
// the node tiles and the Files list on the left; the open record and the station memory
// editor on the right. A node (graph or tile) filters the list; a row opens its record.
//
// LAZY BY CONSTRUCTION: App imports this with React.lazy, so none of it is in the main
// index chunk.
//
// EVERY NUMBER IS REAL OR AN ADMITTED GAP:
//   • the chip, every node and tile count come from GET /runtime/vault/stats
//   • the Files list is GET /runtime/vault for the selected node / search
//   • a record opens through GET /runtime/vault/record — bodies are never in the list;
//     the first record of the list opens by default, as the mockup's viewer does
//   • a fetch failure renders a note + Retry; it NEVER renders a fabricated zero
//
// SECURITY: record bodies are agent-authored. They reach the DOM only through
// parseMdLines → React text nodes. No innerHTML anywhere.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getVaultStats,
  listVault,
  getVaultRecord,
  NODE_META,
  parseMdLines,
  recordCountLabel,
  type VaultNode,
  type VaultRecord,
  type VaultRecordMeta,
  type VaultStats,
  getVaultReflect,
  type VaultReflectStatus,
} from "../../lib/vaultClient";
import { stationName } from "../../lib/cadenceClient";
import { agoLabel } from "../../lib/storiesClient";
import { BosTopbar } from "./BosTopbar";
import { StationMemoryPanel } from "./StationMemoryPanel";

export interface VaultPageProps {
  /** The venture scope from the sidebar switcher; null = all ventures. */
  venture: string | null;
  /**
   * Bumped by the App on every `vault.written` frame and on every SSE resync, so the
   * page re-reads authoritative state instead of polling.
   */
  liveNonce: number;
  /** Bumped on every `memory.changed` frame and SSE resync — the memory card re-reads. */
  memoryLiveNonce: number;
}

const SEARCH_DEBOUNCE_MS = 250;
const MIN_QUERY_CHARS = 2;
const RECENT_LIMIT = 20;
/** The graph's node order: decisions at the centre, as the mockup places its first kind. */
const ORDER: readonly VaultNode[] = ["decisions", "ventures", "market", "content", "pipeline", "tech"];
/** The mockup's node positions on its 520×300 canvas; the first is the centre. */
const POS: readonly [number, number][] = [[260, 150], [110, 70], [410, 70], [90, 220], [430, 220], [260, 40]];
// ponytail: radius grows 4px a record as the mockup draws it, capped at 6 so a busy node
// cannot swallow its neighbours; the count inside is always the real number.
const radius = (n: number) => 26 + Math.min(n, 6) * 4;
const two = (n: number) => String(n).padStart(2, "0");
const hhmm = (iso: string) => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? `${two(d.getHours())}:${two(d.getMinutes())}` : "—"; };

export function VaultPage({ venture, liveNonce, memoryLiveNonce }: VaultPageProps) {
  const [stats, setStats] = useState<VaultStats | null>(null);
  const [statsError, setStatsError] = useState(false);
  const [records, setRecords] = useState<VaultRecordMeta[] | null>(null);
  const [listError, setListError] = useState(false);
  const [selected, setSelected] = useState<VaultNode | null>(null);
  const [selId, setSelId] = useState<string | null>(null);
  const [open, setOpen] = useState<VaultRecord | null>(null);
  const [openError, setOpenError] = useState(false);
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  const [retryNonce, setRetryNonce] = useState(0);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // ── search debounce (250ms, ≥2 chars) ─────────────────────────────────────
  useEffect(() => {
    const next = search.trim();
    if (next.length > 0 && next.length < MIN_QUERY_CHARS) { setTerm(""); return; }
    const id = setTimeout(() => setTerm(next), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [search]);

  // ── stats (scope-aware) ───────────────────────────────────────────────────
  useEffect(() => {
    let live = true;
    setStatsError(false);
    getVaultStats(venture)
      .then((s) => { if (live) setStats(s); })
      .catch(() => { if (live) { setStats(null); setStatsError(true); } });
    return () => { live = false; };
  }, [venture, liveNonce, retryNonce]);

  // ── MUNDER-ADOPTION A4 — condenser status (a vault.condensed frame bumps liveNonce).
  const [reflect, setReflect] = useState<VaultReflectStatus | null>(null);
  useEffect(() => {
    let live = true;
    getVaultReflect()
      .then((r) => { if (live) setReflect(r); })
      .catch(() => { if (live) setReflect(null); });
    return () => { live = false; };
  }, [liveNonce, retryNonce]);

  // ── the record list for the current node / search / scope ─────────────────
  // A live re-read (vault.written, resync, Retry) keeps the list on screen until the new one
  // lands, so the open record does not blank; a new scope, node or search starts from empty.
  const listKey = `${venture}|${selected}|${term}`;
  const lastListKey = useRef(listKey);
  useEffect(() => {
    let live = true;
    setListError(false);
    if (lastListKey.current !== listKey) { lastListKey.current = listKey; setRecords(null); }
    listVault({ venture, node: selected, q: term || undefined, limit: selected === null && !term ? RECENT_LIMIT : undefined })
      .then((r) => { if (live) setRecords(r.records ?? []); })
      .catch(() => { if (live) { setRecords(null); setListError(true); } });
    return () => { live = false; };
  }, [venture, selected, term, listKey, liveNonce, retryNonce]);

  // The record on screen always belongs to the list behind it: the picked row while it is
  // in the list, else the list's first record (the mockup's viewer opens one by default).
  const shownId = records?.some((r) => r.id === selId) ? selId : records?.[0]?.id ?? null;
  const openRecord = useCallback((id: string, live: () => boolean) => {
    setOpenError(false);
    getVaultRecord(id)
      .then((r) => { if (!live()) return; if (r && r.meta) setOpen(r); else { setOpen(null); setOpenError(true); } })
      .catch(() => { if (live()) { setOpen(null); setOpenError(true); } });
  }, []);
  useEffect(() => {
    if (shownId === null) { setOpen(null); setOpenError(false); return; }
    let live = true;
    openRecord(shownId, () => live);
    return () => { live = false; };
  }, [shownId, openRecord]);

  // Esc clears the search box (and keeps focus in it).
  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    setSearch("");
    searchRef.current?.focus();
  };

  // Until the stats answer (or when they fail) every count is "—", never a made-up zero.
  const total = stats?.total ?? 0;
  const count = (n: VaultNode) => (stats === null ? "—" : String(stats.byNode?.[n] ?? 0));
  const toggle = (n: VaultNode) => setSelected((s) => (s === n ? null : n));
  const condensed = reflect?.last?.results ?? [];
  const okLanes = condensed.filter((r) => !r.aborted).length;

  return (
    <section className="page" aria-labelledby="h-vault">
      <BosTopbar
        eyebrow={`Knowledge vault · ${venture ?? "All ventures"}`}
        title="The log"
        tagline="what the team remembers"
        headingId="h-vault"
        clock
        chips={
          <>
            <span className="chip">{stats === null ? "—" : recordCountLabel(total)}</span>
            {/* MUNDER-ADOPTION A4 — condensation state, once the status route answered. */}
            {condensed.length > 0 && (
              <span
                className={condensed.some((r) => r.aborted) ? "chip warn" : "chip ok"}
                data-app-only="condensed"
                title={condensed.map((r) => (r.aborted ? `${r.venture}/${r.node}: ABORTED — ${r.reason}` : `${r.venture}/${r.node}: ${r.evicted} evicted`)).join(" · ")}
              >
                {`condensed ${okLanes} lane${okLanes === 1 ? "" : "s"}${condensed.some((r) => r.aborted) ? " · 1+ aborted" : ""}`}
              </span>
            )}
          </>
        }
      />
      <div className="field" style={{ maxWidth: 560, marginBottom: 16 }}>
        <label className="label" htmlFor="vt-q">Search the log</label>
        <input id="vt-q" ref={searchRef} type="search" placeholder="footer, theme, copy tone…" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={onSearchKeyDown} />
        {search.trim().length > 0 && search.trim().length < MIN_QUERY_CHARS && (
          <span className="hint" data-app-only="search-hint">{`Keep typing: ${MIN_QUERY_CHARS} characters minimum.`}</span>
        )}
      </div>
      {statsError && (
        <div className="empty-note" style={{ marginBottom: 16 }}><span className="script">Not reachable.</span><br />{"The vault did not answer. "}<button type="button" className="linkish" onClick={() => setRetryNonce((n) => n + 1)}>Retry</button></div>
      )}
      <div className="vsplit">
        <div className="stack">
          <div className="card graph">
            <div className="card-h"><h2>Memory graph</h2><span className="sub">click a node to filter</span></div>
            <svg viewBox="0 0 520 300" role="group" aria-label="Memory graph, six record kinds">
              {ORDER.map((n, i) => (
                <line key={n} x1="260" y1="150" x2={POS[i][0]} y2={POS[i][1]} stroke="currentColor" strokeOpacity=".25" style={{ color: "var(--brand)" }} />
              ))}
              {ORDER.map((n, i) => {
                const c = stats?.byNode?.[n] ?? 0;
                const r = radius(c);
                return (
                  <g key={n} className="node" role="button" tabIndex={0} aria-pressed={selected === n} aria-label={`${NODE_META[n].label}, ${count(n)} records`}
                    transform={`translate(${POS[i][0]},${POS[i][1]})`} onClick={() => toggle(n)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(n); } }}>
                    <circle r={r} />
                    <text className="n" y="6">{count(n)}</text>
                    <text y={r + 16}>{NODE_META[n].label}</text>
                  </g>
                );
              })}
            </svg>
          </div>
          <div className="ntiles">
            {ORDER.map((n) => (
              <button key={n} type="button" aria-pressed={selected === n} onClick={() => toggle(n)}><b>{count(n)}</b><span className="sub">{NODE_META[n].label}</span></button>
            ))}
          </div>
          <div className="card">
            <div className="card-h"><h2>Files</h2><span className="sub">{`${records?.length ?? "—"} of ${stats === null ? "—" : total}${selected ? ` · ${selected}` : ""}${term ? ` · “${term}”` : ""}`}</span></div>
            <ul className="list">
              {listError ? (
                <li className="empty-note">{"The vault did not answer. "}<button type="button" className="linkish" onClick={() => setRetryNonce((n) => n + 1)}>Retry</button></li>
              ) : records === null ? (
                <li className="empty-note" role="status">Reading the log…</li>
              ) : records.length === 0 ? (
                <li className="empty-note">{term || selected ? "No record matches. Try another word or clear the node filter." : "No records yet. Stations write here as they finish work."}</li>
              ) : records.map((r) => (
                <li key={r.id}>
                  <button className="row-btn" type="button" aria-pressed={r.id === shownId} onClick={() => setSelId(r.id)}>
                    <span className="chip">{r.node}</span>
                    <span><b>{r.title}</b><span className="sub" style={{ display: "block" }}>{`${stationName(r.author)} · ${agoLabel(Date.parse(r.createdAt))}`}</span></span>
                    <span className="sub">open</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="stack">
          <div className="card" aria-live="polite">
            {open ? (
              <>
                <div className="card-h"><div><p className="sub" style={{ margin: 0 }}>{`${open.meta.node} · vault/${open.meta.venture}/${open.meta.node}/${open.meta.id}.md`}</p><h2 style={{ fontSize: "1.5rem", marginTop: 4 }}>{open.meta.title}</h2></div></div>
                {parseMdLines(open.body).map((l, i) => {
                  // Agent-authored text, rendered as React text nodes only.
                  const key = `${i}-${l.kind}`;
                  if (l.kind === "code") return <pre key={key} className="mono" style={{ margin: "0 0 12px", whiteSpace: "pre-wrap" }}>{l.text}</pre>;
                  if (l.kind === "h1" || l.kind === "h2") return <p key={key} style={{ margin: "0 0 12px" }}><b>{l.text}</b></p>;
                  return <p key={key} style={{ margin: "0 0 12px" }}>{l.kind === "li" ? `• ${l.text}` : l.text}</p>;
                })}
                <span className="sub">{`Filed by ${stationName(open.meta.author)} · ${hhmm(open.meta.createdAt)}`}</span>
              </>
            ) : openError ? (
              <div className="empty-note">That record could not be opened.</div>
            ) : (
              <div className="empty-note">{records && records.length === 0 ? "Nothing to open yet." : "Pick a record."}</div>
            )}
          </div>
          <StationMemoryPanel memoryLiveNonce={memoryLiveNonce} />
        </div>
      </div>
    </section>
  );
}
