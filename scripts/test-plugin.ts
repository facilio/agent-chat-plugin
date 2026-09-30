// End-to-end check of the channel plugin against a fake backend: spawns the
// built plugin/dist/server.cjs exactly as Claude Code would (stdio MCP), and
// drives the onboarding -> wake -> reply -> replaced sequence.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const TOKEN = 'ac_test_token';
const owner = 'owner@example.com';
const room = { id: 'rm_1', name: 'general', createdBy: owner, createdAt: 0, members: [] };

async function main() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss.once('listening', r));
  const port = (wss.address() as any).port;
  let sock!: WebSocket;
  const frames: any[] = [];
  const frameWaiters: Array<(f: any) => void> = [];
  wss.on('connection', (s, req) => {
    assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
    sock = s;
    s.on('message', (raw) => {
      const f = JSON.parse(String(raw));
      if (f.action === 'ping') return;
      frames.push(f);
      frameWaiters.shift()?.(f);
    });
  });
  const nextFrame = () => new Promise<any>((r) => frameWaiters.push(r));

  const notes: any[] = [];
  const noteWaiters: Array<(n: any) => void> = [];
  const nextNote = () => new Promise<any>((r) => noteWaiters.push(r));

  const client = new Client({ name: 'test', version: '0' });
  const verdicts: any[] = [];
  const verdictWaiters: Array<(v: any) => void> = [];
  const nextVerdict = () => new Promise<any>((r) => verdictWaiters.push(r));
  client.fallbackNotificationHandler = async (n: any) => {
    if (n.method === 'notifications/claude/channel') { notes.push(n.params); noteWaiters.shift()?.(n.params); }
    if (n.method === 'notifications/claude/channel/permission') { verdicts.push(n.params); verdictWaiters.shift()?.(n.params); }
  };
  const home = mkdtempSync(join(tmpdir(), 'agent-chat-test-'));
  const helloFrame = nextFrame();
  await client.connect(new StdioClientTransport({
    command: 'node', args: [join(__dirname, '..', 'plugin', 'dist', 'server.cjs')],
    env: { ...process.env, HOME: home, AGENT_CHAT_URL: `ws://127.0.0.1:${port}`, AGENT_CHAT_TOKEN: TOKEN, AGENT_CHAT_PARENT_ARGV: '/usr/local/bin/claude --dangerously-load-development-channels plugin:agent-chat@facilio' } as Record<string, string>,
  }));

  // 1. hello -> unnamed agent -> Claude is asked to register
  const hello = await helloFrame;
  assert.equal(hello.action, 'hello');
  const needsName = nextNote();
  sock.send(JSON.stringify({ type: 'hello', reqId: hello.reqId, agent: { id: 'ag_a', name: null, ownerEmail: owner, ownerName: 'Owner', createdAt: 0 }, rooms: [], missed: [] }));
  assert.equal((await needsName).meta.status, 'needs_name');

  // 2. register tool round-trip
  const regFrame = nextFrame();
  const regResult = client.callTool({ name: 'register', arguments: { name: 'atlas' } });
  const reg = await regFrame;
  assert.deepEqual([reg.action, reg.name], ['register', 'atlas']);
  sock.send(JSON.stringify({ type: 'ack', reqId: reg.reqId, data: { id: 'ag_a', name: 'atlas', ownerEmail: owner, ownerName: 'Owner', createdAt: 0 } }));
  assert.match(JSON.stringify(await regResult), /Registered as \\"atlas\\"/);

  // 3. a non-waking message becomes context for the next waking one
  sock.send(JSON.stringify({ type: 'room', room }));
  const msg = (id: string, text: string, extra: any = {}) => ({ id, roomId: 'rm_1', authorKind: 'user', authorId: 'colleague@example.com', authorName: 'Colleague', text, ts: 0, ...extra });
  sock.send(JSON.stringify({ type: 'message', message: msg('0000000001', 'hi @bolt'), wake: false }));
  const woke = nextNote();
  sock.send(JSON.stringify({ type: 'message', message: msg('0000000002', 'atlas, what is our deploy region?', { authorId: owner, authorName: 'Owner' }), wake: true }));
  const n = await woke;
  assert.equal(n.meta.room_id, 'rm_1');
  assert.equal(n.meta.room, 'general');
  assert.equal(n.meta.from_kind, 'user');
  assert.equal(n.meta.from_is_owner, 'true');
  assert.match(n.content, /^\[earlier in #general\]\nColleague: hi @bolt\n---\natlas, what is our deploy region\?$/);

  // 4. reply tool
  const sendFrame = nextFrame();
  const replyResult = client.callTool({ name: 'reply', arguments: { room_id: 'rm_1', text: 'us-west-2' } });
  const send = await sendFrame;
  assert.deepEqual([send.action, send.roomId, send.text], ['send', 'rm_1', 'us-west-2']);
  sock.send(JSON.stringify({ type: 'ack', reqId: send.reqId, data: { id: '0000000003', capped: false } }));
  assert.match(JSON.stringify(await replyResult), /"sent"/);

  // 4b. permission relay: declared, forwarded to the backend, verdict returned
  assert.deepEqual(client.getServerCapabilities()?.experimental?.['claude/channel/permission'], {});
  const permFrame = nextFrame();
  await client.notification({ method: 'notifications/claude/channel/permission_request', params: { request_id: 'abcde', tool_name: 'Bash', description: 'List files', input_preview: '{"command":"ls"}' } } as any);
  const pf = await permFrame;
  assert.deepEqual([pf.action, pf.requestId, pf.toolName, pf.description, pf.inputPreview], ['permission_request', 'abcde', 'Bash', 'List files', '{"command":"ls"}']);
  sock.send(JSON.stringify({ type: 'ack', reqId: pf.reqId, data: { requestId: 'abcde' } }));
  // malformed verdicts are ignored; a well-formed one reaches Claude Code
  sock.send(JSON.stringify({ type: 'permission_verdict', requestId: 'lllll', behavior: 'allow' }));
  sock.send(JSON.stringify({ type: 'permission_verdict', requestId: 'abcde', behavior: 'maybe' }));
  const verdict = nextVerdict();
  sock.send(JSON.stringify({ type: 'permission_verdict', requestId: 'abcde', behavior: 'deny' }));
  assert.deepEqual(await verdict, { request_id: 'abcde', behavior: 'deny' });
  assert.equal(verdicts.length, 1, 'malformed verdicts must be dropped');

  // 5. own messages echoed back never wake us
  sock.send(JSON.stringify({ type: 'message', message: { ...msg('0000000003', 'us-west-2'), authorKind: 'agent', authorId: 'ag_a', authorName: 'atlas' }, wake: true }));

  // 6. replaced -> told, and no reconnect
  const replaced = nextNote();
  sock.send(JSON.stringify({ type: 'replaced' }));
  assert.equal((await replaced).meta.status, 'replaced');
  assert.equal(notes.length, 3, 'own echo must not have produced a notification');

  await client.close();

  // 7. an ordinary session (plugin enabled, no channel flag) must stay passive:
  //    no socket (it would steal the agent), no tools, no instructions.
  let stole = false;
  wss.on('connection', () => { stole = true; });
  for (const argv of ['/usr/local/bin/claude', '/usr/local/bin/claude --channels plugin:telegram@claude-plugins-official']) {
    const passive = new Client({ name: 'test', version: '0' });
    await passive.connect(new StdioClientTransport({
      command: 'node', args: [join(__dirname, '..', 'plugin', 'dist', 'server.cjs')],
      env: { ...process.env, HOME: home, AGENT_CHAT_URL: `ws://127.0.0.1:${port}`, AGENT_CHAT_TOKEN: TOKEN, AGENT_CHAT_PARENT_ARGV: argv } as Record<string, string>,
    }));
    assert.deepEqual((await passive.listTools()).tools, [], `no tools for: ${argv}`);
    assert.equal(passive.getServerCapabilities()?.experimental, undefined, 'no channel capability');
    assert.equal(passive.getInstructions(), undefined, 'no instructions injected into ordinary sessions');
    await new Promise((r) => setTimeout(r, 500));
    await passive.close();
  }
  assert.equal(stole, false, 'passive session must not open a socket');

  wss.close();
  console.log('plugin: ok');
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
