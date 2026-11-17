// What the agent-chat hooks module keeps in $.state for the session: it
// outlives a module reload (the bridge restarts and re-attaches from it).
export type ChatState = {
  sessionId: string;                    // ss_… — stable for this Claude Code session
  joined: string[];                     // room ids this session joined
  roomNames: Record<string, string>;
  cursors: Record<string, string>;      // last message id seen per room
  label?: string;                       // as the server confirmed it
  pinnedLabel?: string;                 // set by /agent-chat label …
  summary?: string;                     // what this session is working on
  pinnedSummary?: boolean;              // set by hand: don't auto-update
  summaryAt?: number;
  prompts: string[];                    // the person's own recent prompts (summary input)
  promptsSinceSummary: number;
  pendingJoin?: string;                 // a join waiting for this computer to be linked
  rulesShown?: boolean;                 // the model has the room rules (cleared by a compaction)
  tainted?: boolean;                    // the current turn read others' words: actions wait for the owner (hold.ts)
  tasks?: TaskRec[];                    // tasks running in subagents (tasks.ts)
  usedSources?: string[];               // owner messages / asks that already started a task (each starts one)
  endedAgents?: string[];               // task subagents that ended: anything more from them is refused
};

// A task: approved work running in an agent-chat:task subagent (tasks.ts).
export type TaskRec = {
  id: string;                           // tk_ + 12 [a-z0-9]
  agentId?: string;                     // the subagent, once started
  members: string[];                    // subagents it started (they share its grant)
  roomId: string;
  roomName: string;
  title: string;                        // what the room sees: text already in the room
  source: 'owner' | 'ask';
  sourceId: string;                     // the owner's message id, or the ask id
  startedAt: number;
  state: 'starting' | 'running' | 'stopping';
  mode?: string;                        // the permission mode it runs under (from the spawn)
  posted?: boolean;                     // it got a reply into the room (else its summary is posted for it)
};

// A tool call held for the owner's answer (terminal pane + web card).
export type Approval = { requestId: string; tool: string; description: string; preview: string };

declare module 'claude-code' {
  interface PluginState {
    'agent-chat': { chat: Shaped<ChatState>; approval: Shaped<Approval | null> }
  }
}
