import { useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ChevronDown, Check } from "lucide-react";
import { tok } from "../../lib/agentMeta";
import { MODEL_TIERS, type ModelTier } from "../../lib/modelTiers";

// Model-tier picker (ADR-022 + chat-first-ux §2). Custom listbox (not native
// <select>) so we can show tier hints + token styling. Per-thread; the parent owns
// the value + persistence. Keyboard: ↑/↓/Home/End/Enter/Esc, typeahead o/s/h.

export function ModelTierPicker({
  value,
  onChange,
  disabled,
}: {
  value: ModelTier;
  onChange: (t: ModelTier) => void;
  disabled?: boolean;
}) {
  const reduce = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();
  const cyan = tok("accent-cyan");

  const idx = Math.max(0, MODEL_TIERS.findIndex((t) => t.key === value));

  // open → focus the current selection
  useEffect(() => {
    if (open) setActive(idx);
  }, [open, idx]);

  // click-away closes
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const pick = (t: ModelTier) => {
    onChange(t);
    setOpen(false);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(MODEL_TIERS.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(MODEL_TIERS.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(MODEL_TIERS[active].key);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    } else if (/^[osh]$/i.test(e.key)) {
      const hit = MODEL_TIERS.findIndex((t) => t.key.startsWith(e.key.toLowerCase()));
      if (hit >= 0) setActive(hit);
    }
  };

  const current = MODEL_TIERS[idx];

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
        onKeyDown={onKey}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Model tier, currently ${current.label}`}
        className="inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium outline-none transition-colors focus-visible:ring-2 disabled:opacity-50"
        style={{
          color: tok("text"),
          backgroundColor: tok("panel-2"),
          borderColor: tok("border"),
        }}
      >
        <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: cyan }} aria-hidden />
        {current.label}
        <ChevronDown size={12} aria-hidden style={{ color: tok("muted") }} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.ul
            id={listId}
            role="listbox"
            aria-label="Model tier"
            aria-activedescendant={`${listId}-${MODEL_TIERS[active].key}`}
            tabIndex={-1}
            onKeyDown={onKey}
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduce ? 0 : 0.16, ease: [0.22, 1, 0.36, 1] }}
            className="absolute right-0 z-50 mt-1.5 w-[220px] origin-top-right overflow-hidden rounded-[10px] border py-1 shadow-xl outline-none"
            style={{ backgroundColor: tok("panel-2"), borderColor: tok("border") }}
          >
            {MODEL_TIERS.map((t, i) => {
              const selected = t.key === value;
              const isActive = i === active;
              return (
                <li
                  key={t.key}
                  id={`${listId}-${t.key}`}
                  role="option"
                  aria-selected={selected}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(t.key)}
                  className="flex h-11 cursor-pointer items-center justify-between px-3"
                  style={{
                    backgroundColor: isActive
                      ? `color-mix(in oklch, ${cyan} 10%, ${tok("panel-2")})`
                      : "transparent",
                  }}
                >
                  <span className="flex items-baseline gap-2">
                    <span
                      className="text-[13px]"
                      style={{ color: selected ? tok("text") : tok("muted"), fontWeight: selected ? 600 : 400 }}
                    >
                      {t.label}
                    </span>
                    <span className="font-mono text-[11px]" style={{ color: tok("muted") }}>
                      {t.hint}
                    </span>
                  </span>
                  {selected && <Check size={14} aria-hidden style={{ color: cyan }} />}
                </li>
              );
            })}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
}
