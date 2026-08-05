import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Search, X, ChevronDown, ChevronRight, CornerDownLeft } from "lucide-react";
import type { MissionSkill } from "../../lib/missionSkills";
import { groupSkills, flattenRows, rowOffsets, visibleSlice } from "../../lib/skillGroups";
import { tok } from "../../lib/agentMeta";

const HEADER_H = 30;
const ITEM_H = 46;
const OVERSCAN = 4;

/**
 * Persistent, dockable LEFT Skills palette (C3). Lists the full catalog grouped by SOURCE
 * (collapsible + counts), live search, ↑↓/Enter/Esc keyboard nav, VIRTUALIZED (only visible rows
 * mount → 60fps at ~3,300 entries). `skills` arrives from the lazily-loaded catalog chunk. Pick drops the skill's prompt into the chat composer via the
 * caller's onPick (App's existing prefill flow) — no new execution path. Stays open until Esc/✕/toggle.
 */
export function SkillPalette({
  open,
  onClose,
  skills,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  skills: readonly MissionSkill[];
  onPick: (s: MissionSkill) => void;
}) {
  const reduce = useReducedMotion();
  const [rawQuery, setRawQuery] = useState("");
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [activeIdx, setActiveIdx] = useState(0); // index into rows (only item rows are selectable)
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(600);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Debounce the query (≈120ms) so 1,870-entry filtering doesn't run per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setQuery(rawQuery), 120);
    return () => clearTimeout(t);
  }, [rawQuery]);

  // BOSS ask F3 — the palette groups by SOURCE (where the skill came from), not by the
  // curated family taxonomy. Same virtualized machinery; only the group key changes.
  const groups = useMemo(() => groupSkills(skills, query, (s) => s.source), [skills, query]);
  const rows = useMemo(() => flattenRows(groups, collapsed), [groups, collapsed]);
  const { tops, total } = useMemo(() => rowOffsets(rows, HEADER_H, ITEM_H), [rows]);
  const itemIdx = useMemo(
    () => rows.map((r, i) => (r.type === "item" ? i : -1)).filter((i) => i >= 0),
    [rows],
  );
  const resultCount = useMemo(() => groups.reduce((n, g) => n + g.count, 0), [groups]);

  const { start, end } = visibleSlice(tops, ITEM_H, scrollTop, viewportH, OVERSCAN);

  // Reset + focus on open.
  useEffect(() => {
    if (!open) return;
    setRawQuery("");
    setQuery("");
    setCollapsed(new Set());
    setActiveIdx(0);
    setScrollTop(0);
    if (scrollRef.current) setViewportH(scrollRef.current.clientHeight || 600);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  // Keep the active index pinned to a selectable (item) row. Functional updater reads the
  // latest activeIdx without listing it as a dep (avoids an extra render on each move).
  useEffect(() => {
    if (!itemIdx.length) return;
    setActiveIdx((cur) => (itemIdx.includes(cur) ? cur : itemIdx[0]));
  }, [itemIdx]);

  const scrollActiveIntoView = useCallback(
    (rowIndex: number) => {
      const el = scrollRef.current;
      if (!el) return;
      const top = tops[rowIndex] ?? 0;
      const bottom = top + ITEM_H;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
    },
    [tops],
  );

  const move = (dir: 1 | -1) => {
    if (!itemIdx.length) return;
    const pos = itemIdx.indexOf(activeIdx);
    const next = itemIdx[(pos + dir + itemIdx.length) % itemIdx.length];
    setActiveIdx(next);
    scrollActiveIntoView(next);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = rows[activeIdx];
      if (r?.type === "item" && r.skill) {
        onPick(r.skill);
        onClose();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  const toggle = (family: string) =>
    setCollapsed((c) => {
      const n = new Set(c);
      if (n.has(family)) n.delete(family);
      else n.add(family);
      return n;
    });

  return (
    <AnimatePresence>
      {open && (
        <div key="skills" className="fixed inset-0 z-[70]">
          {/* dim scrim — persistent: clicking it does NOT close (Esc/✕/toggle only) */}
          <motion.div
            className="absolute inset-0"
            style={{ backgroundColor: `color-mix(in oklch, ${tok("bg")} 55%, transparent)` }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduce ? 0 : 0.16 }}
            aria-hidden
          />
          <motion.aside
            className="absolute left-0 top-0 flex h-full w-[360px] flex-col border-r border-border bg-panel shadow-2xl"
            style={{ paddingTop: "var(--titlebar-h)" }}
            role="dialog"
            aria-label="Skills palette"
            initial={{ x: reduce ? 0 : -24, opacity: reduce ? 1 : 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: reduce ? 0 : -16, opacity: reduce ? 1 : 0 }}
            transition={{ duration: reduce ? 0 : 0.18, ease: [0.16, 1, 0.3, 1] }}
            onKeyDown={onKeyDown}
          >
            <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
              <span className="text-[13px] font-semibold tracking-tight" style={{ color: tok("text") }}>
                ✦ Skills
              </span>
              <span
                className="ml-auto font-mono text-[11px] tabular-nums"
                style={{ color: tok("muted") }}
                role="status"
                aria-live="polite"
              >
                {resultCount} {resultCount === 1 ? "skill" : "skills"} · {groups.length} src
              </span>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close skills palette"
                className="rounded-md p-1.5 outline-none transition-colors duration-150 hover:bg-panel-2 focus-visible:ring-2 motion-reduce:transition-none"
                style={{ color: tok("muted") }}
              >
                <X size={15} aria-hidden />
              </button>
            </div>

            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <Search size={15} aria-hidden style={{ color: tok("muted") }} />
              <input
                ref={inputRef}
                value={rawQuery}
                onChange={(e) => setRawQuery(e.target.value)}
                role="combobox"
                aria-label="Search skills — arrow keys navigate, Enter picks, Escape closes"
                aria-expanded={resultCount > 0}
                aria-controls={resultCount > 0 ? "skills-list" : undefined}
                aria-activedescendant={
                  rows[activeIdx]?.type === "item" && activeIdx >= start && activeIdx < end
                    ? `skill-opt-${activeIdx}`
                    : undefined
                }
                aria-autocomplete="list"
                placeholder="Search skills…"
                spellCheck={false}
                autoComplete="off"
                className="w-full bg-transparent text-[13px] outline-none placeholder:text-muted"
                style={{ color: tok("text") }}
              />
            </div>

            {resultCount === 0 ? (
              <p className="px-4 py-8 text-center text-[13px]" style={{ color: tok("muted") }} role="status" aria-live="polite">
                {skills.length === 0 ? "Loading the skill catalog…" : `No skills match “${query}”.`}
              </p>
            ) : (
              <div
                ref={scrollRef}
                id="skills-list"
                role="listbox"
                aria-label="Skills"
                className="relative min-h-0 flex-1 overflow-y-auto"
                onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
              >
                <div style={{ height: total, position: "relative" }}>
                  {rows.slice(start, end).map((r, k) => {
                    const i = start + k;
                    const style: React.CSSProperties = {
                      position: "absolute",
                      top: tops[i],
                      left: 0,
                      right: 0,
                      height: r.type === "header" ? HEADER_H : ITEM_H,
                    };
                    if (r.type === "header") {
                      const isCollapsed = collapsed.has(r.family);
                      return (
                        <button
                          key={`h-${r.family}`}
                          type="button"
                          style={style}
                          onClick={() => toggle(r.family)}
                          aria-expanded={!isCollapsed}
                          aria-label={`${r.family} source, ${r.count} skills`}
                          className="flex w-full items-center gap-1.5 px-3 text-left outline-none focus-visible:ring-2"
                        >
                          {isCollapsed ? (
                            <ChevronRight size={13} aria-hidden style={{ color: tok("muted") }} />
                          ) : (
                            <ChevronDown size={13} aria-hidden style={{ color: tok("muted") }} />
                          )}
                          <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: tok("muted") }}>
                            {r.family}
                          </span>
                          <span className="font-mono text-[10px] tabular-nums" style={{ color: tok("muted"), opacity: 0.7 }}>
                            {r.count}
                          </span>
                        </button>
                      );
                    }
                    const s = r.skill!;
                    const isActive = i === activeIdx;
                    return (
                      <button
                        key={`${s.kind}-${s.id}`}
                        id={`skill-opt-${i}`}
                        type="button"
                        style={style}
                        role="option"
                        aria-selected={isActive}
                        aria-label={`${s.title}, ${s.hint}, ${s.family} ${s.kind}`}
                        onMouseEnter={() => setActiveIdx(i)}
                        onClick={() => {
                          onPick(s);
                          onClose();
                        }}
                        className="flex w-full items-center gap-2 px-3 text-left outline-none focus-visible:ring-2"
                      >
                        <span
                          className="flex min-w-0 flex-1 flex-col rounded px-1.5 py-1"
                          style={{ backgroundColor: isActive ? `color-mix(in oklch, ${tok("accent-cyan")} 14%, transparent)` : "transparent" }}
                        >
                          <span className="truncate font-mono text-[12px]" style={{ color: tok("text") }}>
                            {s.title}
                          </span>
                          <span className="truncate text-[11px]" style={{ color: tok("muted") }}>
                            {s.hint}
                          </span>
                        </span>
                        {isActive && <CornerDownLeft size={12} aria-hidden style={{ color: tok("accent-cyan") }} />}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </motion.aside>
        </div>
      )}
    </AnimatePresence>
  );
}
