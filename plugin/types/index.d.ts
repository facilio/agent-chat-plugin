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
  title?: string;                       // the Claude Code session name (ListAgents / /rename), shown to the owner only
  pinnedSummary?: boolean;              // set by hand: don't auto-update
  summaryAt?: number;
  prompts: string[];                    // the person's own recent prompts (summary input)
  promptsSinceSummary: number;
  pendingJoin?: string;                 // a join waiting for this computer to be linked
  rulesShown?: boolean;                 // the model has the room rules (cleared by a compaction)
  tainted?: boolean;                    // the current turn read others' words: actions wait for the owner (hold.ts)
  readOthers?: boolean;                 // the current turn pulled others' words in by a tool (read_history, an attachment): a looks-private reply waits
  tasks?: TaskRec[];                    // tasks running in subagents (tasks.ts)
  usedSources?: string[];               // owner messages / asks that already started a task (each starts one)
  endedAgents?: string[];               // task subagents that ended: anything more from them is refused
  // Who started the current held turn (the people behind its messages; an
  // agent counts as its owner). Null when that can't be pinned on people,
  // e.g. a room description, which any member edits.
  turnFrom?: Person[] | null;
  // The rooms whose messages started the current held turn (the relayed label).
  turnRooms?: string[];
  // "Allow <person> for 1 hour": turns only they (or their agents) start skip
  // the hold until `until` (ms). A grant without one (stored before grants
  // expired) counts as run out. Everyone else still asks.
  grantedPeople?: Array<Person & { until?: number }>;
  // "Allow messages to your other sessions for 1 hour": SendMessage on a held
  // turn goes out unasked until then (labelled as relayed).
  sendUntil?: number;
};
export type Person = { email: string; name: string };
// Quiet mode: the reply/react calls of room turns, by id; their react rows
// and result lines are not drawn in the transcript.
export type RoomRows = { calls: string[] };

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
// roomId: the room the call is for (the pane shows it); post: a held reply's full text.
export type Approval = { requestId: string; tool: string; description: string; preview: string; grantTo?: string; roomId?: string; post?: string };

// The room the pane shows as a chat (display only: never reaches the model).
export type PaneMsg = { id: string; who: string; mine: boolean; system?: boolean; person?: boolean; text: string; ts: number; reactions?: string };  // person: a person wrote it (WhatsApp-style marks)
// agents: names seen as agent authors in the room (lowercase), so the pane
// colors an @mention of an agent apart from one of a person.
export type PaneView = { roomId: string; roomName: string; messages: PaneMsg[]; pinned?: boolean; agents?: string[]; watching?: boolean };  // watching: a room the owner is in that this session hasn't joined, shown read-only
// A colleague's request waiting for the owner (ask_owner), as the pane shows it:
// who asked and what they wrote come from the server, the summary is the agent's.
export type PaneAsk = { askId: string; roomId: string; roomName: string; requesterName: string; requestText: string; summary: string; expiresAt: number };

declare module 'claude-code' {
  interface PluginState {
    'agent-chat': { chat: Shaped<ChatState>; approval: Shaped<Approval | null>; view: Shaped<PaneView | null>; opened: Shaped<string[]>; asks: Shaped<PaneAsk[]>; roomRows: Shaped<RoomRows> }
  }
}
