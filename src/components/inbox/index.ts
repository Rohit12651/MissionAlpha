// Barrel for the Inbox surface so App.tsx pulls ONE lazily-loaded chunk behind
// the VITE_INBOX flag (flag off ⇒ none of this is fetched or parsed).
export { InboxPanel, type InboxPanelProps } from "./InboxPanel";
export { DeliveryCard } from "./DeliveryCard";
export { ReviewPane } from "./ReviewPane";
export { EmptyState } from "./EmptyState";
export { ErrorState } from "./ErrorState";
export { SseDisconnectedBanner } from "./SseDisconnectedBanner";
export { QueueStrip, type QueueStripProps } from "./QueueStrip";
export { RiskChip } from "./RiskChip";
export { SlaTimer } from "./SlaTimer";
export { AutoApprovedStrip } from "./AutoApprovedStrip";
export { Scoreboard } from "./Scoreboard";
