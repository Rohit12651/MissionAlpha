import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Plug, ChevronDown, Plus, Trash2, Check, AlertTriangle, Power, KeyRound } from "lucide-react";
import { tok } from "../../lib/agentMeta";
import {
  listConnectors, addCred, addConnector, setConnectorEnabled, removeConnector, grantConnector,
  type Connector, type ConnectorsView, type NewConnector,
} from "../../lib/factoryClient";

// MCP Connector panel (ADR-032/033) — add/configure/toggle MCP servers + per-agent
// grant matrix. Creds entered masked → stored in the AES broker (server returns a
// credId; the value never comes back). Collapsible, factory-violet, reduced-motion.

const LAUNCHERS = ["npx", "node", "uvx", "python", "python3", "bunx"];

export function ConnectorPanel({ agentIds }: { agentIds: string[] }) {
  const reduce = useReducedMotion();
  const violet = tok("factory-violet");
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<ConnectorsView>({ connectors: [], grants: {}, creds: [] });
  const [adding, setAdding] = useState(false);
  const [toast, setToast] = useState("");
  const [err, setErr] = useState("");

  // add-form state
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "http">("stdio");
  const [command, setCommand] = useState("npx");
  const [argsText, setArgsText] = useState("-y @modelcontextprotocol/server-filesystem /tmp/data");
  const [url, setUrl] = useState("");
  const [refName, setRefName] = useState("");
  const [secret, setSecret] = useState("");

  const flash = (m: string) => { setToast(m); window.setTimeout(() => setToast(""), 5000); };
  const refresh = useCallback(async () => {
    try { setView(await listConnectors()); } catch { /* */ }
  }, []);
  useEffect(() => { if (open) void refresh(); }, [open, refresh]);

  const submit = useCallback(async () => {
    setErr(""); setAdding(true);
    try {
      const spec: NewConnector = { name: name.trim(), transport };
      if (transport === "stdio") {
        spec.command = command;
        spec.args = argsText.trim() ? argsText.trim().split(/\s+/) : [];
      } else {
        spec.url = url.trim();
      }
      // optional secret → store in broker first, then reference it
      if (secret.trim() && refName.trim()) {
        const c = await addCred(secret);
        if (c.error || !c.credId) { setErr(c.error || "cred store failed"); setAdding(false); return; }
        if (transport === "stdio") spec.envRefs = { [refName.trim()]: c.credId };
        else spec.headersRef = { [refName.trim()]: c.credId };
      }
      const r = await addConnector(spec);
      if (r.error) { setErr(r.error); return; }
      flash(`connector “${spec.name}” added`);
      setName(""); setRefName(""); setUrl("");
      await refresh();
    } catch (e) { setErr((e as Error).message); }
    finally { setSecret(""); setAdding(false); } // never leave a plaintext secret in state
  }, [name, transport, command, argsText, url, refName, secret, refresh]);

  const toggle = useCallback(async (c: Connector) => { await setConnectorEnabled(c.connectorId, !c.enabled); await refresh(); }, [refresh]);
  const remove = useCallback(async (c: Connector) => { await removeConnector(c.connectorId); await refresh(); }, [refresh]);
  const flipGrant = useCallback(async (agentId: string, c: Connector, granted: boolean) => {
    await grantConnector(agentId, c.connectorId, granted ? "revoke" : "grant");
    await refresh();
  }, [refresh]);

  const grantedTo = (agentId: string, connectorId: string) => (view.grants[agentId] || []).includes(connectorId);

  return (
    <div className="overflow-hidden rounded-panel border border-border bg-panel/60 backdrop-blur-md">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-2 px-4 py-2.5 text-left outline-none focus-visible:ring-2">
        <span className="mr-1 inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest" style={{ color: violet }}>
          <Plug size={12} aria-hidden /> MCP Connectors
        </span>
        <span className="font-mono text-[11px] tabular-nums text-text/80">{view.connectors.length} configured</span>
        <span className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-muted">
          connectors
          <ChevronDown size={14} aria-hidden style={{ transform: open ? "rotate(180deg)" : "none", transition: reduce ? "none" : "transform 160ms ease-out" }} />
        </span>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ duration: reduce ? 0 : 0.2, ease: "easeOut" }} className="border-t border-border/50">
            <div className="space-y-4 px-4 py-3">
              {/* add form */}
              <div className="rounded-md border border-border/60 bg-bg/30 p-3">
                <div className="mb-2 inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide" style={{ color: violet }}>
                  <Plus size={12} aria-hidden /> Add a connector
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="name (e.g. fs, github)" aria-label="connector name"
                    className="rounded border px-2 py-1.5 text-[12px] outline-none focus-visible:ring-2" style={{ color: tok("text"), backgroundColor: tok("bg"), borderColor: tok("border") }} />
                  <select value={transport} onChange={(e) => setTransport(e.target.value as "stdio" | "http")} aria-label="transport"
                    className="rounded border px-2 py-1.5 text-[12px] outline-none focus-visible:ring-2" style={{ color: tok("text"), backgroundColor: tok("bg"), borderColor: tok("border") }}>
                    <option value="stdio">stdio (local command)</option>
                    <option value="http">http (remote url)</option>
                  </select>
                  {transport === "stdio" ? (
                    <>
                      <select value={command} onChange={(e) => setCommand(e.target.value)} aria-label="launcher command"
                        className="rounded border px-2 py-1.5 text-[12px] outline-none focus-visible:ring-2" style={{ color: tok("text"), backgroundColor: tok("bg"), borderColor: tok("border") }}>
                        {LAUNCHERS.map((l) => <option key={l} value={l}>{l}</option>)}
                      </select>
                      <input value={argsText} onChange={(e) => setArgsText(e.target.value)} placeholder="args (space-separated)" aria-label="args"
                        className="rounded border px-2 py-1.5 font-mono text-[11px] outline-none focus-visible:ring-2" style={{ color: tok("text"), backgroundColor: tok("bg"), borderColor: tok("border") }} />
                    </>
                  ) : (
                    <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://… (https only)" aria-label="url"
                      className="col-span-2 rounded border px-2 py-1.5 font-mono text-[11px] outline-none focus-visible:ring-2" style={{ color: tok("text"), backgroundColor: tok("bg"), borderColor: tok("border") }} />
                  )}
                  {/* optional masked credential */}
                  <input value={refName} onChange={(e) => setRefName(e.target.value)} placeholder={transport === "stdio" ? "env name (e.g. GH_TOKEN)" : "header (e.g. Authorization)"} aria-label="credential ref name"
                    className="rounded border px-2 py-1.5 text-[12px] outline-none focus-visible:ring-2" style={{ color: tok("text"), backgroundColor: tok("bg"), borderColor: tok("border") }} />
                  <input value={secret} onChange={(e) => setSecret(e.target.value)} type="password" placeholder="secret (optional, stored encrypted)" aria-label="secret"
                    className="rounded border px-2 py-1.5 text-[12px] outline-none focus-visible:ring-2" style={{ color: tok("text"), backgroundColor: tok("bg"), borderColor: tok("border") }} />
                </div>
                {secret && <div className="mt-1.5 inline-flex items-center gap-1 text-[10px]" style={{ color: tok("muted") }}><KeyRound size={11} aria-hidden /> secret encrypted via AES broker — value never leaves the server</div>}
                <button type="button" onClick={() => void submit()} disabled={adding || !name.trim()} className="mt-2 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11px] font-semibold outline-none focus-visible:ring-2 disabled:opacity-40"
                  style={{ color: violet, backgroundColor: `color-mix(in oklch, ${violet} 14%, transparent)`, border: `1px solid color-mix(in oklch, ${violet} 34%, transparent)` }}>
                  <Plus size={13} aria-hidden /> {adding ? "adding…" : "Add connector"}
                </button>
                {err && <p role="alert" className="mt-1.5 inline-flex items-center gap-1.5 text-[10px]" style={{ color: tok("stale-red") }}><AlertTriangle size={11} aria-hidden /> {err}</p>}
              </div>

              {/* connector list + grant matrix */}
              {view.connectors.length === 0 ? (
                <p className="py-2 text-center text-[12px] text-muted">No connectors yet. Add an MCP server above, then grant it to an agent.</p>
              ) : (
                <div className="space-y-2">
                  {view.connectors.map((c) => (
                    <div key={c.connectorId} className="rounded-md border border-border/60 bg-bg/30 p-2.5">
                      <div className="flex items-center gap-2">
                        <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: c.enabled ? tok("done-green") : tok("muted") }} aria-hidden />
                        <span className="text-[13px] font-semibold" style={{ color: tok("text") }}>{c.name}</span>
                        <span className="font-mono text-[10px] uppercase" style={{ color: tok("muted") }}>{c.transport}</span>
                        <span className="truncate font-mono text-[10px]" style={{ color: tok("muted") }}>
                          {c.transport === "stdio" ? `${c.command} ${(c.args || []).join(" ")}` : c.url}
                        </span>
                        {(c.envRefNames.length > 0 || c.headerRefNames.length > 0) && (
                          <span className="inline-flex items-center gap-0.5 text-[10px]" style={{ color: violet }} title="uses an encrypted credential"><KeyRound size={10} aria-hidden /></span>
                        )}
                        <span className="ml-auto flex items-center gap-1">
                          <button type="button" onClick={() => void toggle(c)} aria-label={c.enabled ? "disable" : "enable"} title={c.enabled ? "disable" : "enable"}
                            className="rounded p-1 outline-none focus-visible:ring-2" style={{ color: c.enabled ? tok("done-green") : tok("muted") }}><Power size={13} aria-hidden /></button>
                          <button type="button" onClick={() => void remove(c)} aria-label="delete connector" title="delete"
                            className="rounded p-1 outline-none focus-visible:ring-2" style={{ color: tok("stale-red") }}><Trash2 size={13} aria-hidden /></button>
                        </span>
                      </div>
                      {/* grant matrix */}
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <span className="font-mono text-[9px] uppercase tracking-wide" style={{ color: tok("muted") }}>grant to:</span>
                        {agentIds.length === 0 && <span className="text-[10px]" style={{ color: tok("muted") }}>no agents</span>}
                        {agentIds.map((a) => {
                          const granted = grantedTo(a, c.connectorId);
                          return (
                            <button key={a} type="button" onClick={() => void flipGrant(a, c, granted)} aria-pressed={granted}
                              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] outline-none focus-visible:ring-2"
                              style={{ color: granted ? violet : tok("muted"), backgroundColor: granted ? `color-mix(in oklch, ${violet} 16%, transparent)` : "transparent", border: `1px solid ${granted ? `color-mix(in oklch, ${violet} 38%, transparent)` : tok("border")}` }}>
                              {granted && <Check size={10} aria-hidden />} {a}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {toast && <p className="inline-flex items-center gap-1.5 text-[10px]" style={{ color: tok("done-green") }} role="status" aria-live="polite"><Check size={12} aria-hidden /> {toast}</p>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
