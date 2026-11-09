// End-to-end check of dist/bridge.cjs against a fake backend, driven exactly
// as the hooks module drives it: config on stdin, commands over the Unix
// socket with the secret, events read from stdout. Covers: pairing (with the
// email hint) -> hello with a session -> join -> wake formatting with context
// -> reply -> owner decision -> permission verdict -> reconnect re-attach.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';

const owner = 'owner@example.com';
const SECRET = 'test-secret-0123456789';
const room = { id: 'rm_1', name: 'general', createdBy: owner, createdAt: 0, members: [] };
const agent = { id: 'ag_a', name: 'owner-ai', ownerEmail: owner, ownerName: 'Owner Person', createdAt: 0 };

async function main() {
  // --- fake backend: HTTP pairing + WebSocket
  let pairPolls = 0;
  let pairStart: any = null;
  const web = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const b = body ? JSON.parse(body) : {};
      if (req.url === '/api/pair/start') { pairStart = b; res.writeHead(201).end(JSON.stringify({ code: 'ABCD-EFGH', secret: 'ps_x', url: 'http://web/pair?code=ABCD-EFGH', expiresAt: Date.now() + 60_000 })); return; }
      if (req.url === '/api/pair/poll') {
        assert.equal(b.secret, 'ps_x');
        if (++pairPolls < 2) { res.writeHead(202).end('{"status":"pending"}'); return; }
        res.writeHead(200).end(JSON.stringify({ token: 'ac_paired', agent })); return;
      }
      res.writeHead(404).end('{}');
    });
  });
  await new Promise<void>((r) => web.listen(0, '127.0.0.1', () => r()));
  const webPort = (web.address() as any).port;

  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss.once('listening', r));
  const wsPort = (wss.address() as any).port;
  let sock!: WebSocket;
  const frames: any[] = [];
  const frameWaiters: Array<(f: any) => void> = [];
  let connects = 0;
  wss.on('connection', (s, req) => {
    connects++;
    assert.equal(req.headers.authorization, 'Bearer ac_paired');
    assert.match(String(req.headers['user-agent']), /^agent-chat-plugin\/0\.6\./);
    sock = s;
    s.on('message', (raw) => {
      const f = JSON.parse(String(raw));
      if (f.action === 'ping') return;
      frames.push(f);
      frameWaiters.shift()?.(f);
    });
  });
  const nextFrame = () => new Promise<any>((r) => frameWaiters.push(r));
  const reply = (f: any, data: any) => sock.send(JSON.stringify({ type: 'ack', reqId: f.reqId, data }));

  // --- the bridge, as the module starts it
  const home = mkdtempSync(join(tmpdir(), 'agent-chat-home-'));
  const socketPath = join(mkdtempSync(join(tmpdir(), 'acb-')), 'b.sock');
  const child = spawn('node', [join(__dirname, '..', 'plugin', 'dist', 'bridge.cjs')], {
    env: { ...process.env, HOME: home, AGENT_CHAT_URL: `ws://127.0.0.1:${wsPort}`, AGENT_CHAT_WEB_URL: `http://127.0.0.1:${webPort}`, AGENT_CHAT_PAIR_POLL_MS: '50', AGENT_CHAT_NO_BROWSER: '1' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  child.stdin.end(JSON.stringify({ secret: SECRET, socketPath, sessionId: 'ss_test_session_1', label: 'agent-chat:main:mbp', emailHint: owner }));
  const events: any[] = [];
  const eventWaiters: Array<{ pred: (e: any) => boolean; resolve: (e: any) => void }> = [];
  let buf = '';
  child.stdout.on('data', (c) => {
    buf += c;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const ev = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      events.push(ev);
      for (const w of [...eventWaiters]) if (w.pred(ev)) { eventWaiters.splice(eventWaiters.indexOf(w), 1); w.resolve(ev); }
    }
  });
  const nextEvent = (pred: (e: any) => boolean) => {
    const seen = events.find(pred);
    return seen ? Promise.resolve(seen) : new Promise<any>((resolve) => eventWaiters.push({ pred, resolve }));
  };
  const cmd = (method: string, path: string, body?: unknown, secret = SECRET) => new Promise<{ status: number; data: any }>((resolve, reject) => {
    const req = http.request({ socketPath, path, method, headers: { 'x-bridge-secret': secret, 'content-type': 'application/json' } }, (res) => {
      let raw = ''; res.on('data', (c) => (raw += c)); res.on('end', () => resolve({ status: res.statusCode!, data: JSON.parse(raw || '{}') }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });

  try {
    await nextEvent((e) => e.type === 'ready');
    assert.equal((await cmd('GET', '/status', undefined, 'wrong')).status, 403, 'needs the secret');

    // 1. no token -> pairing, with the email hint; then linked -> connect
    const pairing = await nextEvent((e) => e.type === 'pairing');
    assert.deepEqual([pairing.url, pairing.code], ['http://web/pair?code=ABCD-EFGH', 'ABCD-EFGH']);
    assert.equal(pairStart.email, owner, 'pairing carries the Claude Code login as a hint');
    const helloP = nextFrame();
    await nextEvent((e) => e.type === 'linked');
    assert.match(readFileSync(join(home, '.claude', 'channels', 'agent-chat', '.env'), 'utf8'), /AGENT_CHAT_TOKEN=ac_paired/);

    // 2. hello carries the session
    const hello = await helloP;
    assert.deepEqual([hello.action, hello.version, hello.features], ['hello', '0.6.1', ['sessions']]);
    assert.deepEqual(hello.session, { id: 'ss_test_session_1', label: 'agent-chat:main:mbp', rooms: [] });
    sock.send(JSON.stringify({ type: 'hello', reqId: hello.reqId, agent, session: { id: 'ss_test_session_1', label: 'agent-chat:main:mbp' }, rooms: [], missed: [] }));
    await nextEvent((e) => e.type === 'status' && e.state === 'online');

    // 3. join by name
    const joinF = nextFrame();
    const joining = cmd('POST', '/join', { room: 'general' });
    const jf = await joinF;
    assert.deepEqual([jf.action, jf.room], ['join', 'general']);
    reply(jf, room);
    assert.equal((await joining).data.id, 'rm_1');
    // join errors surface as errors
    const badF = nextFrame();
    const bad = cmd('POST', '/join', { room: 'nope' });
    sock.send(JSON.stringify({ type: 'error', reqId: (await badF).reqId, code: 'no_room', message: 'No room "nope"' }));
    assert.deepEqual([(await bad).status, (await bad).data.error], [409, 'No room "nope"']);

    // 4. a non-waking message becomes context for the next waking one
    const msg = (id: string, text: string, extra: any = {}) => ({ id, roomId: 'rm_1', authorKind: 'user', authorId: 'colleague@example.com', authorName: 'Colleague', text, ts: 0, ...extra });
    sock.send(JSON.stringify({ type: 'message', message: msg('zz0000001', 'hi @bob'), wake: false }));
    sock.send(JSON.stringify({ type: 'message', message: { ...msg('zz0000002', 'unjoined room'), roomId: 'rm_other' }, wake: true }));
    const wakeP = nextEvent((e) => e.type === 'wake');
    sock.send(JSON.stringify({ type: 'message', message: msg('zz0000003', 'what is "our" region?', { authorId: owner, authorName: 'Owner' }), wake: true, addressed: true }));
    const wake = await wakeP;
    assert.equal(events.filter((e) => e.type === 'wake').length, 1, 'rooms this session did not join are ignored');
    assert.match(wake.text, /^<agent-chat room_id="rm_1" room="general" from="Owner \(@owner\)" from_kind="user" from_is_owner="true" addressed="true" message_id="zz0000003">\n/);
    assert.match(wake.text, /\[earlier in #general\]\nColleague \(@colleague\): hi @bob\n---\nwhat is "our" region\?\n<\/agent-chat>$/);
    assert.ok(events.some((e) => e.type === 'cursor' && e.roomId === 'rm_1' && e.id === 'zz0000003'), 'cursor reported for the module to keep');
    // an agent's message names its session; this session's own messages never wake it
    const wake2P = nextEvent((e) => e.type === 'wake' && /agent-b/.test(e.text));
    sock.send(JSON.stringify({ type: 'message', message: msg('zz0000004', 'mine', { authorKind: 'agent', authorId: 'ag_a', authorName: 'owner-ai', session: 'agent-chat:main:mbp' }), wake: true }));
    sock.send(JSON.stringify({ type: 'message', message: msg('zz0000005', '@owner-ai ping', { authorKind: 'agent', authorId: 'ag_b', authorName: 'bob-ai', ownerName: 'Bob', session: 'api:main:agent-b' }), wake: true, addressed: true }));
    const wake2 = await wake2P;
    assert.match(wake2.text, /from="@bob-ai \(Bob's agent, session api:main:agent-b\)" from_kind="agent" from_is_owner="false" addressed="true"/);
    assert.doesNotMatch(wake2.text, /mine/);

    // 5. reply + summary update
    const sendF = nextFrame();
    const sending = cmd('POST', '/send', { roomId: 'rm_1', text: 'us-west-2' });
    const sf = await sendF;
    assert.deepEqual([sf.action, sf.roomId, sf.text], ['send', 'rm_1', 'us-west-2']);
    reply(sf, { id: 'zz0000006', capped: false });
    assert.equal((await sending).data.capped, false);
    const sessF = nextFrame();
    const sess = cmd('POST', '/session', { summary: 'reviewing pairing' });
    const ssf = await sessF;
    assert.deepEqual([ssf.action, ssf.summary], ['session', 'reviewing pairing']);
    reply(ssf, { id: 'ss_test_session_1', label: 'agent-chat:main:mbp', summary: 'reviewing pairing' });
    assert.equal((await sess).data.summary, 'reviewing pairing');

    // 6. owner decision on a colleague's request wakes Claude with the outcome
    const decP = nextEvent((e) => e.type === 'wake' && /owner_decision/.test(e.text));
    sock.send(JSON.stringify({ type: 'ask_decision', ask: { askId: 'ak_1', agentId: 'ag_a', agentName: 'owner-ai', roomId: 'rm_1', roomName: 'general', messageId: 'zz0000001', requesterName: 'Colleague', requestText: 'check prod', summary: 'run the check', createdAt: 0, expiresAt: 0, status: 'allow' } }));
    assert.match((await decP).text, /status="owner_decision" decision="allow"[\s\S]*APPROVED Colleague's request/);

    // 7. permission: request goes up, the owner's verdict comes back to a waiting long-poll
    const permF = nextFrame();
    const perm = cmd('POST', '/permission', { requestId: 'abcde', toolName: 'Bash', description: 'rm', inputPreview: '{}', nonceHash: 'a'.repeat(64) });
    const pf = await permF;
    assert.deepEqual([pf.action, pf.requestId, pf.nonceHash], ['permission_request', 'abcde', 'a'.repeat(64)]);
    reply(pf, { requestId: 'abcde' });
    await perm;
    const waiting = cmd('POST', '/permission/wait', { requestId: 'abcde', waitMs: 5000 });
    await new Promise((r) => setTimeout(r, 50));
    sock.send(JSON.stringify({ type: 'permission_verdict', requestId: 'abcde', behavior: 'deny' }));
    assert.equal((await waiting).data.behavior, 'deny');
    assert.equal((await cmd('POST', '/permission/wait', { requestId: 'zzzzz', waitMs: 50 })).data.behavior, null, 'times out empty');
    // a second request is still waiting when the connection drops (step 8)
    const pend2F = nextFrame();
    const pend2 = cmd('POST', '/permission', { requestId: 'fghij', toolName: 'Bash', description: 'ls', inputPreview: '{}', nonceHash: 'b'.repeat(64) });
    reply(await pend2F, { requestId: 'fghij' });
    await pend2;

    // 8. reconnect: hello re-attaches the joined rooms with cursors
    const rehelloP = nextFrame();
    sock.terminate();
    const rehello = await rehelloP;
    assert.deepEqual(rehello.session.rooms, ['rm_1']);
    assert.equal(rehello.cursors.rm_1, 'zz0000006');
    assert.equal(rehello.session.summary, 'reviewing pairing', 'summary survives a reconnect');
    assert.equal(connects, 2);

    // 9. leave
    const reraiseP = nextFrame();
    sock.send(JSON.stringify({ type: 'hello', reqId: rehello.reqId, agent, session: { id: 'ss_test_session_1', label: 'agent-chat:main:mbp' }, rooms: [room], missed: [] }));
    const rr = await reraiseP;
    assert.deepEqual([rr.action, rr.requestId, rr.nonceHash], ['permission_request', 'fghij', 'b'.repeat(64)], 'a still-pending request is raised again after a reconnect (the answered one is not)');
    reply(rr, { requestId: 'fghij' });
    await nextEvent((e) => e.type === 'status' && e.state === 'online' && e.rooms.length === 1 && events.indexOf(e) > events.findIndex((x) => x.type === 'wake' && /owner_decision/.test(x.text)));
    const leaveF = nextFrame();
    const leaving = cmd('POST', '/leave', {});
    reply(await leaveF, { left: ['rm_1'] });
    assert.deepEqual((await leaving).data.left, [{ id: 'rm_1', name: 'general' }]);

    console.log('bridge: ok');
  } finally {
    child.kill();
    wss.close(); web.close();
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
