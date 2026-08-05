// B2 — the Knowledge Vault page (nav id `vault`, master spec §9).
//
// LAZY BY CONSTRUCTION: App imports this with React.lazy, so none of it — the page,
// the graph, the viewer, its icons — is in the main index chunk. The main index has a
// hard 194,560 B gz ceiling; the vault must not spend it.
//
// EVERY NUMBER IS REAL OR AN ADMITTED GAP:
//   • the chip, the graph centre and every node count come from GET /runtime/vault/stats
//   • the FILES list is GET /runtime/vault for the selected node
//   • a record opens through GET /runtime/vault/record — bodies are never in the list
//   • a fetch failure renders a faint mono note + Retry (the PolicyEditor pattern);
//     it NEVER renders a fabricated zero
//
// SECURITY: record bodies are agent-authored. They reach the DOM only through
// RecordViewer → parseMdLines → React text nodes. No innerHTML anywhere.
//
// MOTION: the only animated properties are colour/background/border (140ms) plus the
// single hover-gated transform on a file row (240ms) — both defined in bos.css inside
// `@media (hover:hover)`, and both stripped by the global reduced-motion net.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getVaultStats,
  listVault,
  getVaultRecord,
  nodeLabel,
  NODE_META,
  recordCountLabel,
  recordDate,
  type VaultNode,
  type VaultRecord,
  type VaultRecordMeta,
  type VaultStats,
} from "../../lib/vaultClient";
import { BosTopbar } from "./BosTopbar";
import { MemoryGraph } from "./MemoryGraph";
import { RecordViewer } from "./RecordViewer";
import { StationMemoryPanel } from "./StationMemoryPanel";

export interface VaultPageProps {
  /** The venture scope from the sidebar switcher; null = all ventures. */
  venture: string | null;
  /**
   * Bumped by the App on every `vault.written` frame and on every SSE resync, so the
   * page re-reads authoritative state instead of polling. A record written by another
   * station appears here without a refresh.
   */
  liveNonce: number;
  /**
   * CC-Primitives P6 — bumped by the App on every `memory.changed` frame and on every
   * SSE resync (mirrors `liveNonce`/`vault.written` above). The station memory panel
   * re-reads the selected station's memory instead of polling.
   */
  memoryLiveNonce: number;
}

const SEARCH_DEBOUNCE_MS = 250;
const MIN_QUERY_CHARS = 2;
const RECENT_LIMIT = 20;

const ZERO_BY_NODE: Record<VaultNode, number> = {
  ventures: 0, market: 0, content: 0, pipeline: 0, tech: 0, decisions: 0,
};

