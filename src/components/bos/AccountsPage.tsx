// Multi-Provider Credentials — the Accounts page (nav id `accounts`, its own left-sidebar
// tab, NOT a Settings section). The GENERIC multi-account surface: add UNLIMITED accounts
// of ANY provider type, pick which one the swarm runs on.
//
// Phase G (ADR G-2): the approved mockup's `data-page="accounts"` — the CLI engines card,
// a `.grid2` of the Add account form and the Chat model card, then one `.acct` per account
// (Active / Set active · Probe · Edit · Remove).
//
// LAZY BY CONSTRUCTION: App imports this with React.lazy, so the form and the client stay
// out of the main index chunk (hard gzip ceiling).
//
// CONTRACT: the token-gated /runtime/accounts/* routes via lib/accounts.ts. No response ever
// carries a secret — `hasSecret` is the only "a key is stored" signal, so an account card
// says "API key" and never shows any part of one. A typed key lives only in a password
// input with autocomplete off, and is sent once.
//
// PHASE 1 / PRINCIPLE 0 — what a card says about the engine is a MEASUREMENT (did this model
// return a well-formed tool call when it was given one), taken by the Probe control on the
// card. Three states, because "never measured" is its own answer. Claude drives the engine
// through the CLI, so there is no endpoint to probe: its Probe is drawn disabled and says why.
//
// P1-D — each card also states whether the executor's DOLLAR CEILING can bind this account.
// That sentence and the probe's reason come from the runtime; neither is recomputed here.
//
// Container/presentational: this page owns the mount fetch, the refetch after every mutation,
// the unmount guard and the notice surfacing.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatModelPicker } from "./ChatModelPicker";
import { BosTopbar } from "./BosTopbar";
import {
  getAccounts,
  addAccount,
  updateAccount,
  removeAccount,
  setActiveAccount,
  probeAccount,
  engineStanding,
  engineStandingLabel,
  type Account,
  type AccountPatch,
  type AccountsResponse,
  type AddAccountBody,
  type AuthMethod,
  type Preset,
  type ProviderType,
  getCliEngines,
  type CliEnginesResponse,
} from "../../lib/accounts";

const GHOST = { minHeight: 36, padding: "8px 14px" } as const;

