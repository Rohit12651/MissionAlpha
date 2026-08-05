// Right panel (mission-control redesign) — one zone, two tabs: Chat | Feed.
// Chat = the Boss command conversation (history always visible) + command input.
// Feed = the full filterable swarm event stream. Reference: Slack/Discord split.

import { useState } from "react";
import { PanelRightClose } from "lucide-react";
import type { AgentState, FeedEvent, CommandRequest, CommandResult } from "../../data/types";
import { ChatPane, type Msg } from "../workspace/ChatPane";
import { LiveFeed } from "../LiveFeed";
import { tok } from "../../lib/agentMeta";

type Tab = "chat" | "feed";
const KEY = "ma.rightpanel.tab";
const initialTab = (): Tab => {
  try { return localStorage.getItem(KEY) === "feed" ? "feed" : "chat"; } catch { return "chat"; }
};

export function RightPanel({
  bossId,
  messages,
  setMessages,
  onCommand,
  prefill,
  tierReloadKey,
  feed,
  agents,
  onCollapse,
}: {
  bossId: string;
  messages: Msg[];
  setMessages: (updater: (prev: Msg[]) => Msg[]) => void;
  onCommand: (cmd: CommandRequest) => Promise<CommandResult>;
  prefill: { text: string; nonce: number };
  tierReloadKey: number;
  feed: FeedEvent[];
  agents: AgentState[];
  onCollapse?: () => void;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const pick = (t: Tab) => {
    setTab(t);
    try { localStorage.setItem(KEY, t); } catch { /* ignore */ }
  };

  return (
    <section aria-label="Conversation and feed" className="flex h-full min-w-0 flex-col border-l border-border">
      <div role="tablist" aria-label="Right panel" className="flex gap-1 border-b border-border p-1.5">
        {(["chat", "feed"] as Tab[]).map((t) => {
          const active = t === tab;
          return (
            <button
              key={t}
              role="tab"
              id={`rptab-${t}`}
              aria-selected={active}
              aria-controls={`rppanel-${t}`}
              tabIndex={active ? 0 : -1}
              onClick={() => pick(t)}
              className="flex-1 rounded-md py-1.5 text-center text-[12px] font-medium capitalize outline-none transition-colors focus-visible:ring-2"
              style={{
                color: active ? tok("accent-cyan") : tok("muted"),
                backgroundColor: active ? `color-mix(in oklch, ${tok("accent-cyan")} 12%, transparent)` : "transparent",
              }}
            >
              {t}
            </button>
          );
        })}
        {onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            aria-label="Collapse chat panel"
            title="Collapse panel"
            className="ml-0.5 hidden shrink-0 items-center justify-center rounded-md px-2 outline-none transition-colors hover:bg-panel-2 focus-visible:ring-2 lg:flex"
            style={{ color: tok("muted") }}
          >
            <PanelRightClose size={16} aria-hidden />
          </button>
        )}
      </div>

      {/* Both panels stay mounted; inactive one hidden — keeps chat scroll + draft
          and the feed poll alive across tab switches. */}
      <div id="rppanel-chat" role="tabpanel" aria-labelledby="rptab-chat" className={`min-h-0 flex-1 ${tab === "chat" ? "flex" : "hidden"}`}>
        <ChatPane
          threadId={bossId}
          title="Boss command"
          subtitle="you (BOSS) → tech lead · runs the story pipeline"
          accent="ceo-gold"
          isBoss
          messages={messages}
          setMessages={setMessages}
          onCommand={onCommand}
          prefill={prefill}
          tierReloadKey={tierReloadKey}
        />
      </div>
      <div id="rppanel-feed" role="tabpanel" aria-labelledby="rptab-feed" className={`min-h-0 flex-1 overflow-y-auto p-3 ${tab === "feed" ? "block" : "hidden"}`}>
        <LiveFeed feed={feed} agents={agents} />
      </div>
    </section>
  );
}
