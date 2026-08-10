// Multi-Provider Credentials — the Accounts page (nav id `accounts`, its own
// left-sidebar tab, NOT a Settings section). The GENERIC multi-account surface:
// add UNLIMITED accounts of ANY provider type, pick which one the swarm runs on.
//
// LAZY BY CONSTRUCTION: App imports this with React.lazy, so the form, the motion
// and the client stay out of the main index chunk (hard gzip ceiling).
//
// CONTRACT: the token-gated /runtime/accounts/* routes via lib/accounts.ts. No
// response ever carries a secret — `hasSecret` is the only "a key is stored" signal.
// The engine only runs on Claude accounts (capability "swarm"); every other type is
// stored honestly as "chat_only" — saved for chat / future use, never faked as more.
//
// Container/presentational: this page owns the mount fetch, the optimistic refetch on
// every mutation, the unmount guard (mirrors PreflightGate's `live` flag) and the
// notice/error surfacing. Children stay dumb.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { KeyRound, Loader2, Plus, ShieldCheck, Trash2, Lock, X } from "lucide-react";
import { tok } from "../../lib/agentMeta";
import { BosTopbar } from "./BosTopbar";
import {
  getAccounts,
  addAccount,
  removeAccount,
  setActiveAccount,
  capabilityLabel,
  type Account,
  type AccountsResponse,
  type AddAccountBody,
  type AuthMethod,
  type Capability,
  type Preset,
  type ProviderType,
} from "../../lib/accounts";

// One-letter provider glyph — a deterministic mark, never a fetched logo.
const GLYPH: Record<ProviderType, string> = {
  claude: "C",
  openai: "O",
  minimax: "M",
  zai: "Z",
  custom: "◇",
};

// Capability drives the accent semantically: swarm = gold (runs the engine),
// chat_only = violet (stored for chat/future). No decorative-only color.
const capTone = (c: Capability): string => (c === "swarm" ? tok("ceo-gold") : tok("factory-violet"));

function CapabilityBadge({ capability }: { capability: Capability }) {
  const tone = capTone(capability);
  return (
    <span
      className="rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.04em]"
      style={{ color: tone, backgroundColor: `color-mix(in oklch, ${tone} 12%, transparent)`, border: `1px solid color-mix(in oklch, ${tone} 28%, transparent)` }}
    >
      {capabilityLabel(capability)}
    </span>
  );
}

function ProviderMark({ type, capability }: { type: ProviderType; capability: Capability }) {
  const tone = capTone(capability);
  return (
    <span
      aria-hidden
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-[15px] font-extrabold"
      style={{ color: tone, backgroundColor: `color-mix(in oklch, ${tone} 14%, transparent)`, border: `1px solid color-mix(in oklch, ${tone} 26%, transparent)` }}
    >
      {GLYPH[type]}
    </span>
  );
}

