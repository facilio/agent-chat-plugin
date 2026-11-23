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
  attachments?: Attachment[];  // files on the message: a person's, or an agent's pictures (untrusted either way)
  notice?: 'paused' | 'resumed';  // system lines about the agent pause: the quiet record of when it happened
  reactions?: Reaction[];  // oldest first; at most one per person or agent
  replyTo?: ReplyRef;      // the message this one answers (a snapshot: it stays if that one changes)
}

// What a reply shows of the message it answers, WhatsApp-style: who wrote it
// and its opening words (or its files). Replying to an agent's message is
// talking to that agent (session): see isAddressed.
export interface ReplyRef { id: string; authorKind: AuthorKind; authorId: string; authorName: string; session?: string; text: string }
export const REPLY_SNIPPET = 200;
export function replySnippet(m: { text?: string; attachments?: Array<{ name: string }> }): string {
  const t = String(m.text ?? '').replace(/```[\s\S]*?```/g, '[code]').replace(/\s+/g, ' ').trim();
  const s = t || (m.attachments ?? []).map((f) => `📎 ${f.name}`).join(' ');
  return s.length > REPLY_SNIPPET ? `${s.slice(0, REPLY_SNIPPET - 1)}…` : s;
}

// An emoji on a message. WhatsApp-style: one each, a new one replaces yours,
// the same one again takes it off. A reaction never wakes an agent, never
// counts toward the agents' pause and never moves a room's unread count.
export interface Reaction { emoji: string; kind: PrincipalKind; id: string; name: string; ts: number }
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '🙏', '✅'];
export const MAX_EMOJI = 16;
// One emoji (flags, skin tones and ZWJ sequences included), nothing else.
export function cleanEmoji(v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (!s || s.length > MAX_EMOJI) return null;
  if (!/^[\p{Extended_Pictographic}\p{Emoji_Component}\u200d\ufe0f\u20e3]+$/u.test(s)) return null;
  if (!/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u20e3]/u.test(s)) return null;  // keycaps (1️⃣) too
  if ([...new Intl.Segmenter().segment(s)].length !== 1) return null;  // one emoji, not 👍👍 or 👍1
  return s;
}

// A file on a message. The bytes live in a private bucket; browsers read them
// at /api/rooms/<roomId>/files/<id>, agents through the `attachment` action.
// People attach any file; agents attach pictures only (AGENT_UPLOAD_TYPES),
// through the `upload` action.
export interface Attachment {
  id: string;           // f_ + 16 chars, made by the server
  name: string;         // the uploader's file name: a label only, never a path
  type: string;         // media type as uploaded
  size: number;         // bytes
}
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES_PER_MESSAGE = 5;
export const FILE_RETENTION_DAYS = 30;
export const FILE_ID_RE = /^f_[A-Za-z0-9]{16}$/;
// Shown in the page as images; every other type is a download only (SVG and
// HTML included: they can carry script).
export const INLINE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
// What an agent may upload: pictures only. Logs, archives and documents are the
// easy way to send a secret out, and the plugin can only vet a picture's path.
export const AGENT_UPLOAD_TYPES = INLINE_IMAGE_TYPES;

// A Claude Code session attached to a room (shown on the agent's chip).
export interface SessionRef {
  id: string;
  label: string;        // "<repo>:<branch>:<machine>", unique among the agent's live sessions
  summary?: string;     // what it's working on, one line (owner may turn it off)
  version?: string;     // its agent-chat plugin version (room member lists only)
  // Its Claude Code session name (what /rename sets and other sessions address
  // it by). Can say what the owner is working on, so only the owner's own views
  // carry it; everyone else sees the label.
  title?: string;
}

export interface RoomSummary {
  id: string;
  name: string;
  createdBy: string;
  createdAt: number;
  members: Member[];
  last?: RoomLast;      // newest non-system message, for room-list previews
  type?: RoomType;      // missing = a room from before types (behaves like 'project')
  description?: string; // what the room is for; written by its members, untrusted
  unarchivedAt?: number; // when a person last unarchived it (restarts the quiet clock)
  archivedAt?: number;   // when a person last archived it by hand
  archivedBy?: string;   // ...and who
  archived?: boolean;    // see isArchived: read-only until a person unarchives it
}

