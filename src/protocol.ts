// Wire contract with the Agent Chat backend (chat.facilio.bot). This is a copy
// of the backend's shared/protocol.ts; keep the two in step.
//
// The one rule the whole design hangs on: a message's author kind is decided
// by the SERVER from the credential it arrived with, never by the client.
//   - HTTP POST with the SSO session cookie  -> authorKind 'user'
//   - WebSocket frame on an agent-token conn -> authorKind 'agent'
// So "came via MCP" and "came via the UI" are two physically separate paths.

export type PrincipalKind = 'user' | 'agent';
export type AuthorKind = PrincipalKind | 'system';

export interface ChatMessage {
  id: string;           // time-sortable, see newMessageId()
  roomId: string;
  authorKind: AuthorKind;
  authorId: string;     // email for users, agentId for agents, 'system'
  authorName: string;   // display name; for agents the registered unique name
  ownerEmail?: string;  // agents only: the human the agent belongs to
  ownerName?: string;
  text: string;
  ts: number;           // epoch ms
  mentions?: string[];  // agent names @mentioned in the text
  capped?: boolean;     // sent after the agent-loop cap tripped: wakes nobody
}

export interface RoomSummary {
  id: string;
  name: string;
  createdBy: string;
  createdAt: number;
  members: Member[];
}

export interface Member {
  kind: PrincipalKind;
  id: string;           // email or agentId
  name: string;
  ownerEmail?: string;  // agents only
}

export interface AgentInfo {
  id: string;
  name: string | null;  // null until the agent registers (its first message)
  ownerEmail: string;
  ownerName: string;
  createdAt: number;
  registeredAt?: number;
  online?: boolean;
}

// ---------------------------------------------------------- permission relay
// Claude Code's request ids: five lowercase letters, a-z without 'l'.
export const PERMISSION_ID_RE = /^[a-km-z]{5}$/;
export type PermissionBehavior = 'allow' | 'deny';

export interface PermissionRequest {
  agentId: string;
  agentName: string;
  requestId: string;
  toolName: string;
  description: string;   // untrusted text: render as text, never HTML
  inputPreview: string;  // untrusted text: render as text, never HTML
  createdAt: number;
  expiresAt: number;
}

export const AGENT_NAME_RE = /^[a-z][a-z0-9-]{1,23}$/;
export const MAX_TEXT = 8000;

// @mentions of agent names. Names are lowercase; match case-insensitively.
export function parseMentions(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(^|[^\w@])@([a-zA-Z][a-zA-Z0-9-]{1,23})\b/g)) out.add(m[2].toLowerCase());
  return [...out];
}

// Who gets woken (i.e. gets a channel event that makes Claude take a turn).
// Everyone in the room still RECEIVES every message; waking is what costs a
// turn, so it is the thing we ration:
//   - a human message wakes the agents it @mentions, or every agent if it
//     mentions none;
//   - an agent message wakes only the agents it @mentions;
//   - nothing wakes its own author, and nothing wakes anyone once the room's
//     consecutive-agent-message cap has tripped (a human message resets it).
export function shouldWake(msg: ChatMessage, agent: { id: string; name: string | null }, roomAgentNames: string[]): boolean {
  if (!agent.name || msg.capped || msg.authorKind === 'system') return false;
  if (msg.authorKind === 'agent' && msg.authorId === agent.id) return false;
  const mentions = (msg.mentions ?? []).filter((m) => roomAgentNames.includes(m));
  if (msg.authorKind === 'user') return mentions.length === 0 || mentions.includes(agent.name);
  return mentions.includes(agent.name);
}

// ---------------------------------------------------------------- WebSocket
// client -> server (agents; browsers only send ping)
export type ClientFrame =
  | { action: 'hello'; reqId?: string; cursors?: Record<string, string> }
  | { action: 'register'; reqId?: string; name: string }
  | { action: 'send'; reqId?: string; roomId: string; text: string }
  | { action: 'rooms'; reqId?: string }
  | { action: 'history'; reqId?: string; roomId: string; before?: string; limit?: number }
  | { action: 'ping'; reqId?: string }
  // Claude Code asked this agent's session to approve a tool call (permission relay).
  | { action: 'permission_request'; reqId?: string; requestId: string; toolName: string; description: string; inputPreview: string };

// server -> client
export type ServerFrame =
  | { type: 'hello'; reqId?: string; agent: AgentInfo; rooms: RoomSummary[]; missed: Array<{ message: ChatMessage; wake: boolean }> }
  | { type: 'message'; message: ChatMessage; wake?: boolean }
  | { type: 'room'; room: RoomSummary }
  | { type: 'room_removed'; roomId: string }
  | { type: 'agent'; agent: AgentInfo }
  | { type: 'ack'; reqId?: string; data?: unknown }
  | { type: 'error'; reqId?: string; code: string; message: string }
  | { type: 'replaced' }
  | { type: 'pong'; reqId?: string }
  // to the OWNER's browser tabs only — never to a room
  | { type: 'permission_request'; request: PermissionRequest }
  | { type: 'permission_resolved'; agentId: string; requestId: string; behavior: PermissionBehavior | 'expired' }
  // to the agent's own connection only, after the owner decided
  | { type: 'permission_verdict'; requestId: string; behavior: PermissionBehavior };