// ── the add-account form (inline, motion-expanded) ───────────────────────────
function AddAccountForm({
  presets,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  presets: Preset[];
  busy: boolean;
  error: string | null;
  onSubmit: (body: AddAccountBody) => void;
  onCancel: () => void;
}) {
  const [type, setType] = useState<ProviderType>(presets[0]?.type ?? "claude");
  const [label, setLabel] = useState("");
  const [authMethod, setAuthMethod] = useState<AuthMethod>("subscription");
  const [secret, setSecret] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [identifier, setIdentifier] = useState("");
  const [model, setModel] = useState("");

  const preset = useMemo(() => presets.find((p) => p.type === type), [presets, type]);
  const offersSubscription = !!preset?.authMethods.includes("subscription");
  // A type without a subscription mode is api_key-only — keep authMethod honest.
  const effectiveAuth: AuthMethod = offersSubscription ? authMethod : "api_key";
  const needsBaseUrl = !!preset?.needsBaseUrl;
  const needsSecret = effectiveAuth === "api_key";
  // The chat model id is meaningful only on the OpenAI-compatible path (custom/openai);
  // same gate the runtime uses to persist it. Shown the same way as the baseUrl field.
  const showModel = type === "custom" || type === "openai";
  // Soft-require: an api_key custom/openai account with no model can't chat until one is
  // set — surface the hint prominently, but never hard-block (some set it later).
  const modelMissing = showModel && needsSecret && model.trim().length === 0;

  const labelOk = label.trim().length > 0;
  const secretOk = !needsSecret || secret.trim().length > 0;
  const baseUrlOk = !needsBaseUrl || /^https?:\/\//i.test(baseUrl.trim());
  const canSubmit = labelOk && secretOk && baseUrlOk && !busy;

  const submit = () => {
    if (!canSubmit) return;
    const body: AddAccountBody = { providerType: type, label: label.trim(), authMethod: effectiveAuth };
    if (needsSecret) body.secret = secret.trim();
    if (needsBaseUrl) body.baseUrl = baseUrl.trim();
    if (identifier.trim()) body.identifier = identifier.trim();
    if (showModel && model.trim()) body.model = model.trim();
    onSubmit(body);
  };

  const fieldStyle = { backgroundColor: tok("bg"), color: tok("text"), border: `1px solid ${tok("border")}` };

  return (
    <form
      className="flex flex-col gap-4 rounded-2xl p-5"
      style={{ backgroundColor: tok("panel-2"), border: `1px solid ${tok("border")}` }}
      onSubmit={(e) => { e.preventDefault(); submit(); }}
    >
      {/* provider-type picker */}
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: tok("muted") }}>Provider</span>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Provider type">
          {presets.map((p) => {
            const active = p.type === type;
            const tone = capTone(p.capability);
            return (
              <button
                key={p.type}
                type="button"
                aria-pressed={active}
                onClick={() => { setType(p.type); if (!p.authMethods.includes("subscription")) setAuthMethod("api_key"); else setAuthMethod("subscription"); }}
                className="rounded-lg px-3 py-1.5 text-[12.5px] font-semibold outline-none transition-colors focus-visible:ring-2"
                style={{
                  color: active ? tone : tok("muted"),
                  backgroundColor: active ? `color-mix(in oklch, ${tone} 12%, transparent)` : "transparent",
                  border: `1px solid ${active ? `color-mix(in oklch, ${tone} 30%, transparent)` : tok("border")}`,
                }}
              >
                {p.label}
              </button>
            );
          })}
        </div>
        {preset && (
          <p className="text-[11px]" style={{ color: tok("muted") }}>
            {preset.capability === "swarm"
              ? "Runs the autonomous engine — file edits, git, tests, real deliveries."
              : "Stored for chat & drafting — the engine runs on Claude accounts, not this one."}
          </p>
        )}
      </div>

      {/* label — always required */}
      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: tok("muted") }}>Label</span>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. Work key, Personal subscription"
          maxLength={80}
          autoComplete="off"
          aria-label="Account label"
          required
          className="rounded-lg px-3 py-2 text-[13px] outline-none focus-visible:ring-2"
          style={fieldStyle}
        />
      </label>

      {/* auth method — offered only where the provider supports more than one */}
      {offersSubscription && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: tok("muted") }}>How it signs in</span>
          <div className="flex gap-1.5" role="group" aria-label="Authentication method">
            {(["subscription", "api_key"] as AuthMethod[]).map((m) => {
              const active = effectiveAuth === m;
              return (
                <button
                  key={m}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setAuthMethod(m)}
                  className="rounded-lg px-3 py-1.5 text-[12.5px] font-semibold outline-none transition-colors focus-visible:ring-2"
                  style={{
                    color: active ? tok("accent-cyan") : tok("muted"),
                    backgroundColor: active ? `color-mix(in oklch, ${tok("accent-cyan")} 12%, transparent)` : "transparent",
                    border: `1px solid ${active ? `color-mix(in oklch, ${tok("accent-cyan")} 30%, transparent)` : tok("border")}`,
                  }}
                >
                  {m === "subscription" ? "Subscription" : "API key"}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* base URL — custom (OpenAI-compatible) only */}
      {needsBaseUrl && (
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: tok("muted") }}>Base URL</span>
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://llm.internal/v1"
            autoComplete="off"
            spellCheck={false}
            aria-label="OpenAI-compatible base URL"
            className="rounded-lg px-3 py-2 font-mono text-[12.5px] outline-none focus-visible:ring-2"
            style={fieldStyle}
          />
        </label>
      )}

      {/* model — OpenAI-compatible path (custom/openai) only; same gate the runtime persists on */}
      {showModel && (
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: tok("muted") }}>Model</span>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="nvidia/llama-3.1-nemotron-70b-instruct:free"
            maxLength={128}
            autoComplete="off"
            spellCheck={false}
            aria-label="Chat model id"
            className="rounded-lg px-3 py-2 font-mono text-[12.5px] outline-none focus-visible:ring-2"
            style={fieldStyle}
          />
          <span
            className="text-[11px]"
            style={{ color: modelMissing ? tok("blocked-amber") : tok("muted") }}
          >
            Required for chat on this provider — the model id from your provider (e.g. OpenRouter).
          </span>
        </label>
      )}

      {/* token — every api_key path; hidden for a Claude subscription */}
      <AnimatePresence initial={false}>
        {needsSecret && (
          <motion.label
            key="secret"
            className="flex flex-col gap-1.5"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            style={{ overflow: "hidden" }}
          >
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: tok("muted") }}>Token</span>
            <input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="paste the API key"
              autoComplete="off"
              spellCheck={false}
              aria-label="API token"
              className="rounded-lg px-3 py-2 font-mono text-[12.5px] outline-none focus-visible:ring-2"
              style={fieldStyle}
            />
            <span className="flex items-start gap-1.5 text-[11px]" style={{ color: tok("muted") }}>
              <Lock size={12} className="mt-0.5 shrink-0" aria-hidden />
              Stored 0600 outside the repo, encrypted, never written to the tree. Probe-verified before saving where the provider supports it.
            </span>
          </motion.label>
        )}
      </AnimatePresence>

      {/* identifier — optional */}
      <label className="flex flex-col gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em]" style={{ color: tok("muted") }}>Identifier <span className="normal-case opacity-70">(optional)</span></span>
        <input
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          placeholder="e.g. me@team.co"
          autoComplete="off"
          aria-label="Account identifier"
          className="rounded-lg px-3 py-2 text-[13px] outline-none focus-visible:ring-2"
          style={fieldStyle}
        />
      </label>

      {error && (
        <p role="alert" className="text-[12px]" style={{ color: tok("stale-red") }}>{error}</p>
      )}

      <div className="flex items-center gap-2.5">
        <button
          type="submit"
          disabled={!canSubmit}
          className="flex items-center gap-2 rounded-lg px-4 py-2 text-[13px] font-semibold outline-none transition-[filter] focus-visible:ring-2 disabled:opacity-40"
          style={{ backgroundColor: tok("ceo-gold"), color: tok("bg") }}
        >
          {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <ShieldCheck size={14} aria-hidden />}
          {busy ? "Saving…" : "Save account"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-lg px-3 py-2 text-[13px] outline-none transition-colors focus-visible:ring-2 disabled:opacity-40"
          style={{ color: tok("muted"), border: `1px solid ${tok("border")}` }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ── one account row ──────────────────────────────────────────────────────────
function AccountRow({
  account,
  typeLabel,
  active,
  busy,
  onSetActive,
  onRemove,
}: {
  account: Account;
  typeLabel: string;
  active: boolean;
  busy: boolean;
  onSetActive: () => void;
  onRemove: () => void;
}) {
  return (
    <div
      className="flex items-center gap-3.5 rounded-xl px-4 py-3.5"
      style={{
        backgroundColor: tok("panel"),
        border: `1px solid ${active ? `color-mix(in oklch, ${tok("done-green")} 34%, transparent)` : tok("border")}`,
      }}
    >
      <ProviderMark type={account.providerType} capability={account.capability} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-[14px] font-bold" style={{ color: tok("text") }}>{account.label}</span>
          <CapabilityBadge capability={account.capability} />
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11.5px]" style={{ color: tok("muted") }}>
          <span>{typeLabel}</span>
          <span aria-hidden>·</span>
          <span>{account.authMethod === "subscription" ? "Subscription" : "API key"}</span>
          {account.identifier && (<><span aria-hidden>·</span><span className="truncate font-mono">{account.identifier}</span></>)}
          {account.baseUrl && (<><span aria-hidden>·</span><span className="truncate font-mono">{account.baseUrl}</span></>)}
          {account.model && (<><span aria-hidden>·</span><span className="truncate font-mono">{account.model}</span></>)}
        </div>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        {active ? (
          <span
            className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-bold"
            style={{ color: tok("done-green"), backgroundColor: `color-mix(in oklch, ${tok("done-green")} 12%, transparent)`, border: `1px solid color-mix(in oklch, ${tok("done-green")} 30%, transparent)` }}
          >
            <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: tok("done-green"), boxShadow: `0 0 8px ${tok("done-green")}` }} aria-hidden />
            Active
          </span>
        ) : (
          <button
            type="button"
            onClick={onSetActive}
            disabled={busy}
            className="rounded-md px-3 py-1.5 text-[12px] font-semibold outline-none transition-colors focus-visible:ring-2 disabled:opacity-40"
            style={{ color: tok("accent-cyan"), border: `1px solid color-mix(in oklch, ${tok("accent-cyan")} 30%, transparent)` }}
          >
            {busy ? <Loader2 size={12} className="animate-spin" aria-hidden /> : "Set active"}
          </button>
        )}
        <button
          type="button"
          onClick={onRemove}
          disabled={busy}
          aria-label={`Remove ${account.label}`}
          title="Remove"
          className="rounded-md p-1.5 outline-none transition-colors focus-visible:ring-2 disabled:opacity-40"
          style={{ color: tok("stale-red") }}
        >
          <Trash2 size={15} aria-hidden />
        </button>
      </div>
    </div>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────
type Notice = { tone: "warn" | "error" | "ok"; text: string };

export function AccountsPage() {
  const reduce = useReducedMotion();
  const [resp, setResp] = useState<AccountsResponse | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const liveRef = useRef(true);

  const load = useCallback(async () => {
    try {
      const r = await getAccounts();
      if (!liveRef.current) return;
      setResp(r);
      setStatus("ready");
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

  const submit = useCallback(async (body: AddAccountBody) => {
    setAdding(true);
    setFormError(null);
    try {
      const r = await addAccount(body);
      if (r.error) { setFormError(r.error); return; }
      setFormOpen(false);
      setNotice({ tone: "ok", text: `Added “${body.label}”.` });
      await load(); // optimistic-refetch to authoritative state
    } catch (e: unknown) {
      setFormError(e instanceof Error ? e.message : "Could not add the account");
    } finally {
      setAdding(false);
    }
  }, [load]);

  const activate = useCallback(async (id: string) => {
    setBusyId(id);
    setNotice(null);
    try {
      const r = await setActiveAccount(id);
      if (r.error) { setNotice({ tone: "error", text: r.error }); return; }
      if (r.warning) setNotice({ tone: "warn", text: r.warning });
      await load();
    } catch (e: unknown) {
      setNotice({ tone: "error", text: e instanceof Error ? e.message : "Could not set active" });
    } finally {
      setBusyId(null);
    }
  }, [load]);

  const remove = useCallback(async (id: string) => {
    setBusyId(id);
    setNotice(null);
    try {
      const r = await removeAccount(id);
      if (r.error) { setNotice({ tone: "error", text: r.error }); return; }
      await load();
    } catch (e: unknown) {
      setNotice({ tone: "error", text: e instanceof Error ? e.message : "Could not remove" });
    } finally {
      setBusyId(null);
    }
  }, [load]);

  const accounts = resp?.accounts ?? [];
  const presets = useMemo<Preset[]>(() => resp?.providerTypes ?? [], [resp]);
  const typeLabel = useCallback((t: ProviderType) => presets.find((p) => p.type === t)?.label ?? t, [presets]);
  const hasChatOnly = accounts.some((a) => a.capability === "chat_only");

  const noticeTone = notice?.tone === "error" ? tok("stale-red") : notice?.tone === "warn" ? tok("blocked-amber") : tok("done-green");

  return (
    <div className="bos-deck">
      <BosTopbar
        eyebrow="CREDENTIALS · MISSION CONTROL"
        title="Accounts"
        chips={
          status === "ready" ? (
            <span className="helm-chip" data-tone={accounts.length ? "brass" : undefined}>
              {accounts.length} {accounts.length === 1 ? "account" : "accounts"}
            </span>
          ) : undefined
        }
      />

      <p className="max-w-[62ch] text-[13.5px]" style={{ color: tok("muted") }}>
        Bring your own AI. Add any LLM account and its token; the swarm uses the active one.
        Credentials stay on this machine, encrypted, never in the repo.
      </p>

      {/* + Add account — prominent, toggles the inline form */}
      <div>
        {!formOpen && status === "ready" && (
          <button
            type="button"
            onClick={() => { setFormOpen(true); setFormError(null); }}
            className="flex items-center gap-2 rounded-xl px-4 py-2.5 text-[13.5px] font-bold outline-none transition-[filter] focus-visible:ring-2 hover:brightness-[1.06]"
            style={{ backgroundColor: tok("ceo-gold"), color: tok("bg") }}
          >
            <Plus size={16} aria-hidden /> Add Account
          </button>
        )}

        <AnimatePresence initial={false}>
          {formOpen && (
            <motion.div
              initial={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
              animate={reduce ? { opacity: 1 } : { height: "auto", opacity: 1 }}
              exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
              transition={{ duration: reduce ? 0 : 0.24, ease: [0.22, 1, 0.36, 1] }}
              style={{ overflow: "hidden" }}
            >
              <AddAccountForm
                presets={presets}
                busy={adding}
                error={formError}
                onSubmit={(b) => void submit(b)}
                onCancel={() => { setFormOpen(false); setFormError(null); }}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* notice / warning / error strip */}
      <AnimatePresence initial={false}>
        {notice && (
          <motion.div
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduce ? 0 : 0.18 }}
            role={notice.tone === "error" ? "alert" : "status"}
            className="flex items-start gap-2.5 rounded-xl px-4 py-3 text-[12.5px]"
            style={{ color: noticeTone, backgroundColor: `color-mix(in oklch, ${noticeTone} 8%, transparent)`, border: `1px solid color-mix(in oklch, ${noticeTone} 26%, transparent)` }}
          >
            <span className="flex-1">{notice.text}</span>
            <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss" className="shrink-0 outline-none focus-visible:ring-2" style={{ color: noticeTone }}>
              <X size={14} aria-hidden />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* states */}
      {status === "loading" && (
        <p className="flex items-center gap-2 text-[13px]" style={{ color: tok("muted") }} role="status" aria-live="polite">
          <Loader2 size={14} className="animate-spin" aria-hidden /> Loading accounts…
        </p>
      )}

      {status === "error" && (
        <div className="flex flex-col items-start gap-3 rounded-xl p-5" style={{ backgroundColor: tok("panel"), border: `1px solid ${tok("border")}` }}>
          <p role="alert" className="text-[13px]" style={{ color: tok("stale-red") }}>{loadError ?? "Could not reach the runtime."}</p>
          <button
            type="button"
            onClick={() => { setStatus("loading"); void load(); }}
            className="rounded-lg px-3 py-1.5 text-[12.5px] font-semibold outline-none focus-visible:ring-2"
            style={{ color: tok("accent-cyan"), border: `1px solid color-mix(in oklch, ${tok("accent-cyan")} 30%, transparent)` }}
          >
            Retry
          </button>
        </div>
      )}

      {status === "ready" && accounts.length === 0 && !formOpen && (
        <div
          className="flex flex-col items-center gap-3 rounded-2xl px-6 py-12 text-center"
          style={{ border: `1px dashed ${tok("border")}`, backgroundColor: tok("panel") }}
        >
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl" style={{ color: tok("ceo-gold"), backgroundColor: `color-mix(in oklch, ${tok("ceo-gold")} 12%, transparent)` }} aria-hidden>
            <KeyRound size={20} />
          </span>
          <p className="text-[14px] font-semibold" style={{ color: tok("text") }}>No accounts yet</p>
          <p className="max-w-[42ch] text-[12.5px]" style={{ color: tok("muted") }}>
            Add a Claude account to run the swarm, or any other LLM to keep on hand for chat.
          </p>
          <button
            type="button"
            onClick={() => { setFormOpen(true); setFormError(null); }}
            className="mt-1 flex items-center gap-2 rounded-xl px-4 py-2.5 text-[13px] font-bold outline-none transition-[filter] focus-visible:ring-2 hover:brightness-[1.06]"
            style={{ backgroundColor: tok("ceo-gold"), color: tok("bg") }}
          >
            <Plus size={15} aria-hidden /> Add your first account
          </button>
        </div>
      )}

      {status === "ready" && accounts.length > 0 && (
        <div className="flex flex-col gap-2.5">
          <AnimatePresence initial={false}>
            {accounts.map((a) => (
              <motion.div
                key={a.id}
                layout={!reduce}
                initial={reduce ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={reduce ? { opacity: 0 } : { opacity: 0, x: -8 }}
                transition={{ duration: reduce ? 0 : 0.24, ease: [0.22, 1, 0.36, 1] }}
              >
                <AccountRow
                  account={a}
                  typeLabel={typeLabel(a.providerType)}
                  active={resp?.activeAccountId === a.id}
                  busy={busyId === a.id}
                  onSetActive={() => void activate(a.id)}
                  onRemove={() => void remove(a.id)}
                />
              </motion.div>
            ))}
          </AnimatePresence>

          {hasChatOnly && (
            <p className="mt-1 flex items-start gap-1.5 text-[11.5px] leading-relaxed" style={{ color: tok("muted") }}>
              <span className="mt-0.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: tok("factory-violet") }} aria-hidden />
              Chat-only accounts are stored — the engine runs on Claude accounts; saved for chat/future.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
