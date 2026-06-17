import { useMemo, useState } from "react";
import { Search, Send, Check, Wrench, Plug } from "lucide-react";
import { tok } from "../../lib/agentMeta";
import type { Skill } from "../../lib/factoryClient";

// Surface 3 — Skill catalog. A dense, searchable LIST (not a grid) of the closed
// capability set. Standalone (browse) or pick-mode (selectable, inside create flow).
// OKLCH tokens only; factory-violet identity; gold "POSTS" badge for real-posting.

export function SkillCatalog({
  skills,
  selected,
  onToggle,
  mode = "browse",
}: {
  skills: Skill[];
  selected?: Set<string>;
  onToggle?: (id: string) => void;
  mode?: "browse" | "pick";
}) {
  const [q, setQ] = useState("");
  const [postingOnly, setPostingOnly] = useState(false);
  const violet = tok("factory-violet");
  const gold = tok("ceo-gold");

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return skills.filter((s) => {
      if (postingOnly && !s.posting) return false;
      if (!needle) return true;
      return (s.label + " " + s.id + " " + s.desc).toLowerCase().includes(needle);
    });
  }, [skills, q, postingOnly]);

  return (
    <div>
      {/* search + filter */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[180px] flex-1">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search skills…"
            aria-label="Search skills"
            className="w-full rounded-md border border-border/60 bg-bg/60 py-1.5 pl-8 pr-3 text-[12px] text-text/90 outline-none placeholder:text-muted/50 focus-visible:ring-2"
          />
        </div>
        <button
          type="button"
          onClick={() => setPostingOnly((v) => !v)}
          aria-pressed={postingOnly}
          className="rounded-full px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide outline-none focus-visible:ring-2"
          style={{
            color: postingOnly ? gold : tok("muted"),
            backgroundColor: postingOnly ? `color-mix(in oklch, ${gold} 14%, transparent)` : "transparent",
            border: `1px solid color-mix(in oklch, ${postingOnly ? gold : tok("border")} 50%, transparent)`,
          }}
        >
          Posts only
        </button>
      </div>

      <ul className="space-y-1.5">
        {filtered.map((s) => {
          const isSel = selected?.has(s.id);
          const Row = mode === "pick" ? "button" : "div";
          return (
            <li key={s.id}>
              <Row
                {...(mode === "pick"
                  ? { type: "button" as const, onClick: () => onToggle?.(s.id), "aria-pressed": !!isSel }
                  : {})}
                className={`flex w-full items-start gap-3 rounded-md border px-3 py-2.5 text-left outline-none ${mode === "pick" ? "focus-visible:ring-2" : ""}`}
                style={{
                  borderColor: isSel ? `color-mix(in oklch, ${violet} 50%, transparent)` : "var(--c-border)",
                  backgroundColor: isSel ? `color-mix(in oklch, ${violet} 10%, transparent)` : "color-mix(in oklch, var(--c-bg) 30%, transparent)",
                }}
              >
                {mode === "pick" && (
                  <span
                    className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border"
                    style={{
                      borderColor: isSel ? violet : "var(--c-border)",
                      backgroundColor: isSel ? `color-mix(in oklch, ${violet} 22%, transparent)` : "transparent",
                      color: violet,
                    }}
                    aria-hidden
                  >
                    {isSel && <Check size={11} />}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[12.5px] font-semibold text-text">{s.label}</span>
                    <span className="font-mono text-[9px] uppercase tracking-wide text-muted">{s.id}</span>
                    {s.posting && (
                      <span
                        className="inline-flex items-center gap-1 rounded font-mono text-[8.5px] font-semibold uppercase tracking-wide"
                        style={{
                          padding: "1px 5px",
                          color: gold,
                          backgroundColor: `color-mix(in oklch, ${gold} 12%, transparent)`,
                          border: `1px solid color-mix(in oklch, ${gold} 30%, transparent)`,
                        }}
                      >
                        <Send size={9} aria-hidden /> Posts
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[11px] leading-snug text-muted">{s.desc}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[9px] text-muted">
                    {s.tools.length > 0 && (
                      <span className="inline-flex items-center gap-1 font-mono">
                        <Wrench size={9} aria-hidden /> {s.tools.join(" · ")}
                      </span>
                    )}
                    {s.platforms.length > 0 && (
                      <span className="inline-flex items-center gap-1 font-mono" style={{ color: violet }}>
                        <Plug size={9} aria-hidden /> {s.platforms.join(" · ")}
                      </span>
                    )}
                  </div>
                </div>
              </Row>
            </li>
          );
        })}
        {filtered.length === 0 && (
          <li className="rounded-md border border-dashed border-border/60 px-3 py-6 text-center text-[11px] text-muted">
            No skills match “{q}”.
          </li>
        )}
      </ul>
    </div>
  );
}