export function VaultPage({ venture, liveNonce, memoryLiveNonce }: VaultPageProps) {
  const [stats, setStats] = useState<VaultStats | null>(null);
  const [statsError, setStatsError] = useState(false);
  const [records, setRecords] = useState<VaultRecordMeta[] | null>(null);
  const [listError, setListError] = useState(false);
  const [selected, setSelected] = useState<VaultNode | null>(null);
  const [open, setOpen] = useState<VaultRecord | null>(null);
  const [openError, setOpenError] = useState(false);
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  // Bumped by the Retry button — a manual re-read without reloading the page.
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

  // ── the record list for the current node / search / scope ─────────────────
  useEffect(() => {
    let live = true;
    setListError(false);
    setRecords(null);
    listVault({
      venture,
      // The centre means "recent across every node", so no node filter is sent.
      node: selected,
      q: term || undefined,
      limit: selected === null && !term ? RECENT_LIMIT : undefined,
    })
      .then((r) => { if (live) setRecords(r.records ?? []); })
      .catch(() => { if (live) { setRecords(null); setListError(true); } });
    return () => { live = false; };
  }, [venture, selected, term, liveNonce, retryNonce]);

  // Changing scope, node or search closes an open record: the record on screen must
  // always belong to the list behind it.
  useEffect(() => { setOpen(null); setOpenError(false); }, [venture, selected, term]);

  const openRecord = useCallback((id: string) => {
    setOpenError(false);
    getVaultRecord(id)
      .then((r) => { if (r && r.meta) setOpen(r); else setOpenError(true); })
      .catch(() => setOpenError(true));
  }, []);

  // Esc clears the search box (and returns focus to it) — the one keyboard affordance
  // the search field owns.
  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    setSearch("");
    searchRef.current?.focus();
  };

  const byNode = stats?.byNode ?? ZERO_BY_NODE;
  const total = stats?.total ?? 0;
  const scopeLabel = (venture ?? "all ventures").toUpperCase();
  const crumbNode = selected ? nodeLabel(selected) : "recent";
  const blurb = selected ? NODE_META[selected].blurb : "The twenty most recent records across every node.";

  const tiles = useMemo(
    () => (Object.keys(NODE_META) as VaultNode[]).map((n) => ({ node: n, count: byNode[n] ?? 0 })),
    [byNode],
  );

  return (
    <div className="bos-deck bos-vault">
      <BosTopbar
        eyebrow={`SHARED MEMORY · ${scopeLabel}`}
        title="The log"
        chips={
          <span className="helm-chip" data-tone={total > 0 ? "green" : "muted"}>
            ● {statsError ? "—" : recordCountLabel(total)}
          </span>
        }
      />

      <div className="bos-vault-search-row">
        <input
          ref={searchRef}
          type="search"
          className="helm-input bos-vault-search"
          placeholder="Search titles and excerpts…"
          aria-label="Search the vault by title and excerpt"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={onSearchKeyDown}
        />
        {search.trim().length > 0 && search.trim().length < MIN_QUERY_CHARS && (
          <span className="bos-vault-note helm-mono">keep typing — {MIN_QUERY_CHARS} characters minimum</span>
        )}
        {statsError && (
          <span className="bos-vault-note helm-mono">
            vault unavailable — runtime not reachable{" "}
            <button type="button" className="bos-vault-retry" onClick={() => setRetryNonce((n) => n + 1)}>
              Retry
            </button>
          </span>
        )}
      </div>

      <div className="bos-vault-split">
        <section className="bos-vault-graph-pane" aria-label="Memory graph">
          <MemoryGraph byNode={byNode} total={total} selected={selected} onSelect={setSelected} />
        </section>

        <section className="bos-vault-detail" aria-label="Records">
          <p className="bos-vault-crumb helm-mono">
            The log <span aria-hidden>/</span> <span className="bos-vault-crumb-node">{crumbNode}</span>
            {term && <> <span aria-hidden>/</span> <span className="bos-vault-crumb-node">“{term}”</span></>}
          </p>

          {open ? (
            <RecordViewer record={open} onBack={() => setOpen(null)} />
          ) : (
            <>
              <p className="bos-vault-blurb">{term ? `Matches for “${term}”.` : blurb}</p>

              {!term && (
                <div className="bos-vault-tiles">
                  {tiles.map((t) => (
                    <button
                      key={t.node}
                      type="button"
                      className="bos-vault-tile"
                      aria-pressed={selected === t.node}
                      data-selected={selected === t.node ? "true" : undefined}
                      onClick={() => setSelected(selected === t.node ? null : t.node)}
                    >
                      <span className="bos-vault-tile-value helm-mono">{statsError ? "—" : t.count}</span>
                      <span className="bos-vault-tile-label helm-mono">{NODE_META[t.node].label.toUpperCase()}</span>
                    </button>
                  ))}
                </div>
              )}

              <div className="bos-vault-files">
                <p className="bos-vault-files-head helm-mono">FILES</p>
                {listError ? (
                  <p className="bos-vault-note helm-mono">
                    could not read the vault{" "}
                    <button type="button" className="bos-vault-retry" onClick={() => setRetryNonce((n) => n + 1)}>
                      Retry
                    </button>
                  </p>
                ) : records === null ? (
                  <p className="bos-vault-note helm-mono">reading…</p>
                ) : records.length === 0 ? (
                  <p className="bos-vault-note helm-mono">
                    {term
                      ? `nothing matches “${term}”`
                      : selected
                        ? `no ${nodeLabel(selected).toLowerCase()} records yet — stations write here as they finish work`
                        : "no records yet — stations write here as they finish work"}
                  </p>
                ) : (
                  <ul className="bos-vault-list">
                    {records.map((r) => (
                      <li key={r.id}>
                        <button type="button" className="bos-vault-file" onClick={() => openRecord(r.id)}>
                          <span className="bos-vault-file-title">{r.title}</span>
                          <span className="bos-vault-file-meta helm-mono">
                            {nodeLabel(r.node)} · {r.author} · {recordDate(r.createdAt)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {openError && <p className="bos-vault-note helm-mono">that record could not be opened</p>}
              </div>
            </>
          )}
        </section>
      </div>

      <StationMemoryPanel memoryLiveNonce={memoryLiveNonce} />
    </div>
  );
}
