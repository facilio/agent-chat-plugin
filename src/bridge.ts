// Agent Chat bridge: one per Claude Code session that uses /agent-chat.
//
// The hooks module (plugin/hooks/register.ts) can't hold a WebSocket, so it
// spawns this with `$.process.spawn` and talks to it two ways:
//   - commands: HTTP over a private Unix socket ($.http.fetch socketPath),
//     every request carrying the per-session secret the module wrote to our
//     stdin (so nothing else on the machine — the model's Bash included — can
//     drive it);
//   - events:   one JSON object per line on stdout (wakes, pairing, status).
//
// It holds this session's connection to the backend (authenticated with the
// machine's ac_ device token), the rooms the session joined, per-room cursors,
// and the device pairing flow when the machine has no token yet.
//
// Everything sent on the socket is authored as the AGENT — the backend decides
// that from the token, not from anything in the frame.
import WebSocket from 'ws';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { userHandle, type AgentInfo, type ChatMessage, type RoomListing, type RoomSummary, type ServerFrame, type SessionRef } from '../plugin/hooks/protocol';

const VERSION = '0.6.0';
// AGENT_CHAT_STATE_DIR keeps a dev backend's token apart from the real one.
const STATE_DIR = process.env.AGENT_CHAT_STATE_DIR || join(homedir(), '.claude', 'channels', 'agent-chat');
const WEB_URL = process.env.AGENT_CHAT_WEB_URL ?? 'https://chat.facilio.bot';
const WS_URL = process.env.AGENT_CHAT_URL ?? 'wss://chat-ws.facilio.bot';
const CONTEXT_PER_ROOM = 20;

interface Config {
  secret: string;
  socketPath: string;
  sessionId: string;
  label: string;
  summary?: string;
  rooms?: string[];                    // re-attach after a module reload
  cursors?: Record<string, string>;
  emailHint?: string;                  // Claude Code's login, for the pairing page's warning
  noBrowser?: boolean;
}

const log = (...a: unknown[]) => console.error('[agent-chat bridge]', ...a);
const emit = (event: Record<string, unknown>) => { process.stdout.write(`${JSON.stringify(event)}\n`); };