// ── the add-account form (always open, as the mockup draws it) ───────────────
function AddAccountForm({ presets, busy, error, onSubmit }: {
  presets: Preset[];
  busy: boolean;
  error: string | null;
  onSubmit: (body: AddAccountBody) => Promise<boolean>;
}) {
  const [type, setType] = useState<ProviderType>(presets[0]?.type ?? "claude");
  const [label, setLabel] = useState("");
  const [authMethod, setAuthMethod] = useState<AuthMethod>("subscription");
  const [secret, setSecret] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [identifier, setIdentifier] = useState("");
  const [model, setModel] = useState("");
  const [invalid, setInvalid] = useState<string | null>(null);

  const preset = useMemo(() => presets.find((p) => p.type === type), [presets, type]);
  const offersSubscription = !!preset?.authMethods.includes("subscription");
  // A type without a subscription mode is api_key-only — keep authMethod honest.
  const effectiveAuth: AuthMethod = offersSubscription ? authMethod : "api_key";
  const needsBaseUrl = !!preset?.needsBaseUrl;
  const needsSecret = effectiveAuth === "api_key";
  // The chat model id is meaningful only on the OpenAI-compatible path (custom/openai).
  const showModel = type === "custom" || type === "openai";

  // Validated on submit with a sentence (the mockup's pattern), not by a button that sits
  // disabled without saying why.
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const why = !label.trim() ? "Give the account a label."
      : needsSecret && !secret.trim() ? "Paste the API key."
      : needsBaseUrl && !/^https?:\/\//i.test(baseUrl.trim()) ? "The base URL starts with http:// or https://."
      : null;
    setInvalid(why);
    if (why) return;
    const body: AddAccountBody = { providerType: type, label: label.trim(), authMethod: effectiveAuth };
    if (needsSecret) body.secret = secret.trim();
    if (needsBaseUrl) body.baseUrl = baseUrl.trim();
    if (identifier.trim()) body.identifier = identifier.trim();
    if (showModel && model.trim()) body.model = model.trim();
    if (await onSubmit(body)) { setLabel(""); setSecret(""); setBaseUrl(""); setIdentifier(""); setModel(""); }
  };

  const shown = invalid ?? error;
  return (
    <form className="card stack" noValidate style={{ gap: 12 }} onSubmit={(e) => void submit(e)}>
      <div className="card-h" style={{ margin: 0 }}><h2>Add account</h2></div>
      <div className="form-grid">
        <div className="field">
          <label className="label" htmlFor="ac-prov">Provider</label>
          {/* A key typed for one provider is never carried to another (or to a custom base URL). */}
          <select id="ac-prov" value={type} onChange={(e) => { const t = e.target.value as ProviderType; setType(t); setSecret(""); setAuthMethod(presets.find((p) => p.type === t)?.authMethods.includes("subscription") ? "subscription" : "api_key"); }}>
            {presets.map((p) => <option key={p.type} value={p.type}>{p.label}</option>)}
          </select>
        </div>
        <div className="field">
          <label className="label" htmlFor="ac-label">Label</label>
          <input id="ac-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Work, Personal…" maxLength={80} autoComplete="off" />
        </div>
      </div>
      {preset && (
        <p className="hint" data-app-only="provider-note" style={{ margin: 0 }}>
          {preset.type === "claude"
            ? "Runs the autonomous engine through the Claude CLI: file edits, git, tests, real deliveries."
            : "Any model that can call tools runs the autonomous engine. Connect the account, then probe it to confirm."}
        </p>
      )}
      {offersSubscription && (
        <div className="seg" aria-label="How it signs in">
          {(["subscription", "api_key"] as const).map((m) => (
            <button key={m} type="button" aria-pressed={effectiveAuth === m} onClick={() => { setAuthMethod(m); if (m === "subscription") setSecret(""); }}>{m === "subscription" ? "Subscription" : "API key"}</button>
          ))}
        </div>
      )}
      {needsBaseUrl && (
        <div className="field">
          <label className="label" htmlFor="ac-url">Base URL</label>
          <input id="ac-url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://llm.internal/v1" autoComplete="off" spellCheck={false} />
        </div>
      )}
      {showModel && (
        <div className="field">
          <label className="label" htmlFor="ac-model">Model</label>
          <input id="ac-model" value={model} onChange={(e) => setModel(e.target.value)} placeholder="nvidia/llama-3.1-nemotron-70b-instruct:free" maxLength={128} autoComplete="off" spellCheck={false} aria-describedby="ac-model-hint" />
          <p className="hint" id="ac-model-hint" style={{ margin: 0 }}>Chat on this provider needs the model id from your provider (e.g. OpenRouter).</p>
        </div>
      )}
      {/* Always on screen, as the mockup draws it; pasting a key switches the sign-in method to
          API key, so a typed key is never silently ignored by a subscription account. */}
      <div className="field">
        <label className="label" htmlFor="ac-key">API key</label>
        <input id="ac-key" type="password" value={secret} autoComplete="off" spellCheck={false} placeholder="sk-…" aria-describedby="ac-key-hint"
          onChange={(e) => { setSecret(e.target.value); if (e.target.value) setAuthMethod("api_key"); }} />
        <p className="sub" id="ac-key-hint" style={{ margin: "4px 0 0" }}>
          {needsSecret ? "Stored 0600 outside the repo, encrypted, never written to the tree. Probe-verified before saving where the provider supports it."
            : "A subscription signs in through the Claude CLI and needs no key. Paste one to add an API-key account instead."}
        </p>
      </div>
      <div className="field" data-app-only="identifier">
        <label className="label" htmlFor="ac-ident">Identifier (optional)</label>
        <input id="ac-ident" value={identifier} onChange={(e) => setIdentifier(e.target.value)} placeholder="me@team.co" autoComplete="off" />
      </div>
      {shown && <p className="sub" role="alert" style={{ color: "var(--bad-ink)", margin: 0 }}>{shown}</p>}
      <div className="row"><button className="btn btn-primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Add account"}</button></div>
    </form>
  );
}

