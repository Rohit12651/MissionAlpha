/**
 * Zero-Delivery state. Phase G (ADR G-2): the mockup's `.empty-note` — a script line,
 * then one sentence. Two honest variants: nothing has arrived at all, or the active filter
 * matched nothing. Never invents a count or a next step it can't deliver.
 */
export function EmptyState({ filtered, onClear }: { filtered?: boolean; onClear?: () => void }) {
  return (
    <li className="empty-note" role="status">
      <span className="script">Inbox zero.</span><br />
      {filtered ? "Nothing in this filter. " : "Finished agent work lands here on its own."}
      {filtered && onClear && <button type="button" className="linkish" onClick={onClear}>Show all</button>}
    </li>
  );
}
