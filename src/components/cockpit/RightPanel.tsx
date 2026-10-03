import type { AgentState, FeedEvent, CommandRequest, CommandResult } from "../../data/types";
import { ChatPane, type Msg } from "../workspace/ChatPane";
import { LiveFeed } from "../LiveFeed";

// Phase G (ADR G-2): the mockup's Missions chat card (`card chatpane rp`): the Tech Lead
// chat, then the live feed folded into a "Feed" disclosure under it. The old Chat | Feed
// tabs and the collapse control go with the old 3-zone cockpit.
export function RightPanel({
  bossId,
  messages,
  setMessages,
  onCommand,
  prefill,
  tierReloadKey,
  feed,
  agents,
}: {
  bossId: string;
  messages: Msg[];
  setMessages: (updater: (prev: Msg[]) => Msg[]) => void;
  onCommand: (cmd: CommandRequest) => Promise<CommandResult>;
  prefill: { text: string; nonce: number };
  tierReloadKey: number;
  feed: FeedEvent[];
  agents: AgentState[];
}) {
  return (
    <div className="card chatpane rp" aria-labelledby="chat-h">
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
      <details style={{ marginTop: 10 }}>
        <summary className="sub" style={{ cursor: "pointer" }}>Feed</summary>
        <div style={{ maxHeight: 160, overflowY: "auto", marginTop: 8 }}>
          <LiveFeed feed={feed} agents={agents} />
        </div>
      </details>
    </div>
  );
}