// ── inline edit (Phase 1): label, model (custom/openai), base URL (custom), an OPTIONAL
// replacement token. providerType is absent by design: the runtime rejects a type change.
// The token field is empty by default and its emptiness means "keep the current token".
function EditAccountForm({ account, busy, error, onCancel, onSave }: {
  account: Account;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: (patch: AccountPatch) => void;
}) {
  const [label, setLabel] = useState(account.label);
  const [model, setModel] = useState(account.model ?? "");
  const [baseUrl, setBaseUrl] = useState(account.baseUrl ?? "");
  const [secret, setSecret] = useState("");
  const showModel = account.providerType === "custom" || account.providerType === "openai";
  const showBaseUrl = account.providerType === "custom";
  const showSecret = account.authMethod === "api_key";

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const patch: AccountPatch = {};
    if (label.trim() && label.trim() !== account.label) patch.label = label.trim();
    // "" clears the model; the client forwards null. Only send when it actually changed.
    if (showModel && model.trim() !== (account.model ?? "")) patch.model = model.trim() || null;
    if (showBaseUrl && baseUrl.trim() && baseUrl.trim() !== (account.baseUrl ?? "")) patch.baseUrl = baseUrl.trim();
    if (showSecret && secret) patch.secret = secret;
    onSave(patch);
  };

  return (
    <form className="card stack" onSubmit={submit} style={{ gap: 12, marginTop: 8 }} aria-label={`Edit ${account.label}`}>
      <div className="form-grid">
        <div className="field"><label className="label" htmlFor={`lbl-${account.id}`}>Label</label><input id={`lbl-${account.id}`} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} /></div>
        {showModel && <div className="field"><label className="label" htmlFor={`mdl-${account.id}`}>Model id</label><input id={`mdl-${account.id}`} value={model} onChange={(e) => setModel(e.target.value)} maxLength={128} placeholder="nvidia/nemotron-nano-9b-v2:free" /></div>}
      </div>
      {showBaseUrl && <div className="field"><label className="label" htmlFor={`url-${account.id}`}>Base URL</label><input id={`url-${account.id}`} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://openrouter.ai/api/v1/chat/completions" /></div>}
      {showSecret && (
        <div className="field">
          <label className="label" htmlFor={`sec-${account.id}`}>Replace API key</label>
          <input id={`sec-${account.id}`} type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="leave blank to keep the current key" />
          <p className="hint" style={{ margin: 0 }}>Blank keeps the key you already stored. A new one is sealed the same way: encrypted, 0600, outside the repo, never shown again.</p>
        </div>
      )}
      {error && <p className="sub" role="alert" style={{ color: "var(--bad-ink)", margin: 0 }}>{error}</p>}
      <div className="row">
        <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Save changes"}</button>
        <button className="btn btn-ghost" type="button" onClick={onCancel} disabled={busy} style={GHOST}>Cancel</button>
      </div>
    </form>
  );
}

// ── one account card ─────────────────────────────────────────────────────────
function AccountCard({ account, typeLabel, active, onlyAccount, busy, probing, editing, editError, onToggleEdit, onSave, onSetActive, onRemove, onProbe }: {
  account: Account;
  typeLabel: string;
  active: boolean;
  /** The only account can always be removed (the runtime clears the active id), so a leaked key can be revoked. */
  onlyAccount: boolean;
  busy: boolean;
  probing: boolean;
  editing: boolean;
  editError: string | null;
  onToggleEdit: () => void;
  onSave: (patch: AccountPatch) => void;
  onSetActive: () => void;
  onRemove: () => void;
  onProbe: () => void;
}) {
  // The measurement, against the account's CURRENT model (a probe of another model is not one).
  const standing = engineStanding(account);
  const isClaude = account.providerType === "claude";
  const probeWhy = isClaude ? "Claude runs the engine through the Claude CLI; there is no endpoint to probe"
    : !account.hasSecret ? "No key is stored for this account" : "Send this model one trivial tool and record whether it calls it";
  const measured = account.toolProbe && standing !== "unmeasured" ? ` · probe ${engineStandingLabel(standing).toLowerCase()}` : "";
  return (
    <div>
      <div className={active ? "acct active" : "acct"}>
        <span className="ava" aria-hidden="true">{typeLabel.slice(0, 2).toUpperCase()}</span>
        <span>
          <b>{account.label}</b>
          <span className="sub" style={{ display: "block" }}>{`${typeLabel} · ${account.authMethod === "subscription" ? "subscription" : "API key"}${measured}`}</span>
        </span>
        <span className="row acts">
          {active ? <span className="chip solid">Active</span>
            : <button className="btn btn-ghost" type="button" style={GHOST} disabled={busy} aria-label={`Set ${account.label} active`} onClick={onSetActive}>{busy ? "Setting…" : "Set active"}</button>}
          <button className="btn btn-ghost" type="button" style={GHOST} disabled={isClaude || !account.hasSecret || busy || probing} title={probeWhy} aria-label={`Probe ${account.label}`} onClick={onProbe}>
            {probing ? "Probing…" : standing === "unmeasured" || isClaude ? "Probe" : "Re-probe"}
          </button>
          <button className="btn btn-ghost" type="button" style={GHOST} disabled={busy} aria-expanded={editing} aria-label={`Edit ${account.label}`} onClick={onToggleEdit}>Edit</button>
          <button className="btn btn-ghost" type="button" style={GHOST} disabled={busy || (active && !onlyAccount)} title={active && !onlyAccount ? "Set another account active first" : undefined} aria-label={`Remove ${account.label}`} onClick={onRemove}>Remove</button>
        </span>
      </div>
      {/* The measurement in the operator's terms, and what it means for the $ ceiling —
          both sentences the RUNTIME produced (toolProbe.reason, spendCap). */}
      <p className="sub" data-app-only="standing" style={{ margin: "6px 4px 0" }}>
        <b>{engineStandingLabel(standing)}</b>
        {isClaude ? ": Claude accounts drive the engine through the Claude CLI, not an HTTP endpoint."
          : standing === "unmeasured"
            ? account.toolProbe ? ": the model changed since the last probe. Re-probe to confirm this one can call tools."
              : ": nobody has asked this model whether it can call a tool yet. Probe to find out."
            : account.toolProbe?.reason ? `: ${account.toolProbe.reason}.` : "."}
        {account.spendCap && <>{" "}{account.spendCap}</>}
      </p>
      {editing && <EditAccountForm account={account} busy={busy} error={editError} onCancel={onToggleEdit} onSave={onSave} />}
    </div>
  );
}

