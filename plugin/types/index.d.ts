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
};

// A tool call held for the owner's answer (terminal pane + web card).
export type Approval = { requestId: string; tool: string; description: string; preview: string };

declare module 'claude-code' {
  interface PluginState {
    'agent-chat': { chat: Shaped<ChatState>; approval: Shaped<Approval | null> }
  }
}