// ------------------------------------------------------------------- token
function loadToken(): string | null {
  if (process.env.AGENT_CHAT_TOKEN) return process.env.AGENT_CHAT_TOKEN.trim();
  try {
    const env = readFileSync(join(STATE_DIR, '.env'), 'utf8');
    const m = env.match(/^\s*AGENT_CHAT_TOKEN\s*=\s*['"]?([^'"\s]+)/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}
function saveToken(token: string) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(join(STATE_DIR, '.env'), `AGENT_CHAT_TOKEN=${token}\n`, { mode: 0o600 });
}

// ------------------------------------------------------------------- state
let cfg!: Config;
let me: AgentInfo | null = null;
let session: SessionRef | null = null;
let joined = new Set<string>();                    // rooms this session is attached to
const rooms = new Map<string, RoomSummary>();       // summaries of joined rooms
let cursors: Record<string, string> = {};
const unseen = new Map<string, ChatMessage[]>();   // delivered but didn't wake: context for the next wake
let state: 'starting' | 'pairing' | 'connecting' | 'online' | 'offline' | 'stopped' = 'starting';
let stopped: string | null = null;
let pairing: { url: string; code: string } | null = null;

function status(message?: string) {
  emit({ type: 'status', state, message, me, session, rooms: [...joined].map((id) => ({ id, name: rooms.get(id)?.name ?? id })), pairing });
}

function advance(roomId: string, msgId: string) {
  if (!cursors[roomId] || cursors[roomId] < msgId) { cursors[roomId] = msgId; emit({ type: 'cursor', roomId, id: msgId }); }
}
// Message ids start with 9 chars of base36 epoch-ms, so this sorts before
// anything sent from now on.
const nowCursor = () => Date.now().toString(36).padStart(9, '0');

// --------------------------------------------------------------- wake text
const attr = (v: string) => v.replace(/[&"<>\n]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;', '\n': ' ' }[c]!));
// With the @handle to use when answering: people are @<email-name>, agents
// @<handle> (and @<handle>:<repo> for one of several sessions).
const who = (m: ChatMessage) => m.authorKind === 'agent'
  ? `@${m.authorName} (${m.ownerName}'s agent${m.session ? `, session ${m.session}` : ''})`
  : m.authorKind === 'user' ? `${m.authorName} (@${userHandle(m.authorId)})` : m.authorName;

function wakeFor(roomId: string, woke: ChatMessage[], addressed: boolean) {
  const roomName = rooms.get(roomId)?.name ?? roomId;
  const context = unseen.get(roomId) ?? [];
  unseen.delete(roomId);
  const last = woke[woke.length - 1];
  const lines: string[] = [];
  if (context.length) {
    lines.push(`[earlier in #${roomName}]`);
    for (const m of context) lines.push(`${m.authorKind === 'system' ? '·' : who(m) + ':'} ${m.text}`);
    lines.push('---');
  }
  for (const m of woke.slice(0, -1)) lines.push(`${who(m)}: ${m.text}`);
  lines.push(woke.length > 1 ? `${who(last)}: ${last.text}` : last.text);
  const isOwner = last.authorKind === 'user' && !!me && last.authorId === me.ownerEmail;
  const tag = `<agent-chat room_id="${attr(roomId)}" room="${attr(roomName)}" from="${attr(who(last))}" from_kind="${last.authorKind}" `
    + `from_is_owner="${isOwner}" addressed="${addressed}" message_id="${attr(last.id)}">`;
  emit({ type: 'wake', roomId, addressed, text: `${tag}\n${lines.join('\n')}\n</agent-chat>` });
}

function remember(m: ChatMessage) {
  const list = unseen.get(m.roomId) ?? [];
  list.push(m);
  if (list.length > CONTEXT_PER_ROOM) list.splice(0, list.length - CONTEXT_PER_ROOM);
  unseen.set(m.roomId, list);
}

function onIncoming(items: Array<{ message: ChatMessage; wake: boolean; addressed?: boolean }>) {
  const wakes = new Map<string, ChatMessage[]>();
  const addressedRooms = new Set<string>();
  for (const { message, wake, addressed } of items) {
    advance(message.roomId, message.id);
    if (me && message.authorKind === 'agent' && message.authorId === me.id && message.session === session?.label) continue;
    if (wake) {
      if (addressed) addressedRooms.add(message.roomId);
      const w = wakes.get(message.roomId) ?? [];
      w.push(message);
      wakes.set(message.roomId, w);
    } else {
      remember(message);
    }
  }
  for (const [roomId, woke] of wakes) wakeFor(roomId, woke, addressedRooms.has(roomId));
}

// ---------------------------------------------------------------- WebSocket
let ws: WebSocket | null = null;
let backoff = 1000;
let reqSeq = 0;
const pending = new Map<string, { resolve: (f: ServerFrame) => void; timer: NodeJS.Timeout }>();
const verdictWaiters = new Map<string, Array<(behavior: string) => void>>();
const verdicts = new Map<string, string>();

function request(frame: Record<string, unknown>, timeoutMs = 15000): Promise<ServerFrame> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN || state !== 'online') {
      reject(new Error(stopped ?? (state === 'pairing' ? 'Waiting for you to link this computer (open the link)' : 'Not connected to Agent Chat right now; retry in a few seconds')));
      return;
    }
    const reqId = `r${++reqSeq}`;
    const timer = setTimeout(() => { pending.delete(reqId); reject(new Error('Agent Chat did not answer in time')); }, timeoutMs);
    pending.set(reqId, { resolve, timer });
    ws.send(JSON.stringify({ ...frame, reqId }));
  });
}

async function call(frame: Record<string, unknown>): Promise<any> {
  const f = await request(frame);
  if (f.type === 'error') throw Object.assign(new Error(f.message), { code: f.code });
  if (f.type === 'ack') return f.data;
  return f;
}

// Resolves once the hello round-trip is done (or the connection gave up).
let onlineWaiters: Array<() => void> = [];
const whenOnline = (ms = 20000) => new Promise<void>((resolve, reject) => {
  if (state === 'online') { resolve(); return; }
  const t = setTimeout(() => reject(new Error(stopped ?? 'Not connected to Agent Chat yet')), ms);
  onlineWaiters.push(() => { clearTimeout(t); resolve(); });
});

function connect(token: string) {
  if (stopped) return;
  state = 'connecting';
  const sock = new WebSocket(WS_URL, { headers: { authorization: `Bearer ${token}`, 'user-agent': `agent-chat-plugin/${VERSION}` } });
  ws = sock;
  let ping: NodeJS.Timeout | null = null;

  sock.on('open', () => {
    backoff = 1000;
    // API Gateway closes sockets idle for 10 minutes.
    ping = setInterval(() => sock.readyState === WebSocket.OPEN && sock.send('{"action":"ping"}'), 4 * 60_000);
    sock.send(JSON.stringify({
      action: 'hello', reqId: 'hello', version: VERSION, features: ['sessions'], cursors,
      session: { id: cfg.sessionId, label: session?.label ?? cfg.label, summary: session ? session.summary : cfg.summary, rooms: [...joined] },
    }));
  });

  sock.on('unexpected-response', (_req, res) => {
    if (res.statusCode === 401 || res.statusCode === 403) {
      // Unlinked or removed: don't retry the dead token, link again.
      stopped = 'This computer was unlinked from Agent Chat; linking again.';
      void startPairing('This computer was unlinked from Agent Chat.');
    } else if (res.statusCode === 426) {
      stopped = 'Agent Chat needs a newer plugin: run /plugin update agent-chat@facilio.';
      state = 'stopped'; status(stopped);
    }
    sock.terminate();
  });

  sock.on('message', (raw) => {
    let f: ServerFrame;
    try { f = JSON.parse(String(raw)); } catch { return; }
    const reqId = (f as { reqId?: string }).reqId;
    if (reqId && pending.has(reqId)) {
      const p = pending.get(reqId)!;
      clearTimeout(p.timer);
      pending.delete(reqId);
      p.resolve(f);
    }
    switch (f.type) {
      case 'hello': {
        me = f.agent;
        if (f.session) session = f.session;
        rooms.clear();
        joined = new Set(f.rooms.map((r) => r.id));
        for (const r of f.rooms) {
          rooms.set(r.id, r);
          if (!cursors[r.id]) advance(r.id, nowCursor());
        }
        state = 'online';
        onIncoming(f.missed);
        status();
        for (const w of onlineWaiters.splice(0)) w();
        break;
      }
      case 'error':
        if (reqId === 'hello') { stopped = f.message; state = 'stopped'; status(f.message); }
        break;
      case 'message':
        if (!joined.has(f.message.roomId)) break;
        onIncoming([{ message: f.message, wake: !!f.wake, addressed: f.addressed }]);
        break;
      case 'room':
        if (joined.has(f.room.id)) rooms.set(f.room.id, f.room);
        break;
      case 'room_removed':
        joined.delete(f.roomId); rooms.delete(f.roomId); unseen.delete(f.roomId);
        status(`Removed from #${f.roomId}`);
        break;
      case 'agent':
        if (me && f.agent.id === me.id) { me = { ...me, ...f.agent }; status(); }
        break;
      case 'ask_decision': {
        // The owner's button press on a colleague's request, relayed by the
        // backend only after checking the clicker owns this agent.
        const a = f.ask;
        const allowed = a.status === 'allow';
        emit({
          type: 'wake', roomId: a.roomId, addressed: true,
          text: `<agent-chat room_id="${attr(a.roomId)}" room="${attr(a.roomName)}" from="${attr(me?.ownerName ?? 'owner')}" from_kind="user" from_is_owner="true" status="owner_decision" decision="${allowed ? 'allow' : 'deny'}" ask_id="${attr(a.askId)}" message_id="${attr(a.messageId)}">\n`
            + `Your owner ${allowed ? 'APPROVED' : 'DECLINED'} ${a.requesterName}'s request in #${a.roomName}: "${a.requestText}"\n`
            + `You had said you would: ${a.summary}\n`
            + (allowed ? 'Go ahead with exactly that, then reply in the room with the result.' : 'Do not do it. Reply in the room that your owner declined.')
            + '\n</agent-chat>',
        });
        break;
      }
      case 'permission_verdict':
        // Only the backend can put frames on this authenticated socket, and it
        // only sends a verdict after checking the clicker owns this agent.
        if (f.behavior === 'allow' || f.behavior === 'deny') {
          verdicts.set(f.requestId, f.behavior);
          for (const w of verdictWaiters.get(f.requestId) ?? []) w(f.behavior);
          verdictWaiters.delete(f.requestId);
          emit({ type: 'verdict', requestId: f.requestId, behavior: f.behavior });
        }
        break;
    }
  });

  sock.on('close', () => {
    if (ping) clearInterval(ping);
    for (const [id, p] of pending) { clearTimeout(p.timer); pending.delete(id); p.resolve({ type: 'error', code: 'disconnected', message: 'Connection dropped; retry' }); }
    if (stopped) return;
    state = 'offline'; status();
    setTimeout(() => connect(token), backoff);
    backoff = Math.min(backoff * 2, 30_000);
  });

  sock.on('error', (e) => log('socket error', e.message));
}

// ---------------------------------------------------------- device pairing
// No token (first use on this machine) or a dead one: ask the backend for a
// link, show it (and open it on a desktop), and poll with a secret only this
// process knows until a signed-in human clicks Link. Then save the token and
// connect. The pending pairing survives a restart of this process (module
// reloads restart it), so a click that lands meanwhile is still collected.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pairingActive = false;
type PendingPair = { code: string; secret: string; url: string; expiresAt: number };
const PAIR_FILE = join(STATE_DIR, 'pairing.json');
function loadPendingPair(): PendingPair | null {
  try {
    const p = JSON.parse(readFileSync(PAIR_FILE, 'utf8')) as PendingPair;
    return p.expiresAt > Date.now() + 15_000 ? p : null;
  } catch { return null; }
}
function savePendingPair(p: PendingPair) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(PAIR_FILE, JSON.stringify(p), { mode: 0o600 });
}
const clearPendingPair = () => { try { rmSync(PAIR_FILE, { force: true }); } catch { /* gone */ } };

