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

function diffLineClass(line: string): string {
  if (line.startsWith("--- ") || line.startsWith("+++ ")) return "helm-diff-file";
  if (line.startsWith("@@")) return "helm-diff-meta";
  if (line.startsWith("+")) return "helm-diff-add";
  if (line.startsWith("-")) return "helm-diff-del";
  return "";
}

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

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        {/* 12px, not the 11px the read-only DiffBlock uses. Phase 8 sets a 12px absolute
            floor across the app; adding a NEW sub-12px site here would be work Phase 9
            then has to undo. `min-w-0` + anywhere-wrapping so a long path shrinks
            instead of forcing the row wider than a 320px pane. */}
        <span
          className="helm-mono text-[12px] min-w-0"
          style={{ color: "var(--helm-brass)", overflowWrap: "anywhere" }}
        >
          {change.path}
          <span style={{ color: "var(--helm-paper-faint)" }}> · {change.status}</span>
          {dirty ? <span className="helm-edit-flag">edited</span> : null}
        </span>
        <div className="flex items-center gap-1.5">
          {dirty ? (
            <button
              type="button"
              className="helm-btn helm-btn-slim"
              data-variant="quiet"
              onClick={revert}
              disabled={disabled}
            >
              Revert
            </button>
          ) : null}
          <button
            ref={editBtnRef}
            type="button"
            className="helm-btn helm-btn-slim"
            data-variant="quiet"
            onClick={toggle}
            disabled={disabled || !editable}
            title={editable ? undefined : (change.editableReason ?? undefined)}
            aria-expanded={editing}
            aria-controls={editing ? fieldId : undefined}
          >
            {editing ? "Done" : "Edit"}
          </button>
        </div>
      </div>

      {/* Rendered OUTSIDE the editing branch. The common sequence is Edit → type → Done →
          Approve, which closes the editor — an error confined to the open state would
          therefore almost never be seen. */}
      {errorMessage ? (
        <span id={errorId} className="helm-edit-error" role="alert">
          {errorMessage}
        </span>
      ) : null}

      {!editable ? (
        <span className="helm-edit-note">{change.editableReason}</span>
      ) : null}

      {editing ? (
        <>
          <label className="sr-only" htmlFor={fieldId}>
            {`Edit the proposed contents of ${change.path}`}
          </label>
          <textarea
            ref={areaRef}
            id={fieldId}
            className="helm-input helm-mono helm-edit-area"
            value={value}
            spellCheck={false}
            autoComplete="off"
            disabled={disabled}
            placeholder="This file is empty."
            aria-invalid={errorMessage ? true : undefined}
            aria-describedby={errorMessage ? errorId : undefined}
            onChange={(e) => onChange(change.path, e.target.value)}
          />
          <span className="helm-edit-note">
            Approving sends this text in place of the agent&apos;s. It lands through the same
            checks as an unedited approve.
          </span>
        </>
      ) : (
        <>
          {/* Once dirty the surface stops being a diff and becomes the operator's file
              body, so it says so. A diff-labelled region showing non-diff content is the
              kind of quiet mislabel that costs someone a bad approval. */}
          {dirty ? <span className="helm-edit-note">Showing your edit. Press Edit to keep changing it.</span> : null}
          <pre className="helm-diff" tabIndex={0} role="group" aria-label={headerLabel}>
            {dirty
              ? value.split("\n").map((ln, i) => (
                  <span key={i} style={{ display: "block" }}>
                    {ln === "" ? " " : ln}
                  </span>
                ))
              : lines.map((ln, i) => (
                  <span key={i} className={diffLineClass(ln)} style={{ display: "block" }}>
                    {ln === "" ? " " : ln}
                  </span>
                ))}
          </pre>
        </>
      )}
    </div>
  );
}

// Memoized: draft state lives in ReviewPane, so without this every keystroke in a 46vh
// monospace field reconciles every OTHER diff in the delivery. All props are already
// stable (the change object and the useCallback'd handlers), so the win is free.
export const DiffEditor = memo(DiffEditorImpl);
