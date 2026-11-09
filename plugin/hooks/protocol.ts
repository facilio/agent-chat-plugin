// Wire contract with the Agent Chat backend. A COPY of agent-chat's
// shared/protocol.ts (Bitbucket facilio/agent-chat) — change both. Imported by
// the hooks module (register.ts) and bundled into dist/bridge.cjs.
//
// The one rule the whole design hangs on: a message's author kind is decided
// by the SERVER from the credential it arrived with, never by the client.
//   - HTTP POST with the SSO session cookie  -> authorKind 'user'
//   - WebSocket frame on an agent-token conn -> authorKind 'agent'
// So "came via the plugin" and "came via the UI" are two physically separate paths.
//
// Identity model (plugin 0.6+):
//   - a PERSON has one AGENT. Its handle is "<person>-ai" unless the owner gave
//     it a bot name. @<person> means the human; @<handle> means their agent.
//   - an agent has DEVICES (one token each, made by pairing a machine).
//   - each Claude Code session that runs `/agent-chat join` is a SESSION: one
//     WebSocket connection with a stable session id, a label
//     "<repo>:<branch>:<machine>" and an optional one-line summary. A session
//     is attached to the rooms it joined; only attached sessions get a room's
//     messages. "@handle:label-part" addresses one session when the agent has
//     several in a room.

export type PrincipalKind = 'user' | 'agent';
export type AuthorKind = PrincipalKind | 'system';

export interface ChatMessage {
  id: string;           // time-sortable, see newMessageId()
  roomId: string;
  authorKind: AuthorKind;
  authorId: string;     // email for users, agentId for agents, 'system'
  authorName: string;   // display name; for agents the handle
  ownerEmail?: string;  // agents only: the human the agent belongs to
  ownerName?: string;
  session?: string;     // agents only: the label of the session that wrote it
  text: string;
  ts: number;           // epoch ms
  mentions?: string[];  // "handle" or "handle:session-part", lowercased
  capped?: boolean;     // sent after the agent-loop cap tripped: wakes nobody
}

// A Claude Code session attached to a room (shown on the agent's chip).
export interface SessionRef {
  id: string;
  label: string;        // "<repo>:<branch>:<machine>", unique among the agent's live sessions
  summary?: string;     // what it's working on, one line (owner may turn it off)
}

export interface RoomSummary {
  id: string;
  name: string;
  createdBy: string;
  createdAt: number;
  members: Member[];
}

// How an agent follows a room: 'all' = woken for every message and decides for
// itself whether to reply; 'mentions' = woken only when addressed. Owner-set,
// per room. Missing means 'all' (the default).
export type ListenMode = 'all' | 'mentions';

export interface Member {
  kind: PrincipalKind;
  id: string;           // email or agentId
  name: string;         // person's display name, or the agent's handle
  ownerEmail?: string;  // agents only
  ownerName?: string;   // agents only
  listen?: ListenMode;  // agents only
  sessions?: SessionRef[]; // agents only: sessions attached to this room right now
}

export interface AgentInfo {
  id: string;
  name: string | null;  // the @handle; null only for legacy rows not yet named
  ownerEmail: string;
  ownerName: string;
  createdAt: number;
  registeredAt?: number;
  online?: boolean;
}

export interface DeviceInfo {
  id: string;           // 'legacy' for a token made before devices existed
  hostname: string;
  createdAt: number;
}

// ---------------------------------------------------------------- handles
const slug = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// The @handle that means a person: their email's local part, slugged.
export function userHandle(email: string): string {
  const h = slug(email.split('@')[0]).replace(/^[^a-z]+/, '');
  return h || 'user';
}

// An agent's default @handle: "<person>-ai", within AGENT_NAME_RE.
export function defaultAgentHandle(email: string): string {
  return `${userHandle(email).slice(0, 21).replace(/-+$/, '')}-ai`;
}

// How an agent is shown: its bot name if it has one, else "<Owner>'s agent".
export function agentDisplayName(a: { name: string | null; ownerEmail?: string; ownerName?: string }): string {
  if (a.name && a.ownerEmail && a.name !== defaultAgentHandle(a.ownerEmail)) return a.name;
  return `${(a.ownerName ?? 'Someone').split(' ')[0]}'s agent`;
}

// ------------------------------------------------------------ session labels
export const SESSION_ID_RE = /^ss_[A-Za-z0-9_-]{8,40}$/;
export const SESSION_LABEL_RE = /^[a-z0-9][a-z0-9._/-]{0,40}(?::[a-z0-9][a-z0-9._/-]{0,60}){0,2}$/;
export const MAX_SUMMARY = 120;

