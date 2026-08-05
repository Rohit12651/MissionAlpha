// B2 — the memory graph: the vault's centre and its six nodes on spokes.
//
// EVERY NUMBER IS REAL. The centre shows the live `stats.total` for the current
// venture scope; each satellite shows that node's live count. There is no fixture and
// no placeholder — an empty vault renders zeros, which is the truth.
//
// A11Y: each node is a `<g role="button" tabindex={0}>` with an aria-label carrying
// the label AND the count, activated by click, Enter or Space. The whole SVG is a
// `role="group"` with a label, so a screen reader meets it as a labelled set of
// buttons rather than an unlabelled graphic.
//
// MOTION: none. The graph is static — layout is computed once from a fixed geometry,
// nothing animates on mount, and the only transitions are the hover-gated fill/stroke
// changes in bos.css (140ms, colour only). Nothing here needs reduced-motion handling
// because there is nothing to reduce.

import { memo, useMemo } from "react";
import { VAULT_NODES, NODE_META, type VaultNode } from "../../lib/vaultClient";

export interface MemoryGraphProps {
  /** Live per-node counts for the current venture scope. */
  byNode: Record<VaultNode, number>;
  /** Live total for the current scope — the number in the centre. */
  total: number;
  /** The selected node, or null when the centre (recent across nodes) is selected. */
  selected: VaultNode | null;
  /** null = the centre was chosen. */
  onSelect: (node: VaultNode | null) => void;
}

// Fixed geometry in the 600×600 viewBox. The SVG scales fluidly via CSS
// (width:100%; height:auto), so these are ratios in disguise, never device pixels.
const CX = 300;
const CY = 300;
const CENTER_R = 58;
const ORBIT_R = 208;
const NODE_R = 52;

interface Spoke {
  node: VaultNode;
  x: number;
  y: number;
}

/** Six nodes evenly around the circle, first one straight up. Pure — no DOM. */
function spokes(): Spoke[] {
  return VAULT_NODES.map((node, i) => {
    const angle = (Math.PI * 2 * i) / VAULT_NODES.length - Math.PI / 2;
    return { node, x: CX + ORBIT_R * Math.cos(angle), y: CY + ORBIT_R * Math.sin(angle) };
  });
}

export const MemoryGraph = memo(function MemoryGraph({ byNode, total, selected, onSelect }: MemoryGraphProps) {
  const nodes = useMemo(spokes, []);
  // One handler shape for mouse and keyboard: a `<g>` is not a native button, so
  // Enter/Space have to be wired explicitly or the graph is mouse-only.
  const keyActivate = (fn: () => void) => (e: React.KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
    e.preventDefault();
    fn();
  };

  return (
    <svg
      className="bos-vault-graph"
      viewBox="0 0 600 600"
      role="group"
      aria-label="Memory graph — the vault by node"
    >
      {/* Spokes first so every node circle paints over its own line end. */}
      <g aria-hidden>
        {nodes.map((s) => (
          <line key={`spoke-${s.node}`} className="bos-vault-spoke" x1={CX} y1={CY} x2={s.x} y2={s.y} />
        ))}
        <circle className="bos-vault-orbit" cx={CX} cy={CY} r={ORBIT_R} />
      </g>

      {/* Centre — the whole vault for the current scope. */}
      <g
        className="bos-vault-node bos-vault-node--center"
        role="button"
        tabIndex={0}
        aria-label={`The log — ${total} records in all nodes`}
        aria-pressed={selected === null}
        data-selected={selected === null ? "true" : undefined}
        onClick={() => onSelect(null)}
        onKeyDown={keyActivate(() => onSelect(null))}
      >
        <circle className="bos-vault-node-disc" cx={CX} cy={CY} r={CENTER_R} />
        <text className="bos-vault-node-count" x={CX} y={CY - 2} textAnchor="middle">{total}</text>
        <text className="bos-vault-node-label" x={CX} y={CY + 20} textAnchor="middle">THE LOG</text>
      </g>

      {nodes.map((s) => {
        const n = byNode?.[s.node] ?? 0;
        const meta = NODE_META[s.node];
        return (
          <g
            key={s.node}
            className="bos-vault-node"
            role="button"
            tabIndex={0}
            aria-label={`${meta.label} — ${n} record${n === 1 ? "" : "s"}`}
            aria-pressed={selected === s.node}
            data-selected={selected === s.node ? "true" : undefined}
            data-empty={n === 0 ? "true" : undefined}
            onClick={() => onSelect(s.node)}
            onKeyDown={keyActivate(() => onSelect(s.node))}
          >
            <circle className="bos-vault-node-disc" cx={s.x} cy={s.y} r={NODE_R} />
            <text className="bos-vault-node-count" x={s.x} y={s.y - 2} textAnchor="middle">{n}</text>
            <text className="bos-vault-node-label" x={s.x} y={s.y + 18} textAnchor="middle">
              {meta.label.toUpperCase()}
            </text>
          </g>
        );
      })}
    </svg>
  );
});