function openBrowser(url: string) {
  if (cfg.noBrowser || process.env.AGENT_CHAT_NO_BROWSER === '1' || process.env.SSH_CONNECTION) return;
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'linux' && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) ? 'xdg-open' : null;
  if (!cmd) return;
  try { spawn(cmd, [url], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref(); } catch { /* best effort */ }
}

async function postJson(path: string, body: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(`${WEB_URL}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': `agent-chat-plugin/${VERSION}` }, body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function startPairing(reason?: string, fresh = false) {
  if (pairingActive) return;
  pairingActive = true;
  state = 'connecting';   // 'pairing' only once the server says the link is still waiting
  try {
    let p = reason || fresh ? null : loadPendingPair();
    const resumed = !!p;
    if (!p) {
      clearPendingPair();
      const start = await postJson('/api/pair/start', { hostname: hostname(), platform: process.platform, email: cfg.emailHint });
      if (start.status !== 201) throw new Error(`pairing unavailable (${start.status})`);
      p = start.data as PendingPair;
      savePendingPair(p);
    }
    const { code, secret, url, expiresAt } = p;
    let first = true;
    let announced = false;
    while (Date.now() < expiresAt) {
      if (!(first && resumed)) await sleep(first ? 0 : Number(process.env.AGENT_CHAT_PAIR_POLL_MS ?? 3000));
      first = false;
      let r: { status: number; data: any };
      try { r = await postJson('/api/pair/poll', { code, secret }); } catch { continue; } // offline blip: keep waiting
      if (r.status === 202) {
        if (!announced) {
          announced = true;
          state = 'pairing'; pairing = { url, code };
          emit({ type: 'pairing', url, code, reason });
          status();
          if (!resumed) openBrowser(url);
        }
        continue;
      }
      if (r.status === 200 && typeof r.data.token === 'string') {
        clearPendingPair();
        saveToken(r.data.token);
        stopped = null; pairing = null;
        emit({ type: 'linked', agent: r.data.agent });
        connect(r.data.token);
        return;
      }
      if (r.status === 409 || r.status === 410) clearPendingPair();
      if (r.status === 409) { stopped = String(r.data.error); break; }
      if (r.status === 410) { stopped = r.data.error === 'denied' ? 'Linking was cancelled in the browser.' : 'The link expired.'; break; }
    }
    if (!stopped) { clearPendingPair(); stopped = 'The link expired.'; }
    pairing = null; state = 'stopped';
    emit({ type: 'pairing_failed', message: `${stopped} Run /agent-chat connect to get a new link.` });
    status(stopped);
  } catch (e) {
    stopped = `Could not reach Agent Chat to link this computer (${e instanceof Error ? e.message : e}).`;
    pairing = null; state = 'stopped';
    emit({ type: 'pairing_failed', message: `${stopped} Check your network, then run /agent-chat connect.` });
    status(stopped);
  } finally {
    pairingActive = false;
  }
}

function start(freshLink = false) {
  stopped = null;
  const token = loadToken();
  if (!token) { void startPairing(undefined, freshLink); return; }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  connect(token);
}

// ------------------------------------------------------- command interface
type Handler = (body: any, url: URL) => Promise<unknown>;
const routes: Record<string, Handler> = {
  'GET /status': async () => ({ state, message: stopped, me, session, rooms: [...joined].map((id) => ({ id, name: rooms.get(id)?.name ?? id })), pairing }),
  'POST /connect': async (b) => {
    if (b.fresh) { stopped = null; clearPendingPair(); }
    start(!!b.fresh);
    return { state, pairing };
  },
  'POST /join': async (b) => {
    await whenOnline(b.waitMs ?? 20000);
    const room = await call({ action: 'join', room: String(b.room ?? '') }) as RoomSummary;
    joined.add(room.id); rooms.set(room.id, room);
    if (!cursors[room.id]) advance(room.id, nowCursor());
    status();
    return room;
  },
  'POST /leave': async (b) => {
    const r = await call({ action: 'leave', roomId: b.roomId || undefined }) as { left: string[] };
    for (const id of r.left) { joined.delete(id); unseen.delete(id); }
    status();
    return { left: r.left.map((id) => ({ id, name: rooms.get(id)?.name ?? id })) };
  },
  'GET /rooms': async () => (await call({ action: 'rooms' })) as RoomListing[],
  'POST /send': async (b) => {
    const r = await call({ action: 'send', roomId: String(b.roomId), text: String(b.text ?? '') }) as { id: string; capped: boolean };
    advance(String(b.roomId), r.id);
    return r;
  },
  'POST /history': async (b) => call({ action: 'history', roomId: String(b.roomId), limit: b.limit, before: b.before }),
  'POST /session': async (b) => {
    const s = await call({ action: 'session', label: b.label, summary: b.summary }) as SessionRef;
    session = s; status();
    return s;
  },
  'POST /ask_owner': async (b) => call({ action: 'ask_owner', roomId: String(b.roomId), messageId: String(b.messageId), summary: String(b.summary ?? '') }),
  // Tool approval: put the card on the owner's tabs, then long-poll for a verdict.
  'POST /permission': async (b) => {
    await call({ action: 'permission_request', requestId: b.requestId, toolName: b.toolName, description: b.description, inputPreview: b.inputPreview, nonceHash: b.nonceHash });
    return { ok: true };
  },
  'POST /permission/wait': async (b) => {
    const id = String(b.requestId);
    if (verdicts.has(id)) return { behavior: verdicts.get(id) };
    const behavior = await new Promise<string | null>((resolve) => {
      const t = setTimeout(() => resolve(null), Math.min(Number(b.waitMs ?? 25000), 55000));
      const list = verdictWaiters.get(id) ?? [];
      list.push((v) => { clearTimeout(t); resolve(v); });
      verdictWaiters.set(id, list);
    });
    return { behavior };
  },
  // Answered in the terminal (the module's pane): tell the backend so the
  // owner's web card clears, and wake the hook's long-poll. 'terminal' = hand
  // the call back to Claude Code's own prompt (withdraws the web card).
  'POST /permission/answer': async (b) => {
    const id = String(b.requestId);
    const behavior = String(b.behavior);
    if (behavior === 'terminal') await call({ action: 'permission_cancel', requestId: id }).catch(() => {});
    else await call({ action: 'permission_answer', requestId: id, behavior, nonce: b.nonce }).catch(() => {});
    verdicts.set(id, behavior);
    for (const w of verdictWaiters.get(id) ?? []) w(behavior);
    verdictWaiters.delete(id);
    return { ok: true };
  },
  'POST /permission/cancel': async (b) => call({ action: 'permission_cancel', requestId: b.requestId }).catch(() => ({ ok: false })),
  'POST /shutdown': async () => { setTimeout(() => process.exit(0), 50); return { ok: true }; },
};

function serve(): Promise<void> {
  const srv = http.createServer((req, res) => {
    const send = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body)); };
    if (req.headers['x-bridge-secret'] !== cfg.secret) { send(403, { error: 'forbidden' }); return; }
    const url = new URL(req.url ?? '/', 'http://bridge');
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) { send(404, { error: 'not found' }); return; }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      let body: any = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { send(400, { error: 'bad json' }); return; }
      try { send(200, await route(body, url)); } catch (e: any) { send(e?.code === 'forbidden' ? 403 : 409, { error: e instanceof Error ? e.message : String(e), code: e?.code }); }
    });
  });
  return new Promise((resolve, reject) => {
    mkdirSync(dirname(cfg.socketPath), { recursive: true, mode: 0o700 });
    rmSync(cfg.socketPath, { force: true });
    srv.once('error', reject);
    srv.listen(cfg.socketPath, () => { try { chmodSync(cfg.socketPath, 0o600); } catch { /* best effort */ } resolve(); });
  });
}

// -------------------------------------------------------------------- main
async function readStdin(): Promise<string> {
  let raw = '';
  for await (const c of process.stdin) raw += c;
  return raw;
}

async function main() {
  cfg = JSON.parse(await readStdin()) as Config;
  if (!cfg.secret || !cfg.socketPath || !cfg.sessionId) throw new Error('bridge needs secret, socketPath and sessionId on stdin');
  cursors = { ...(cfg.cursors ?? {}) };
  joined = new Set(cfg.rooms ?? []);
  await serve();
  emit({ type: 'ready', version: VERSION });
  start();
  // The module unloading (or the session ending) closes our stdout: go.
  process.stdout.on('error', () => process.exit(0));
  const cleanup = () => { try { rmSync(cfg.socketPath, { force: true }); } catch { /* gone */ } process.exit(0); };
  process.on('SIGTERM', cleanup); process.on('SIGINT', cleanup); process.on('SIGHUP', cleanup);
  // Belt and braces: if our parent (Claude Code) is gone, so are we.
  const parent = process.ppid;
  setInterval(() => { try { process.kill(parent, 0); } catch { cleanup(); } }, 10_000).unref();
}

main().catch((e) => { log('fatal', e); emit({ type: 'fatal', message: e instanceof Error ? e.message : String(e) }); process.exit(1); });
