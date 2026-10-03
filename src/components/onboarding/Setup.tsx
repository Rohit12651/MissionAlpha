// Landing + Setup (spec §5.3) — the 5-step setup: the approved mockup's onboarding dialog
// (`#ov-ob`, renderer lines 2177–2201). Every step is wired to the runtime; a step only
// claims what the runtime confirmed. The dialog is modal: focus moves in on open, Tab cycles
// inside, focus returns to the opener on close. Esc, a scrim click and a focus-only
// "Close setup" control always close it — closing is never treated as finishing
// (amendment 2), so the onboarded flag is written only by "Open the cockpit".

import { useEffect, useRef, useState, type ReactNode } from "react";
import { addAccount, getAccounts, getCliEngines, setActiveAccount, type CliEnginesResponse } from "../../lib/accounts";
import { accountPlan, folderOk, readyLines, type ProjectStatus } from "../../lib/firstRun";
import { setWorkspace } from "../../lib/workspaceClient";

const ROW_STYLE = { gridTemplateColumns: "auto minmax(0,1fr)" } as const;
const NO_ANSWER = "The runtime did not answer.";

export interface SetupProps {
  open: boolean;
  onClose: () => void;
  /** "Open the cockpit": the only path that marks the operator onboarded. */
  onDone: () => void;
  /** The runtime's real station count, or null while unknown. */
  stations: number | null;
  /** Where focus goes on close. Owned by the caller, so a reopen from inside Setup keeps it. */
  returnFocus: { readonly current: Element | null };
}

/** A step may act on Next; it resolves true to advance, false to stay (its error is on screen). */
interface Step { title: string; body: ReactNode; canNext: boolean; onNext?: () => Promise<boolean> }

/** Only a sentence the runtime wrote is shown; a refusal for rights says so; everything else is the fixed fallback (AC-SEC2). */
const errorOf = (e: unknown) => (e instanceof Error && /^HTTP 40[13]$/.test(e.message) ? "The runtime refused this: it needs an approver seat." : NO_ANSWER);

const FOCUSABLE = "button:not([disabled]):not([hidden]), input:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])";

