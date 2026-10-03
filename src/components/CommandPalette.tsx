// Command palette (gap #27) — ⌘K / Ctrl-K keyboard-driven nav, Raycast/Linear style.
// Reaches everything: switch model, new chat, open connectors, dispatch a goal, open
// settings, jump to a thread/agent. Pure matching lives in lib/paletteCommands.ts.

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Search, CornerDownLeft } from "lucide-react";
import { filterCommands, type PaletteCommand } from "../lib/paletteCommands";
import { tok } from "../lib/agentMeta";

export function CommandPalette({
  open,
  onClose,
  commands,
}: {
  open: boolean;
  onClose: () => void;
  commands: PaletteCommand[];
}) {
  const reduce = useReducedMotion();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // What had focus before the palette opened; it gets focus back when the palette closes,
  // BEFORE the chosen command runs (choose() defers run() a frame), so a command that opens
  // a dialog records the right opener instead of <body>.
  const returnTo = useRef<Element | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  const results = useMemo(() => filterCommands(commands, query), [commands, query]);

  // Open: reset + focus the input. Close: give focus back to what had it.
  useEffect(() => {
    if (!open) {
      const el = returnTo.current as HTMLElement | null;
      returnTo.current = null;
      if (el?.isConnected) el.focus();
      return;
    }
    returnTo.current = document.activeElement;
    setQuery("");
    setActive(0);
    // focus after paint so the dialog is mounted
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  // Document-level Escape (capture) — closes even if focus somehow left the input.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  // Keep active index in range as results shrink.
  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, results.length - 1)));
  }, [results.length]);

  // Scroll the active row into view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = (i: number) => {
    const cmd = results[i];
    if (!cmd) return;
    onClose();
    // run after close so any UI the command opens isn't immediately dismissed
    requestAnimationFrame(() => cmd.run());
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (results.length ? (a + 1) % results.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (results.length ? (a - 1 + results.length) % results.length : 0));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(Math.max(0, results.length - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Tab") {
      // Focus trap: the input is the only focusable child, so keep focus here
      // rather than letting Tab escape to the page behind the modal dialog.
      e.preventDefault();
      inputRef.current?.focus();
    }
  };

  return (
    <AnimatePresence>
      {open && (
      <div key="palette" className="fixed inset-0 z-[80] flex items-start justify-center p-4 pt-[12vh]" role="dialog" aria-modal="true" aria-label="Command palette">
        <motion.div
          className="absolute inset-0"
          style={{ backgroundColor: `color-mix(in oklch, ${tok("bg")} 70%, transparent)` }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduce ? 0 : 0.15 }}
          onClick={onClose}
          aria-hidden
        />
        <motion.div
          className="relative w-full max-w-xl overflow-hidden rounded-panel border border-border bg-panel shadow-2xl"
          initial={{ opacity: 0, scale: reduce ? 1 : 0.98, y: reduce ? 0 : -6 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: reduce ? 1 : 0.99, y: reduce ? 0 : -4 }}
          transition={{ duration: reduce ? 0 : 0.16, ease: [0.22, 1, 0.36, 1] }}
        >
          <div className="flex items-center gap-2 border-b border-border px-3.5 py-3">
            <Search size={16} aria-hidden style={{ color: tok("muted") }} />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              role="combobox"
              aria-expanded
              aria-controls="palette-list"
              aria-activedescendant={results[active] ? `palette-opt-${active}` : undefined}
              aria-autocomplete="list"
              placeholder="Type a command or search…"
              className="w-full bg-transparent text-sm text-text outline-none placeholder:text-muted"
              autoComplete="off"
              spellCheck={false}
            />
            <kbd className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted">esc</kbd>
          </div>

          {results.length === 0 ? (
            <p className="px-4 py-6 text-center text-[13px] text-muted">No matching commands.</p>
          ) : (
            <ul ref={listRef} id="palette-list" role="listbox" aria-label="Commands" className="max-h-[50vh] overflow-y-auto py-1.5">
              {results.map((c, i) => {
                const isActive = i === active;
                return (
                  <li
                    key={c.id}
                    id={`palette-opt-${i}`}
                    data-idx={i}
                    role="option"
                    aria-selected={isActive}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => choose(i)}
                    className="mx-1.5 flex cursor-pointer items-center justify-between gap-3 rounded-md px-2.5 py-2"
                    style={{ backgroundColor: isActive ? `color-mix(in oklch, ${tok("accent-cyan")} 14%, transparent)` : "transparent" }}
                  >
                    <span className="flex min-w-0 items-center gap-2.5">
                      <span className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide" style={{ color: tok("muted"), border: `1px solid ${tok("border")}` }}>
                        {c.group}
                      </span>
                      <span className="truncate text-[13px] text-text">{c.title}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {c.hint && <span className="font-mono text-[11px] text-muted">{c.hint}</span>}
                      {isActive && <CornerDownLeft size={13} aria-hidden style={{ color: tok("accent-cyan") }} />}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </motion.div>
      </div>
      )}
    </AnimatePresence>
  );
}
