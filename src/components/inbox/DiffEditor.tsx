import { memo, useCallback, useEffect, useId, useMemo, useRef } from "react";
import type { DeliveryChange } from "../../lib/inboxClient";

/*
  PHASE 4 — approve-with-edit.

  SECURITY (this file inherits ReviewPane's P3 exit criterion and must not weaken it):
  the proposal is rendered and edited as TEXT ONLY. The read view is React text nodes;
  the edit view is a controlled <textarea>, whose value React sets as a DOM PROPERTY —
  the browser never parses it as markup. There is no innerHTML and no
  dangerouslySetInnerHTML here or anywhere in src/, and src/lib/__tests__/no-innerhtml.test.ts
  fails the build if that ever stops being true. Diff content originates in a sandboxed
  agent, so it is untrusted by definition; an operator's edit arrives from the browser and
  is equally untrusted — the runtime re-validates every byte in patch-edit.mjs.

  NO SYNTAX HIGHLIGHTING. Deliberate, and the reason is the security control above: every
  highlighter worth using emits HTML. Doing it safely means a token array rendered as
  React elements (Shiki's `codeToTokens`), which is a real piece of work and is explicitly
  out of scope here. A plain textarea that cannot be an XSS vector beats a pretty one that
  might be. Recorded as a known gap, not an oversight.

  NEVER OFFER AN EDIT THAT CANNOT LAND. The runtime marks a change `editable: false` when
  the reviewed text is not the text on disk — a file truncated at 4000 chars, or one whose
  secrets were redacted before review. Editing those fails closed server-side. Showing an
  enabled Edit button there would take a full retyped file and refuse it only after the
  operator pressed Approve on a production write. The button is disabled with the reason
  stated instead.

  WHAT AN EDIT MEANS. `after` is the FULL new body of the file, not a patch. The operator
  is correcting the agent's proposed content; the runtime diffs it, re-checks the path
  against the delivery's own change set and the broker's guards, and stages it into the
  agent's workdir. The repo write still happens in exactly one place: broker.applyChanges.
*/

export interface DiffEditorProps {
  change: DeliveryChange;
  /** The operator's current text for this file, or undefined while untouched. */
  draft: string | undefined;
  /** True while this file is open for editing. */
  editing: boolean;
  /** Disabled while a decision is in flight — an edit mid-approve would race the request. */
  disabled?: boolean;
  /**
   * The server's refusal for THIS file. Rendered on the field, not only in a pane-level
   * banner the operator would have to map back to a filename themselves.
   */
  errorMessage?: string | null;
  onToggleEdit: (path: string, next: boolean) => void;
  onChange: (path: string, next: string) => void;
  onRevert: (path: string) => void;
}

/** The mockup's diff line classes: `.a` added, `.d` deleted, `.c` context. */
const diffLine = (line: string): "a" | "d" | "c" =>
  line.startsWith("+") && !line.startsWith("+++ ") ? "a" : line.startsWith("-") && !line.startsWith("--- ") ? "d" : "c";

function DiffEditorImpl({
  change,
  draft,
  editing,
  disabled = false,
  errorMessage = null,
  onToggleEdit,
  onChange,
  onRevert,
}: DiffEditorProps) {
  const fieldId = useId();
  const errorId = `${fieldId}-error`;
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const editBtnRef = useRef<HTMLButtonElement | null>(null);

  const lines = useMemo(() => change.patch.split("\n"), [change.patch]);
  // The editor's baseline is the reviewed `after`, so "dirty" means "differs from what
  // the agent proposed" — not "differs from the last keystroke".
  const dirty = draft !== undefined && draft !== change.after;
  const value = draft ?? change.after;
  // `undefined` means a pre-Phase-4 payload, which predates the flag and is editable.
  const editable = change.editable !== false;

  const toggle = useCallback(
    () => onToggleEdit(change.path, !editing),
    [change.path, editing, onToggleEdit],
  );

  // Opening the editor should put the caret in it. Without this a keyboard operator
  // presses Edit and then has to Tab into the field they just asked for.
  useEffect(() => {
    if (editing) areaRef.current?.focus();
  }, [editing]);

  // Revert unmounts its own button. Moving focus FIRST keeps it inside the pane — in
  // overlay mode the focus trap compares activeElement against the first/last focusable,
  // and a focus that fell to <body> matches neither, so Tab escapes the dialog.
  const revert = useCallback(() => {
    editBtnRef.current?.focus();
    onRevert(change.path);
  }, [change.path, onRevert]);

  const headerLabel = dirty ? `Your edited contents of ${change.path}` : `Diff for ${change.path}`;

  // Phase G (ADR G-2): the mockup's `.diff` box — a header row (the file, its controls)
  // over a `<pre>` of `.a` / `.d` / `.c` lines; the editor is the mockup's `.diff textarea`.
  return (
    <div className="diff">
      <div className="diff-h">
        <span className="mono" style={{ minWidth: 0, overflowWrap: "anywhere" }}>
          {change.path}
          {dirty ? <span className="sub">{" · edited"}</span> : null}
        </span>
        <span className="row" style={{ gap: 8 }}>
          {dirty ? <button type="button" className="linkish" onClick={revert} disabled={disabled}>Revert</button> : null}
          <button ref={editBtnRef} type="button" className="linkish" onClick={toggle} disabled={disabled || !editable}
            title={editable ? undefined : (change.editableReason ?? undefined)} aria-expanded={editing} aria-controls={editing ? fieldId : undefined}>
            {editing ? "Done" : "Edit"}
          </button>
        </span>
      </div>
      {/* Rendered OUTSIDE the editing branch: Edit → type → Done → Approve closes the
          editor, so an error confined to the open state would almost never be seen. */}
      {errorMessage ? <p id={errorId} className="sub" role="alert" style={{ color: "var(--bad-ink)", margin: "6px 12px" }}>{errorMessage}</p> : null}
      {!editable ? <p className="sub" style={{ margin: "6px 12px" }}>{change.editableReason}</p> : null}
      {editing ? (
        <>
          <label className="sr-only" htmlFor={fieldId}>{`Edit the proposed contents of ${change.path}`}</label>
          <textarea ref={areaRef} id={fieldId} value={value} spellCheck={false} autoComplete="off" disabled={disabled}
            placeholder="This file is empty." aria-invalid={errorMessage ? true : undefined} aria-describedby={errorMessage ? errorId : undefined}
            onChange={(e) => onChange(change.path, e.target.value)} />
          <p className="sub" style={{ margin: "6px 12px" }}>Approving sends this text in place of the agent&apos;s. It lands through the same checks as an unedited approve.</p>
        </>
      ) : (
        // Once dirty the surface stops being a diff and becomes the operator's file body,
        // and says so: a diff-labelled region showing non-diff content is a quiet mislabel.
        <pre tabIndex={0} role="group" aria-label={headerLabel}>
          {dirty
            ? value.split("\n").map((ln, i) => <span key={i} className="c">{ln === "" ? " " : ln}</span>)
            : lines.map((ln, i) => <span key={i} className={diffLine(ln)}>{ln === "" ? " " : ln}</span>)}
        </pre>
      )}
    </div>
  );
}

export const DiffEditor = memo(DiffEditorImpl);