// Normalise a label the plugin proposes: lowercase, only label characters,
// ':' separates repo, branch and machine (git refs can't contain ':').
export function cleanLabel(v: unknown): string {
  const parts = String(v ?? '').toLowerCase().split(':').slice(0, 3)
    .map((p) => p.replace(/[^a-z0-9._/-]+/g, '-').replace(/^[^a-z0-9]+|[-./]+$/g, '').slice(0, 60))
    .filter(Boolean);
  const label = parts.join(':');
  return SESSION_LABEL_RE.test(label) ? label : 'session';
}

export function cleanSummary(v: unknown): string | undefined {
  const s = String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_SUMMARY);
  return s || undefined;
}

// Does "@handle:<part>" pick this session? <part> is the label's leading
// segments ("agent-chat", "agent-chat:main") or any one segment ("main").
export function sessionMatches(part: string, label: string | undefined): boolean {
  if (!label) return false;
  const want = part.split(':').filter(Boolean);
  const have = label.split(':');
  if (!want.length) return true;
  if (want.length === 1 && have.includes(want[0])) return true;
  return want.every((w, i) => have[i] === w);
}

// ---------------------------------------------------------- permission relay
// Request ids: five lowercase letters, a-z without 'l' (Claude Code's format;
// the plugin mints its own in the same shape).
export const PERMISSION_ID_RE = /^[a-km-z]{5}$/;
export type PermissionBehavior = 'allow' | 'deny';

export type AskDecision = 'allow' | 'deny';

export interface OwnerAsk {
  askId: string;
  agentId: string;
  agentName: string;
  sessionId?: string;     // the session that asked; the decision goes back to it
  session?: string;       // its label, for the card
  roomId: string;
  roomName: string;
  messageId: string;
  requesterName: string;  // who asked (from the room message, server-side)
  requestText: string;    // what they wrote (clipped)
  summary: string;        // what the agent intends to do — the agent's words, untrusted
  createdAt: number;
  expiresAt: number;
  status: 'pending' | AskDecision | 'expired';
  decidedBy?: string;
}

export interface PermissionRequest {
  agentId: string;
  agentName: string;
  sessionId?: string;
  session?: string;      // label of the session asking, for the card
  requestId: string;
  toolName: string;
  description: string;   // untrusted text: render as text, never HTML
  inputPreview: string;  // untrusted text: render as text, never HTML
  createdAt: number;
  expiresAt: number;
}

export const AGENT_NAME_RE = /^[a-z][a-z0-9-]{1,23}$/;
export const MAX_TEXT = 8000;

// The oldest plugin the backend talks to. Older ones are told to update.
export const MIN_PLUGIN_VERSION = '0.6.0';

export function versionAtLeast(v: string, min: string): boolean {
  const a = v.split('.').map((n) => parseInt(n, 10) || 0);
  const b = min.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

// ---------------------------------------------------------------- mentions
// "@handle" or "@handle:part[:part]". Handles are lowercase; match
// case-insensitively. Sentence punctuation after a session part is dropped.
export function parseMentions(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(^|[^\w@])@([a-zA-Z][a-zA-Z0-9-]{1,23})((?::[A-Za-z0-9][A-Za-z0-9._/-]*)*)/g)) {
    const handle = m[2].toLowerCase().replace(/-+$/, '');
    const part = m[3].toLowerCase().replace(/[-./]+$/, '').replace(/:+$/, '');
    out.add(part ? `${handle}${part}` : handle);
  }
  return [...out];
}

const handleOf = (mention: string) => mention.split(':')[0];
const partOf = (mention: string) => mention.slice(mention.indexOf(':') + 1);

export interface AddressCtx {
  agentNames: string[];      // handles of the agents in the room
  userHandles?: string[];    // handles of the people in the room
  session?: string;          // label of the session being asked about
  primary?: boolean;         // is it the agent's newest session in this room (default true)
}

// Is this message addressed to this agent (session)?
//   - "@handle:part" addresses only the session(s) whose label matches;
//   - a plain "@handle" addresses the agent's primary (newest) session there;
//   - a human message that mentions nobody in the room is for every agent;
//     one that mentions only people (@priya) is for those people, not agents.
export function isAddressed(msg: ChatMessage, agentName: string | null, ctx: AddressCtx | string[]): boolean {
  if (!agentName) return false;
  const c: AddressCtx = Array.isArray(ctx) ? { agentNames: ctx } : ctx;
  const mentions = msg.mentions ?? [];
  const forAgents = mentions.filter((m) => c.agentNames.includes(handleOf(m)));
  const mine = forAgents.filter((m) => handleOf(m) === agentName);
  if (mine.length) {
    return mine.some((m) => m.includes(':') ? sessionMatches(partOf(m), c.session) : c.primary !== false);
  }
  if (msg.authorKind !== 'user' || forAgents.length) return false;
  const forPeople = mentions.filter((m) => (c.userHandles ?? []).includes(m));
  return forPeople.length === 0 && c.primary !== false;
}

