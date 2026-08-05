import {
  avatarFor,
  decidedLabel,
  diffstatLabel,
  gateLabel,
  isGate,
  isPending,
  isReadOnly,
  sourceLabel,
  sourceTone,
  type Delivery,
} from "../../lib/inboxClient";
import { RiskChip } from "./RiskChip";
import { SlaTimer } from "./SlaTimer";

/*
  One Delivery row. Rendered as a <button> so it is reachable and operable from
  the keyboard without re-implementing roving tabindex; `aria-current` carries
  selection (the visual brass border is never the only signal).

  P6 (ADR-053): the risk chip and the live SLA countdown are now real. RiskChip renders
  `unrated` only if the runtime ever leaves a band null (legacy rows); SlaTimer renders
  nothing until an absolute deadline exists, then counts down drift-free from it.
*/

export function DeliveryCard({
  delivery,
  selected,
  onSelect,
  animate = true,
}: {
  delivery: Delivery;
  selected: boolean;
  onSelect: (id: string) => void;
  animate?: boolean;
}) {
  const pending = isPending(delivery);
  const stat = diffstatLabel(delivery);
  const band = delivery.risk.band;

  return (
    <button
      type="button"
      className={`helm-card mb-2.5${animate ? " helm-card-enter" : ""}`}
      aria-current={selected ? "true" : undefined}
      data-decided={pending ? undefined : "true"}
      // S6 — a human-gate row (clarify question / design / release) carries an amber inset
      // accent so it reads as a gate in the list, matching its amber chip. Inset box-shadow,
      // so there is no layout shift against the 1px border.
      data-gate={isGate(delivery) && pending ? "true" : undefined}
      onClick={() => onSelect(delivery.id)}
    >
      <span className="flex flex-wrap items-center gap-2.5">
        <span className="helm-avatar" aria-hidden>
          {avatarFor(delivery.agentId)}
        </span>
        <span className="helm-display min-w-0 flex-1 text-[13.5px] leading-snug">{delivery.title}</span>
        {pending ? (
          <SlaTimer deadline={delivery.slaDeadline} slaState={delivery.slaState} className="ml-auto text-[11px]" />
        ) : (
          <span className="helm-chip ml-auto" data-tone={delivery.status === "rejected" ? "red" : "green"}>
            {decidedLabel(delivery.status)}
          </span>
        )}
      </span>

      <span className="mt-[7px] flex flex-wrap items-center gap-2.5">
        <RiskChip band={band} />
        {/* S2 — a human-gate chip (clarify question / design gate). It reads as amber
            (needs-you), distinct from the risk band, so a gate never looks like a code diff. */}
        {isGate(delivery) && (
          <span className="helm-chip" data-tone="amber">
            {gateLabel(delivery.kind)}
          </span>
        )}
        {/* P7 — real source identity: github-pr brass, claude-code grey + read-only tag. */}
        {delivery.source !== "swarm" && (
          <span className="helm-chip" data-tone={sourceTone(delivery.source)}>
            {sourceLabel(delivery.source)}{isReadOnly(delivery) ? " · read-only" : ""}
          </span>
        )}
        <span className="helm-mono text-[11px]" style={{ color: "var(--helm-paper-faint)" }}>
          {delivery.agentId}
        </span>
        {/* P5 — the branch this work lives on. Only rendered once the runtime knows
            one (worktree-backed tasks); a copy-sandbox delivery has none, and an
            invented branch name would be a lie about where the code is. */}
        {delivery.branch && (
          <span className="helm-mono truncate text-[11px]" style={{ color: "var(--helm-paper-faint)" }} title={delivery.branch}>
            {delivery.branch}
          </span>
        )}
        <span className="helm-mono text-[11px]" style={{ color: "var(--helm-paper-faint)" }}>
          {stat.files} <span style={{ color: "var(--helm-green)" }}>{stat.add}</span>{" "}
          <span style={{ color: "var(--helm-red)" }}>{stat.del}</span>
        </span>
      </span>
    </button>
  );
}