// ── MUNDER-ADOPTION A1 — the CLI engines card: PATH-detected terminal coding agents
// (GET /runtime/engines). A READOUT, not a switch; nothing here executes anything.
function CliEngines() {
  const [resp, setResp] = useState<CliEnginesResponse | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    getCliEngines()
      .then((r) => { if (live) setResp(r); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);
  return (
    <div className="card">
      <div className="card-h"><h2>CLI engines</h2><span className="sub">{resp ? `detected on this machine · dispatch runs the ${resp.spawnEngine} CLI` : "detected on this machine"}</span></div>
      {failed ? <div className="empty-note">The runtime did not answer.</div>
        : !resp ? <div className="empty-note" role="status">Looking on this machine…</div>
        : (
          <div className="engines">
            {resp.engines.map((e) => (
              <span key={e.id} className={e.found ? "chip ok" : "chip"} title={e.found ? `${e.label}: ${e.path}` : `${e.label}: not on PATH${e.installCommand ? ` · install: ${e.installCommand}` : ""}`}>
                <span className={e.found ? "dot ok" : "dot muted"} />{`${e.label} · ${e.found ? "found" : "not found"}`}
              </span>
            ))}
          </div>
        )}
    </div>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────
type Notice = { tone: "warn" | "error" | "ok"; text: string };

export function AccountsPage() {
  const [resp, setResp] = useState<AccountsResponse | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [probingId, setProbingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [chatNonce, setChatNonce] = useState(0);
  const liveRef = useRef(true);

  const load = useCallback(async () => {
    try {
      const r = await getAccounts();
      if (!liveRef.current) return;
      setResp(r);
      setStatus("ready");
      setChatNonce((n) => n + 1); // the chat choices are accounts too
    } catch (e: unknown) {
      if (!liveRef.current) return;
      setLoadError(e instanceof Error ? e.message : "Runtime unreachable");
      setStatus("error");
    }
  }, []);

  // Mount fetch, unmount-guarded (mirrors PreflightGate's `live` flag).
  useEffect(() => {
    liveRef.current = true;
    void load();
    return () => { liveRef.current = false; };
  }, [load]);

  const submit = useCallback(async (body: AddAccountBody): Promise<boolean> => {
    setAdding(true);
    setFormError(null);
    try {
      const r = await addAccount(body);
      if (r.error) { setFormError(r.error); return false; }
      setNotice({ tone: "ok", text: `Added “${body.label}”.` });
      await load();
      return true;
    } catch (e: unknown) {
      setFormError(e instanceof Error ? e.message : "Could not add the account");
      return false;
    } finally {
      setAdding(false);
    }
  }, [load]);

  // One mutation runner: busy flag, notice on error, authoritative refetch.
  const mutate = useCallback(async (id: string, run: () => Promise<{ error?: string; warning?: string }>) => {
    setBusyId(id);
    setNotice(null);
    try {
      const r = await run();
      if (r.error) { setNotice({ tone: "error", text: r.error }); return; }
      if (r.warning) setNotice({ tone: "warn", text: r.warning });
      await load();
    } catch (e: unknown) {
      setNotice({ tone: "error", text: e instanceof Error ? e.message : "The runtime did not answer" });
    } finally {
      setBusyId(null);
    }
  }, [load]);

  // One edit at a time — the page never holds two half-finished credential edits.
  const toggleEdit = useCallback((id: string) => { setEditError(null); setEditingId((cur) => (cur === id ? null : id)); }, []);
  const saveEdit = useCallback(async (id: string, patch: AccountPatch) => {
    if (Object.keys(patch).length === 0) { setEditingId(null); setEditError(null); return; }
    setBusyId(id);
    setEditError(null);
    setNotice(null);
    try {
      const r = await updateAccount(id, patch);
      if (r.error) { setEditError(r.error); return; }
      setEditingId(null);
      setNotice({ tone: "ok", text: "Account updated." });
      await load();
    } catch (e: unknown) {
      setEditError(e instanceof Error ? e.message : "Could not save changes");
    } finally {
      setBusyId(null);
    }
  }, [load]);

  // PHASE 1 TASK 1.3 — the capability MEASUREMENT. A real request that costs a few tokens,
  // so an explicit operator action; a negative verdict is said as plainly as a positive one.
  const probe = useCallback(async (id: string) => {
    setProbingId(id);
    setNotice(null);
    try {
      const r = await probeAccount(id);
      if (r.error) { setNotice({ tone: "error", text: r.error }); return; }
      const p = r.probe;
      if (p) {
        setNotice({
          tone: p.capable ? "ok" : "warn",
          text: p.capable
            ? `Measured: this model can call tools (${p.reason ?? "well-formed tool call"}). It runs the autonomous engine.`
            : `Measured: this model did not call the tool it was given (${p.reason ?? "no reason recorded"}). The engine cannot dispatch to it.`,
        });
      }
      await load();
    } catch (e: unknown) {
      setNotice({ tone: "error", text: e instanceof Error ? e.message : "Could not run the probe" });
    } finally {
      setProbingId(null);
    }
  }, [load]);

  const accounts = resp?.accounts ?? [];
  const presets = useMemo<Preset[]>(() => resp?.providerTypes ?? [], [resp]);
  const typeLabel = useCallback((t: ProviderType) => presets.find((p) => p.type === t)?.label ?? t, [presets]);
  const unmeasured = accounts.filter((a) => engineStanding(a) === "unmeasured");

  return (
    <section className="page" aria-labelledby="h-accounts">
      {/* Credentials are machine-wide, so the scope is every venture whatever the switcher says. */}
      <BosTopbar eyebrow="Accounts · All ventures" title="Accounts" tagline="how the team signs in" headingId="h-accounts" clock />
      <div className="stack">
        <CliEngines />
        {status === "loading" && <div className="empty-note" role="status">Reading the accounts…</div>}
        {status === "error" && (
          <div className="empty-note"><span className="script">Not reachable.</span><br />{`${loadError ?? "The runtime did not answer."} `}<button type="button" className="linkish" onClick={() => { setStatus("loading"); void load(); }}>Retry</button></div>
        )}
        {status === "ready" && (
          <>
            <div className="grid2">
              <AddAccountForm presets={presets} busy={adding} error={formError} onSubmit={submit} />
              {/* Which LLM answers CHAT — separate from the ACTIVE account (which drives the
                  engine) on purpose: one key can be right for one job and wrong for the other. */}
              <ChatModelPicker nonce={chatNonce} />
            </div>
            {notice && (
              <p className="sub" role={notice.tone === "error" ? "alert" : "status"} style={{ margin: 0, color: notice.tone === "error" ? "var(--bad-ink)" : notice.tone === "warn" ? "var(--warn-ink)" : undefined }}>
                {notice.text}{" "}<button type="button" className="linkish" onClick={() => setNotice(null)}>Dismiss</button>
              </p>
            )}
            <div className="stack" style={{ gap: 10 }}>
              {accounts.length === 0 ? (
                <div className="empty-note"><span className="script">No accounts yet.</span><br />Add a Claude account to run the swarm, or any other LLM to keep on hand for chat.</div>
              ) : accounts.map((a) => (
                <AccountCard
                  key={a.id}
                  account={a}
                  typeLabel={typeLabel(a.providerType)}
                  active={resp?.activeAccountId === a.id}
                  onlyAccount={accounts.length === 1}
                  busy={busyId === a.id}
                  probing={probingId === a.id}
                  editing={editingId === a.id}
                  editError={editingId === a.id ? editError : null}
                  onToggleEdit={() => toggleEdit(a.id)}
                  onSave={(patch) => void saveEdit(a.id, patch)}
                  onSetActive={() => void mutate(a.id, () => setActiveAccount(a.id))}
                  onRemove={() => void mutate(a.id, () => removeAccount(a.id))}
                  onProbe={() => void probe(a.id)}
                />
              ))}
              {unmeasured.length > 0 && (
                <p className="sub" data-app-only="unmeasured" style={{ margin: 0 }}>
                  {`${unmeasured.length === 1 ? "One account has" : `${unmeasured.length} accounts have`} not been measured for tool support. Any model that can call tools runs the autonomous engine; probe to find out which of yours can.`}
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