// An archived room stays listed and readable, but is read-only: no messages,
// reactions, agent joins, tasks or new people until one of its people
// unarchives it. A room is archived when a person archives it, or when nobody
// has written in it (people or agents; system lines don't count) for
// ARCHIVE_AFTER_DAYS. Derived from the room's last message and the two
// stamps, so there is no sweep and no stored flag to drift.
export const ARCHIVE_AFTER_DAYS = 7;
export const ARCHIVE_AFTER_MS = ARCHIVE_AFTER_DAYS * 86400_000;
type ArchiveFacts = { createdAt: number; last?: { ts: number }; unarchivedAt?: number; archivedAt?: number };
export function roomActiveAt(r: ArchiveFacts): number {
  return Math.max(r.createdAt || 0, r.last?.ts || 0, r.unarchivedAt || 0);
}
export function archivedByHand(r: ArchiveFacts): boolean {
  return (r.archivedAt || 0) > (r.unarchivedAt || 0);
}
export function isArchived(r: ArchiveFacts, now = Date.now()): boolean {
  return archivedByHand(r) || now - roomActiveAt(r) > ARCHIVE_AFTER_MS;
}
export function archivedText(r: ArchiveFacts & { archivedBy?: string }, web: string): string {
  const why = archivedByHand(r) ? `${r.archivedBy ?? 'Someone'} archived it` : `nobody wrote here for ${ARCHIVE_AFTER_DAYS} days`;
  return `This room is archived (${why}), so it is read-only. One of its people must unarchive it at ${web} before anyone can post, react or join.`;
}

// What a room is for. It sets defaults, never permissions:
//   project — a room for one piece of work the AI is doing (every new room)
//   direct  — two people (and their agents); fixed membership, one per pair
export type RoomType = 'project' | 'direct';
export const ROOM_TYPES: RoomType[] = ['project', 'direct'];
export const MAX_ROOM_DESCRIPTION = 1000;

// How a newly added agent follows a room of this type (its owner can change
// it). Every type follows all messages today; the hook stays for new types.
export function defaultListen(_type: RoomType | undefined): ListenMode {
  return 'all';
}

// Plain text, kept to MAX_ROOM_DESCRIPTION; line breaks survive. '' = none.
export function cleanDescription(v: unknown): string {
  return String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_ROOM_DESCRIPTION);
}

export interface RoomLast {
  id: string;
  ts: number;
  authorKind: AuthorKind;
  authorId: string;
  authorName: string;
  ownerEmail?: string;
  text: string;         // first 160 characters; untrusted, render as text
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
  avatarAt?: number;    // set when the owner uploaded a picture: /api/agents/<id>/avatar?v=<avatarAt>
}

// Agent pictures: resized in the browser, stored in DynamoDB, served by the
// HTTP Lambda. Raster only (an SVG could carry script).
export const AVATAR_MAX_BYTES = 256 * 1024;
export const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

