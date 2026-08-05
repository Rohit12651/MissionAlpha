import { useEffect, useMemo, useState } from "react";
import { Search, Check, Loader2 } from "lucide-react";
import { tok } from "../../lib/agentMeta";
import { loadCatalog, loadedCatalog, type MissionSkill } from "../../lib/skillsCatalog";
import { type AttachSkill } from "../../lib/skillAttach";

type Candidate = AttachSkill & { source: string };

// Windowing: the picker renders at most this many rows at a time (headers included). No
// virtualization library — the catalog is grouped by source, so a slice plus a "showing N
// of M" footer keeps the DOM small and the list at 60fps across a ~3,000-entry roster.
const ROW_CAP = 60;

type Row =
  | { type: "header"; source: string; count: number }
  | { type: "item"; skill: Candidate };

/** Pure: filter → group by source → flatten to render rows. */
function buildRows(all: readonly Candidate[], q: string): { rows: Row[]; matched: number; sources: number } {
  const n = q.trim().toLowerCase();
  const hit = n
    ? all.filter((s) =>
        s.id.toLowerCase().includes(n) || s.title.toLowerCase().includes(n) ||
        s.hint.toLowerCase().includes(n) || s.family.toLowerCase().includes(n) ||
        s.source.toLowerCase().includes(n))
    : all;
  const bySource = new Map<string, Candidate[]>();
  for (const s of hit) {
    const arr = bySource.get(s.source);
    if (arr) arr.push(s);
    else bySource.set(s.source, [s]);
  }
  const rows: Row[] = [];
  for (const source of [...bySource.keys()].sort()) {
    const items = bySource.get(source)!;
    rows.push({ type: "header", source, count: items.length });
    for (const skill of items) rows.push({ type: "item", skill });
  }
  return { rows, matched: hit.length, sources: bySource.size };
}

const toCandidate = (s: MissionSkill): Candidate => ({
  id: s.id, title: s.title, hint: s.hint, family: s.family, prompt: s.prompt, source: s.source,
});

// SkillPicker — searchable, source-grouped, window-capped list over the full skill catalog.
// Selecting attaches a skill's prompt to the agent persona (handled by the caller via
// buildAttachSuffix). Capability (the governed factory skills) is a SEPARATE control —
// this only primes behavior. The catalog loads lazily on mount (its own chunk).
export function SkillPicker({
  selected,
  onToggle,
}: {
  selected: Set<string>;
  onToggle: (id: string) => void;
}) {
  const [all, setAll] = useState<readonly Candidate[]>(() => (loadedCatalog()?.MISSION_SKILLS ?? []).map(toCandidate));
  const [q, setQ] = useState("");
  const violet = tok("factory-violet");

  useEffect(() => {
    if (all.length) return;
    let live = true;
    void loadCatalog().then((c) => { if (live) setAll(c.MISSION_SKILLS.map(toCandidate)); });
    return () => { live = false; };
  }, [all.length]);

  const { rows, matched, sources } = useMemo(() => buildRows(all, q), [all, q]);
  const shown = rows.slice(0, ROW_CAP);
  const loading = all.length === 0;

  return (
    <div className="overflow-hidden rounded-md border" style={{ borderColor: tok("border") }}>
      <div className="flex items-center gap-2 px-2.5 py-1.5" style={{ backgroundColor: tok("panel-2"), borderBottom: `0.5px solid ${tok("border")}` }}>
        <Search size={13} aria-hidden style={{ color: tok("muted") }} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          disabled={loading}
          placeholder={loading ? "Loading catalog…" : `Search ${all.length} skills to attach…`}
          aria-label="Search skills to attach"
          className="min-w-0 flex-1 bg-transparent text-[11px] outline-none disabled:opacity-50"
          style={{ color: tok("text") }}
        />
        <span className="shrink-0 text-[9px] tabular-nums" style={{ color: tok("muted") }} role="status" aria-live="polite">
          {loading ? "…" : `${matched} of ${all.length} · ${sources} src · ${selected.size} attached`}
        </span>
      </div>
      <div className="max-h-[240px] overflow-y-auto">
        {loading ? (
          <p className="flex items-center justify-center gap-1.5 px-3 py-4 text-[10px]" style={{ color: tok("muted") }}>
            <Loader2 size={11} className="animate-spin motion-reduce:hidden" aria-hidden /> loading catalog…
          </p>
        ) : shown.length === 0 ? (
          <p className="px-3 py-4 text-center text-[10px]" style={{ color: tok("muted") }}>No skills match.</p>
        ) : shown.map((r) =>
          r.type === "header" ? (
            <div
              key={`h-${r.source}`}
              className="sticky top-0 z-10 flex items-center gap-1.5 px-2.5 py-1 text-[9px] font-semibold uppercase tracking-wider"
              style={{ backgroundColor: tok("panel"), color: tok("muted"), borderBottom: `0.5px solid ${tok("border")}` }}
            >
              {r.source}
              <span className="font-mono tabular-nums" style={{ opacity: 0.7 }}>{r.count}</span>
            </div>
          ) : (
            <SkillRow key={`${r.skill.source}/${r.skill.id}`} skill={r.skill} on={selected.has(r.skill.id)} onToggle={onToggle} violet={violet} />
          ),
        )}
        {!loading && rows.length > ROW_CAP && (
          <p className="px-3 py-2 text-center text-[9px]" style={{ color: tok("muted") }}>
            showing {ROW_CAP} of {rows.length} rows — refine the search to narrow it
          </p>
        )}
      </div>
    </div>
  );
}

function SkillRow({
  skill, on, onToggle, violet,
}: {
  skill: Candidate;
  on: boolean;
  onToggle: (id: string) => void;
  violet: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onToggle(skill.id)}
      aria-pressed={on}
      className="flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left outline-none transition-colors duration-150 hover:bg-panel-2/60 focus-visible:ring-2 motion-reduce:transition-none"
      style={{ backgroundColor: on ? `color-mix(in oklch, ${violet} 12%, transparent)` : "transparent", borderBottom: `0.5px solid ${tok("border")}` }}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded" style={{ border: `1.5px solid ${on ? violet : tok("border")}`, backgroundColor: on ? violet : "transparent" }}>
        {on && <Check size={10} color="#fff" aria-hidden />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11px] font-medium" style={{ color: tok("text") }}>{skill.title}</span>
        <span className="block truncate text-[9px]" style={{ color: tok("muted") }}>{skill.hint}</span>
      </span>
      <span className="shrink-0 rounded text-[8px] uppercase" style={{ padding: "1px 6px", color: tok("muted"), backgroundColor: tok("panel-2") }}>{skill.family}</span>
    </button>
  );
}