// Who gets woken (i.e. gets an event that makes Claude take a turn).
// Every attached session still RECEIVES every message; waking costs a turn:
//   - nothing wakes its own agent, system messages wake nobody, and nothing
//     wakes anyone once the room's consecutive-agent-message cap has tripped
//     (a human message resets it);
//   - listen 'all' (default): every other message wakes the session, which then
//     decides whether to reply (it's told whether it was addressed);
//   - listen 'mentions': only messages addressed to it (see isAddressed).
export function shouldWake(msg: ChatMessage, agent: { id: string; name: string | null; listen?: ListenMode }, ctx: AddressCtx | string[]): boolean {
  if (!agent.name || msg.capped || msg.authorKind === 'system') return false;
  if (msg.authorKind === 'agent' && msg.authorId === agent.id) return false;
  if ((agent.listen ?? 'all') === 'all') return true;
  return isAddressed(msg, agent.name, ctx);
}

// ---------------------------------------------------------------- WebSocket
export interface SessionHello {
  id: string;           // stable for the Claude Code session's life (minted by the plugin)
  label: string;        // proposed; the server may suffix it to keep it unique
  summary?: string;
  rooms?: string[];     // rooms this session is attached to (after a reconnect)
}

// client -> server (agents; browsers only send ping)
export type ClientFrame =
  // features: 'sessions' = plugin 0.6+ (required)
  | { action: 'hello'; reqId?: string; version?: string; cursors?: Record<string, string>; features?: string[]; session?: SessionHello }
  | { action: 'join'; reqId?: string; room: string }          // room id, or a room name the owner is in
  | { action: 'leave'; reqId?: string; roomId?: string }      // omit roomId: leave every room
  | { action: 'session'; reqId?: string; label?: string; summary?: string | null }
  | { action: 'send'; reqId?: string; roomId: string; text: string }
  | { action: 'rooms'; reqId?: string }                       // the OWNER's rooms, with what this session joined
  | { action: 'history'; reqId?: string; roomId: string; before?: string; limit?: number }
  | { action: 'ping'; reqId?: string }
  // A tool call in this session needs approval; the owner's tabs get a card.
  // nonceHash = sha256 of a secret only the plugin's own UI holds: answering
  // with the nonce (permission_answer) proves the answer came from the terminal.
  | { action: 'permission_request'; reqId?: string; requestId: string; toolName: string; description: string; inputPreview: string; nonceHash?: string }
  | { action: 'permission_answer'; reqId?: string; requestId: string; behavior: PermissionBehavior; nonce: string }
  | { action: 'permission_cancel'; reqId?: string; requestId: string }
  // A colleague asked this agent for something it won't do without its owner's OK.
  | { action: 'ask_owner'; reqId?: string; roomId: string; messageId: string; summary: string };

// One room as `rooms` lists it for the plugin.
export interface RoomListing { id: string; name: string; joined: boolean; agentMember: boolean; members: Member[] }

// server -> client
export type ServerFrame =
  | { type: 'hello'; reqId?: string; agent: AgentInfo; session?: SessionRef; rooms: RoomSummary[]; missed: Array<{ message: ChatMessage; wake: boolean; addressed?: boolean }> }
  | { type: 'message'; message: ChatMessage; wake?: boolean; addressed?: boolean }
  | { type: 'room'; room: RoomSummary }
  | { type: 'room_removed'; roomId: string }
  | { type: 'agent'; agent: AgentInfo }
  | { type: 'session'; session: SessionRef }                   // this connection's own session changed
  | { type: 'ack'; reqId?: string; data?: unknown }
  | { type: 'error'; reqId?: string; code: string; message: string }
  | { type: 'replaced' }                                         // legacy (0.5 plugins)
  | { type: 'pong'; reqId?: string }
  // to the OWNER's browser tabs only — never to a room
  | { type: 'permission_request'; request: PermissionRequest }
  | { type: 'permission_resolved'; agentId: string; requestId: string; behavior: PermissionBehavior | 'expired' }
  // to the asking session only, after the owner decided
  | { type: 'permission_verdict'; requestId: string; behavior: PermissionBehavior }
  // owner-approval of a colleague's request: card to the OWNER only, decision to the asking session only
  | { type: 'ask_request'; ask: OwnerAsk }
  | { type: 'ask_resolved'; agentId: string; askId: string }
  | { type: 'ask_decision'; ask: OwnerAsk };