// An agent can propose a picture for itself (Claude draws it as SVG). It is
// never stored or served as SVG: the owner sees it as an <img> in their own
// browser, which turns it into a PNG and uploads it like any picture. Kept to
// plain drawing: no script, event handlers, foreignObject or outside links.
export const MAX_AVATAR_SVG = 64 * 1024;
export function cleanAvatarSvg(v: unknown): string | null {
  const svg = String(v ?? '').trim();
  if (!svg || svg.length > MAX_AVATAR_SVG || !/^(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(svg) || !/<\/svg>$/i.test(svg)) return null;
  if (/<script|<foreignObject|<iframe|<image|<use\b|<!ENTITY|<!DOCTYPE|\bon[a-z]+\s*=|javascript:|data:|@import/i.test(svg)) return null;
  if (/(?:href|src)\s*=/i.test(svg) || /url\(\s*['"]?(?!#)/i.test(svg)) return null;   // only in-document refs (url(#grad))
  return svg;
}
export interface AvatarProposal { agentId: string; agentName: string; svg: string; note?: string; createdAt: number }

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

export const MAX_TITLE = 80;
export function cleanTitle(v: unknown): string | undefined {
  const s = String(v ?? '').replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
  return s || undefined;
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
// 'person': allowed, and turns that request's people start skip the hold for
// the rest of that agent session (grantTo names them on the card).
export type PermissionScope = 'person';

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
  grantTo?: string;      // who "Allow … for this session" would cover, as the card names them (plugin 0.11+); untrusted text
  inputPreview: string;  // untrusted text: render as text, never HTML
  createdAt: number;
  expiresAt: number;
}

// The agent's view of what waits for its owner (action 'approvals'). Strings
// are untrusted display text (the asking session's own words).
export interface PendingApprovals {
  tools: Array<{ requestId: string; session?: string; toolName: string; description: string; createdAt: number; expiresAt: number }>;
  asks: Array<{ askId: string; session?: string; roomId: string; roomName: string; requesterName: string; summary: string; createdAt: number; expiresAt: number }>;
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
//     one that mentions only people (@priya) is for those people, not agents;
//   - a reply is for whoever wrote the message it answers (an agent's
//     session, or a person: then no agent), unless it @mentions agents.
// Reserved (no agent can take the name): the whole room, people and agents.
export const EVERYONE = 'everyone';

export function isAddressed(msg: ChatMessage, agentName: string | null, ctx: AddressCtx | string[]): boolean {
  if (!agentName) return false;
  const c: AddressCtx = Array.isArray(ctx) ? { agentNames: ctx } : ctx;
  const mentions = msg.mentions ?? [];
  const forAgents = mentions.filter((m) => c.agentNames.includes(handleOf(m)));
  const mine = forAgents.filter((m) => handleOf(m) === agentName);
  if (mine.length) {
    return mine.some((m) => m.includes(':') ? sessionMatches(partOf(m), c.session) : c.primary !== false);
  }
  // A reply to an agent's message is for that agent: the session that wrote
  // it (its primary one when that isn't recorded), and not for every agent.
  const rt = msg.replyTo;
  const replyAgent = rt?.authorKind === 'agent' && c.agentNames.includes(rt.authorName) ? rt.authorName : null;
  if (replyAgent === agentName && !forAgents.length) return rt!.session ? rt!.session === c.session : c.primary !== false;
  // @everyone from a person addresses every agent (its newest session) and
  // every person. From an agent it addresses no agent: that would wake them all.
  if (mentions.includes(EVERYONE)) return msg.authorKind === 'user' && c.primary !== false;
  if (msg.authorKind !== 'user' || forAgents.length || replyAgent) return false;
  // a reply to a person's message is talking to them, as an @mention would be
  const forPeople = mentions.filter((m) => (c.userHandles ?? []).includes(m));
  return forPeople.length === 0 && rt?.authorKind !== 'user' && c.primary !== false;
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
  title?: string;       // the Claude Code session name (owner-only, see SessionRef)
  rooms?: string[];     // rooms this session is attached to (after a reconnect)
}

// client -> server (agents; browsers only send ping)
export type ClientFrame =
  // features: 'sessions' = plugin 0.6+ (required)
  | { action: 'hello'; reqId?: string; version?: string; cursors?: Record<string, string>; features?: string[]; session?: SessionHello }
  | { action: 'join'; reqId?: string; room: string }          // room id, or a room name the owner is in
  | { action: 'leave'; reqId?: string; roomId?: string; reason?: 'exit' } // omit roomId: leave every room; exit = Claude Code is ending the session
  | { action: 'session'; reqId?: string; label?: string; summary?: string | null; title?: string | null }
  // attachments: ids from `upload` by this agent, in this room (at most
  // MAX_FILES_PER_MESSAGE); with files the text may be empty.
  | { action: 'send'; reqId?: string; roomId: string; text: string; replyTo?: string; attachments?: string[] }
  // A signed PUT for one picture this session will attach to a message (agent
  // door, joined rooms only, AGENT_UPLOAD_TYPES only, at most MAX_FILE_BYTES).
  // Replies { fileId, url, headers }: PUT the bytes with those headers.
  | { action: 'upload'; reqId?: string; roomId: string; name: string; type: string; size: number }
  | { action: 'rooms'; reqId?: string }                       // the OWNER's rooms, with what this session joined
  | { action: 'history'; reqId?: string; roomId: string; before?: string; limit?: number }
  // What is waiting for the owner's OK from this agent (any of its sessions):
  // read-only, so an agent can say what's pending when its owner asks. Never
  // the tool's input or a nonce; nothing here can answer one. Replies with
  // PendingApprovals.
  | { action: 'approvals'; reqId?: string }
  // This agent's reaction on a message in a room this session joined; null takes it off.
  | { action: 'react'; reqId?: string; roomId: string; messageId: string; emoji: string | null }
  | { action: 'ping'; reqId?: string }
  // A tool call in this session needs approval; the owner's tabs get a card.
  // nonceHash = sha256 of a secret only the plugin's own UI holds: answering
  // with the nonce (permission_answer) proves the answer came from the terminal.
  | { action: 'permission_request'; reqId?: string; requestId: string; toolName: string; description: string; inputPreview: string; nonceHash?: string; grantTo?: string }
  | { action: 'permission_answer'; reqId?: string; requestId: string; behavior: PermissionBehavior; nonce: string }
  | { action: 'permission_cancel'; reqId?: string; requestId: string }
  // A colleague asked this agent for something it won't do without its owner's OK.
  | { action: 'ask_owner'; reqId?: string; roomId: string; messageId: string; summary: string; nonceHash?: string }
  // The owner answering in the asking session's terminal pane (plugin 0.16+):
  // the nonce whose hash came with ask_owner, held by the plugin's UI only.
  | { action: 'ask_answer'; reqId?: string; askId: string; decision: AskDecision; nonce: string }
  // As the agent's OWNER: make a room (the owner is its first member) and add
  // people to one the owner is in. People only (@facilio.com); agents still
  // join themselves with /agent-chat join. Replies with the RoomSummary.
  | { action: 'create_room'; reqId?: string; name: string; members?: string[] }
  | { action: 'add_members'; reqId?: string; room: string; members: string[] }
  // This session started (on) or finished (off) a turn for messages in a room
  // it joined. Repeated while the turn runs; browsers drop it after
  // WORKING_TTL_MS without a repeat. Only the fact is shared, never the work.
  | { action: 'working'; reqId?: string; roomId: string; on: boolean; state?: WorkingState }
  // A short-lived link to one attachment of a room this agent is in.
  // Replies { url, name, type, size }.
  | { action: 'attachment'; reqId?: string; roomId: string; fileId: string }
  // A picture for this agent, drawn by Claude as SVG. Goes to the OWNER's
  // tabs as a card; nothing changes until they choose Use it.
  | { action: 'propose_avatar'; reqId?: string; svg: string; note?: string }
  // A task this session runs for its owner in a subagent: one its owner gave
  // in a room, or a colleague's request the owner approved. 'running' when it
  // starts, then 'done', 'stopped' or 'failed'. The room sees a system line and
  // a chip; only the owner can stop it (POST /api/agents/<id>/tasks/<taskId>/stop).
  | { action: 'task'; reqId?: string; roomId: string; taskId: string; title: string; state: TaskState };

// How long a browser shows "… is working" without a repeat of the frame.
export const WORKING_TTL_MS = 100_000;
// waiting = the turn is held on a tool approval from the owner (which tool stays private).
export type WorkingState = 'working' | 'waiting';
export interface WorkingSignal { roomId: string; agentId: string; agentName: string; ownerEmail: string; ownerName: string; session: string; on: boolean; state: WorkingState }

// A task an agent session runs for its owner (see the 'task' action).
export type TaskState = 'running' | 'done' | 'stopped' | 'failed';
export const TASK_STATES: TaskState[] = ['running', 'done', 'stopped', 'failed'];
export const TASK_ID_RE = /^tk_[a-z0-9]{12}$/;
export const MAX_TASK_TITLE = 120;
// How long a finished task's row is kept (and a running one, if its session vanishes).
export const TASK_TTL_HOURS = 24;
export interface RoomTask { roomId: string; taskId: string; agentId: string; agentName: string; ownerEmail: string; ownerName: string; session: string; title: string; state: TaskState; startedAt: number; endedAt?: number }
// One line, no markup that could pass for someone else's words.
export function cleanTaskTitle(t: unknown): string {
  return String(t ?? '').replace(/\s+/g, ' ').replace(/[<>]/g, '').trim().slice(0, MAX_TASK_TITLE);
}

// The room's run of agent messages in a row. At `cap` the agents pause: what
// they post wakes nobody until a person writes there or presses Resume.
export interface AgentStreak { roomId: string; streak: number; cap: number; paused: boolean }

// One room as `rooms` lists it for the plugin.
export interface RoomListing { id: string; name: string; joined: boolean; agentMember: boolean; members: Member[]; type?: RoomType; description?: string; archived?: boolean }

// server -> client
// Seen: how far a person has read in a room (the newest message they've
// seen). Only people, never agents; it only moves forward. messageId ''
// in a 'read' frame: that person turned read receipts off (drop theirs).
// (When they read isn't sent anywhere; only how far.)
export interface RoomRead { email: string; name: string; messageId: string }
export const MESSAGE_ID_RE = /^[0-9a-z]{9}[A-Za-z0-9_-]{8}$/;

export type ServerFrame =
  | { type: 'read'; roomId: string; read: RoomRead }                 // a person here read further
  | { type: 'hello'; reqId?: string; agent: AgentInfo; session?: SessionRef; rooms: RoomSummary[]; missed: Array<{ message: ChatMessage; wake: boolean; addressed?: boolean }> }
  | { type: 'message'; message: ChatMessage; wake?: boolean; addressed?: boolean }
  // to the room's people only: someone's reaction changed (emoji null: taken off)
  | { type: 'reaction'; roomId: string; messageId: string; by: { kind: PrincipalKind; id: string; name: string }; emoji: string | null; ts: number }
  | { type: 'room'; room: RoomSummary }
  | { type: 'room_removed'; roomId: string }
  | { type: 'working'; working: WorkingSignal }                // to the room's people only
  | { type: 'task'; task: RoomTask }                           // to the room's people only
  | { type: 'streak'; streak: AgentStreak }                    // people: every change; agent sessions in the room: pause and resume
  | { type: 'task_stop'; roomId: string; taskId: string }      // to the session running it: its owner pressed Stop
  | { type: 'agent'; agent: AgentInfo }
  | { type: 'session'; session: SessionRef }                   // this connection's own session changed
  | { type: 'ack'; reqId?: string; data?: unknown }
  | { type: 'error'; reqId?: string; code: string; message: string }
  | { type: 'replaced' }                                         // legacy (0.5 plugins)
  | { type: 'pong'; reqId?: string }
  // to the OWNER's browser tabs only — never to a room
  | { type: 'permission_request'; request: PermissionRequest }
  | { type: 'permission_resolved'; agentId: string; requestId: string; behavior: PermissionBehavior | 'expired'; scope?: PermissionScope }
  // to the asking session only, after the owner decided
  | { type: 'permission_verdict'; requestId: string; behavior: PermissionBehavior; scope?: PermissionScope }
  // owner-approval of a colleague's request: card to the OWNER only, decision to the asking session only
  | { type: 'ask_request'; ask: OwnerAsk }
  | { type: 'ask_resolved'; agentId: string; askId: string }
  | { type: 'ask_decision'; ask: OwnerAsk }
  // to the OWNER's browser tabs only
  | { type: 'avatar_proposal'; proposal: AvatarProposal }
  | { type: 'avatar_proposal_cleared'; agentId: string };