export function Setup({ open, onClose, onDone, stations, returnFocus }: SetupProps) {
  const [step, setStep] = useState(0);
  // Engines: the last answer (null until one arrives). A re-detect keeps it on screen while it
  // asks, and keeps it after a failure, so the user never loses what they already saw.
  const [engines, setEngines] = useState<CliEnginesResponse | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [enginesError, setEnginesError] = useState<string | null>(null);
  // The control that had focus is gone or disabled; keep focus inside (Next if usable, else Detect, else the title).
  const keepFocusInside = () => setTimeout(() => {
    const q = (sel: string) => dlgRef.current?.querySelector<HTMLElement>(sel);
    (q("#ob-next:not([disabled])") ?? q("#ob-detect:not([disabled])") ?? q("#ob-detect-again:not([disabled])") ?? q("#ob-h"))?.focus();
  }, 0);
  const detect = () => {
    setDetecting(true);
    setEnginesError(null);
    getCliEngines()
      .then((r) => {
        if (!Array.isArray(r?.engines) || typeof r.spawnEngine !== "string") throw new Error("bad shape");
        setEngines(r);
        keepFocusInside();
      })
      // The Detect button was disabled while busy, which dropped focus to <body>.
      .catch((e) => { setEnginesError(errorOf(e)); keepFocusInside(); })
      .finally(() => setDetecting(false));
  };
  const detected = engines;
  const spawnFound = !!detected?.engines.find((e) => e.id === detected.spawnEngine)?.found;
  // Account: the choice, and the plan's outcome once the runtime confirmed it.
  const [acct, setAcct] = useState<"subscription" | "later">("subscription");
  const [acctError, setAcctError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const runAccount = async (): Promise<boolean> => {
    setAcctError(null);
    if (acct === "later") return true;
    try {
      const list = await getAccounts();
      if (!Array.isArray(list?.accounts)) throw new Error("bad shape");
      const plan = accountPlan(list);
      let id = plan.kind === "create" ? null : plan.id;
      if (plan.kind === "create") {
        const made = await addAccount({ providerType: "claude", authMethod: "subscription", label: "Claude subscription" });
        if (made.error || !made.account) { setAcctError(made.error ?? NO_ANSWER); return false; }
        id = made.account.id;
      }
      if (plan.kind !== "confirm" && id) {
        const act = await setActiveAccount(id);
        if (act.error) { setAcctError(act.error); return false; }
      }
      return true;
    } catch (e) {
      setAcctError(errorOf(e));
      return false;
    }
  };
  // Project: the typed folder; the rule error; the runtime's error; what the runtime saved.
  const [folder, setFolder] = useState("");
  const [folderBad, setFolderBad] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);
  // `typed` is what was sent (the "already saved" check); `path` is what the server saved (its realpath).
  const [saved, setSaved] = useState<{ typed: string; path: string; status: ProjectStatus } | null>(null);
  const runProject = async (): Promise<boolean> => {
    const path = folder.trim();
    if (saved && saved.typed === path) return true; // already saved; this Next only advances
    setProjectError(null);
    if (!folderOk(path)) { setFolderBad(true); dlgRef.current?.querySelector<HTMLInputElement>("#ob-folder")?.focus(); return false; }
    setFolderBad(false);
    try {
      const r = await setWorkspace(path);
      if (!r.ok) { setProjectError(r.error ?? NO_ANSWER); return false; }
      const status: ProjectStatus = r.envPinned ? "pinned" : r.restartRequired ? "pending" : "active";
      setSaved({ typed: path, path: r.repoPath ?? path, status });
      return status === "active"; // a pending restart or an env pin is said on this step before moving on
    } catch (e) {
      setProjectError(errorOf(e));
      return false;
    }
  };
  const dlgRef = useRef<HTMLDivElement | null>(null);

  const steps: Step[] = [
    {
      title: "Welcome",
      body: <p>Your team of AI agents runs on this machine. You approve two things: <b>designs</b> and <b>ships</b>. Everything else, the team does.</p>,
      canNext: true,
    },
    {
      title: "Engines",
      body: (
        <>
          <p>The team needs a CLI engine to think with.</p>
          {detected ? (
            <ul className="list">
              {detected.engines.map((e) => (
                <li key={e.id} className="feed-row" style={ROW_STYLE}>
                  <span className={e.found ? "dot ok" : "dot muted"} />
                  <span>{`${e.label} · ${e.found ? "found" : "not found"}${e.id === detected.spawnEngine ? "" : " · optional"}`}</span>
                </li>
              ))}
            </ul>
          ) : (
            <button className="btn btn-primary" type="button" id="ob-detect" disabled={detecting} onClick={detect}>{detecting ? "Detecting…" : "Detect engines"}</button>
          )}
          {enginesError && <p className="sub" role="alert" style={{ color: "var(--bad-ink)", margin: "8px 0 0" }}>{enginesError}</p>}
          {detected && !spawnFound && (
            <>
              <p className="sub" role="status" style={{ margin: "8px 0 0" }}>{`The team runs on ${detected.spawnEngine}; install it, then detect again. You can close setup and come back from ⌘K.`}</p>
              <button className="btn btn-ghost" type="button" id="ob-detect-again" style={{ marginTop: 8 }} disabled={detecting} onClick={detect}>{detecting ? "Detecting…" : "Detect again"}</button>
            </>
          )}
        </>
      ),
      canNext: spawnFound,
    },
    {
      title: "Account",
      body: (
        <>
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="sr">How the team signs in</legend>
            {([["subscription", "Use my Claude subscription", "Recommended. Nothing to paste."], ["later", "Add an API key later", "You can add one in Accounts."]] as const).map(([k, t, d]) => (
              <label key={k} className="check" style={{ alignItems: "flex-start", border: "1px solid var(--hair)", borderRadius: 8, padding: 12, marginBottom: 8 }}>
                <input type="radio" name="ob-acct" value={k} checked={acct === k} onChange={() => { setAcct(k); setAcctError(null); }} />
                <span><b>{t}</b><span className="sub" style={{ display: "block", textTransform: "none", letterSpacing: ".02em" }}>{d}</span></span>
              </label>
            ))}
          </fieldset>
          {acctError && <p className="sub" role="alert" style={{ color: "var(--bad-ink)", margin: "4px 0 0" }}>{acctError}</p>}
        </>
      ),
      canNext: !busy,
      onNext: runAccount,
    },
    {
      title: "Project",
      body: (
        <div className="field">
          <label className="label" htmlFor="ob-folder">Project folder</label>
          <input id="ob-folder" value={folder} placeholder="~/code/my-app" aria-describedby={folderBad ? "ob-folder-err" : undefined} autoComplete="off" aria-invalid={folderBad || undefined}
            onChange={(e) => { setFolder(e.target.value); setFolderBad(false); setProjectError(null); }} />
          <p className="sub" id="ob-folder-err" hidden={!folderBad} style={{ color: "var(--bad-ink)", margin: "4px 0 0" }}>Start with / or ~ , a full path to a folder.</p>
          {projectError && <p className="sub" role="alert" style={{ color: "var(--bad-ink)", margin: "4px 0 0" }}>{projectError}</p>}
          {saved && saved.typed === folder.trim() && saved.status !== "active" && (
            <p className="sub" role="status" style={{ margin: "4px 0 0" }}>
              {saved.status === "pinned" ? "The runtime's folder is pinned by its environment, so this choice will not apply." : "Saved. Takes effect after a runtime restart."}
            </p>
          )}
        </div>
      ),
      canNext: !busy,
      onNext: runProject,
    },
    {
      title: "Ready",
      body: (
        <>
          <ul className="list">
            {saved && detected && readyLines({
              engine: detected.engines.find((e) => e.id === detected.spawnEngine)?.label ?? detected.spawnEngine,
              account: acct,
              project: { path: saved.path, status: saved.status },
              stations,
            }).map((l) => <li key={l.text}>{`${l.confirmed ? "✓" : "·"} ${l.text}`}</li>)}
          </ul>
          <p className="sub" style={{ textTransform: "none", letterSpacing: ".02em" }}>Start a job from Missions: tell the Tech Lead what you want.</p>
        </>
      ),
      canNext: true,
      onNext: async () => { onDone(); return false; },
    },
  ];
  const last = steps.length - 1;
  const cur = steps[Math.min(step, last)];

  // Open: start at step 1 and focus the step's first control.
  useEffect(() => {
    if (open) setStep(0);
  }, [open]);
  // Each step: focus its first control, or Next (the mockup's renderOb + focus).
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => (dlgRef.current?.querySelector<HTMLElement>("#ob-body input, #ob-body button:not([disabled]), #ob-next"))?.focus(), 0);
    return () => clearTimeout(t);
  }, [open, step]);
  useEffect(() => {
    if (open) return;
    const el = returnFocus.current as HTMLElement | null;
    if (el?.isConnected) el.focus();
  }, [open, returnFocus]);

  const goNext = async () => {
    if (cur.onNext) {
      setBusy(true);
      const ok = await cur.onNext();
      setBusy(false);
      // Next was disabled while busy, which drops focus to <body>; put it back in the dialog.
      if (document.activeElement === document.body) setTimeout(() => dlgRef.current?.querySelector<HTMLElement>("#ob-next")?.focus(), 0);
      if (!ok) return;
    }
    setStep((n) => Math.min(last, n + 1));
  };

  // Esc closes from anywhere while open — focus can land outside when a control unmounts.
  useEffect(() => {
    if (!open) return;
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    document.addEventListener("keydown", onEsc);
    return () => document.removeEventListener("keydown", onEsc);
  }, [open, onClose]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab" || !dlgRef.current) return;
    // A radio group is one Tab stop: only its checked radio is in the cycle.
    const els = [...dlgRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
      .filter((el) => el.offsetParent !== null || el === document.activeElement)
      .filter((el) => !(el instanceof HTMLInputElement && el.type === "radio" && !el.checked));
    if (els.length === 0) return;
    const i = els.indexOf(document.activeElement as HTMLElement);
    const nextIdx = e.shiftKey ? (i <= 0 ? els.length - 1 : i - 1) : (i === els.length - 1 ? 0 : i + 1);
    e.preventDefault();
    els[nextIdx].focus();
  };

  return (
    <>
      <div className="scrim" hidden={!open} onClick={onClose} aria-hidden="true" />
      <div className="ob" role="dialog" aria-modal="true" aria-labelledby="ob-h" aria-describedby="ob-step" hidden={!open} ref={dlgRef} onKeyDown={onKeyDown}>
        <button type="button" className="ma-skip-link" onClick={onClose}>Close setup</button>
        <p className="sub" id="ob-step" style={{ margin: 0 }}>{`Setup · step ${step + 1} of 5`}</p>
        <h2 id="ob-h" tabIndex={-1} style={{ fontFamily: "var(--font-display)", fontWeight: 400, fontSize: "2.6rem", letterSpacing: ".04em", color: "var(--brand)", margin: "6px 0 12px", lineHeight: 1 }}>{cur.title}</h2>
        <div id="ob-body">{cur.body}</div>
        <div className="row" style={{ marginTop: 20, justifyContent: "space-between" }}>
          {/* The mockup draws Back on every step (its `hidden` loses to `.btn`); on step 1 it leaves setup — never a dead control. */}
          <button className="btn btn-ghost" type="button" id="ob-back" disabled={busy} onClick={() => (step === 0 ? onClose() : setStep((n) => n - 1))}>Back</button>
          <button className="btn btn-primary" type="button" id="ob-next" disabled={!cur.canNext || busy} onClick={() => void goNext()}>{step === last ? "Open the cockpit" : "Next"}</button>
        </div>
        <div className="ob-dots" aria-hidden="true">
          {[0, 1, 2, 3, 4].map((n) => <i key={n} className={n <= step ? "on" : ""} />)}
        </div>
      </div>
    </>
  );
}
