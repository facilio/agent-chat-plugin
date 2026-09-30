// Device pairing, end to end against a fake backend: first run with no token,
// and a revoked token that re-links by itself.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function main() {
  let polls = 0;
  let pollOutcome: 'token' | 'denied' = 'token';
  const starts: any[] = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const b = body ? JSON.parse(body) : {};
      const send = (status: number, data: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data)); };
      if (req.url === '/api/pair/start') {
        starts.push(b);
        return send(201, { code: 'KXWP-7QHM', secret: 'ps_secret', url: 'https://chat.example/pair?code=KXWP-7QHM', expiresAt: Date.now() + 60_000 });
      }
      if (req.url === '/api/pair/poll') {
        assert.deepEqual(b, { code: 'KXWP-7QHM', secret: 'ps_secret' });
        if (++polls < 3) return send(202, { status: 'pending' });
        return pollOutcome === 'token' ? send(200, { token: 'ac_new_token' }) : send(410, { error: 'denied' });
      }
      send(404, {});
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  const bearers: string[] = [];
  srv.on('upgrade', (req, socket, head) => {
    const auth = String(req.headers.authorization);
    bearers.push(auth);
    if (auth !== 'Bearer ac_new_token') { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, (ws) => ws.on('message', (raw) => {
      const f = JSON.parse(String(raw));
      if (f.action === 'hello') ws.send(JSON.stringify({ type: 'hello', reqId: f.reqId, agent: { id: 'ag_1', name: 'atlas', ownerEmail: 'owner@example.com', ownerName: 'Owner', createdAt: 0 }, rooms: [], missed: [] }));
    }));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as any).port;

  const run = async (token?: string) => {
    const home = mkdtempSync(join(tmpdir(), 'agent-chat-pair-'));
    const notes: any[] = [];
    const waiters: Array<(n: any) => void> = [];
    const client = new Client({ name: 'test', version: '0' });
    client.fallbackNotificationHandler = async (n: any) => {
      if (n.method === 'notifications/claude/channel') { notes.push(n.params); waiters.shift()?.(n.params); }
    };
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>), HOME: home,
      AGENT_CHAT_URL: `ws://127.0.0.1:${port}`, AGENT_CHAT_WEB_URL: `http://127.0.0.1:${port}`,
      AGENT_CHAT_PARENT_ARGV: 'claude --channels plugin:agent-chat@facilio', AGENT_CHAT_NO_BROWSER: '1', AGENT_CHAT_PAIR_POLL_MS: '30',
    };
    delete env.AGENT_CHAT_TOKEN;
    if (token) env.AGENT_CHAT_TOKEN = token;
    await client.connect(new StdioClientTransport({ command: 'node', args: [join(__dirname, '..', 'plugin', 'dist', 'server.cjs')], env }));
    const next = () => new Promise<any>((r, j) => { const t = setTimeout(() => j(new Error('no notification')), 5000); waiters.push((n) => { clearTimeout(t); r(n); }); });
    return { client, home, notes, next };
  };

  // A. first run: no token -> link shown -> approved -> token saved (0600) -> connected
  const a = await run();
  const shown = await a.next();
  assert.equal(shown.meta.status, 'pairing');
  assert.equal(shown.meta.url, 'https://chat.example/pair?code=KXWP-7QHM');
  assert.match(shown.content, /open https:\/\/chat\.example\/pair\?code=KXWP-7QHM and click "Link agent" \(code KXWP-7QHM\)/);
  assert.equal(typeof starts[0].hostname, 'string');
  for (let i = 0; i < 100 && !bearers.includes('Bearer ac_new_token'); i++) await new Promise((r) => setTimeout(r, 30));
  assert.ok(bearers.includes('Bearer ac_new_token'), 'connected with the claimed token');
  const envFile = join(a.home, '.claude', 'channels', 'agent-chat', '.env');
  assert.equal(readFileSync(envFile, 'utf8'), 'AGENT_CHAT_TOKEN=ac_new_token\n');
  assert.equal(statSync(envFile).mode & 0o777, 0o600, 'token file is private');
  await a.client.close();

  // B. revoked token -> re-links by itself; a cancelled link is reported
  polls = 0; pollOutcome = 'denied';
  const b = await run('ac_revoked');
  const relink = await b.next();
  assert.equal(relink.meta.status, 'pairing');
  assert.match(relink.content, /^This agent was revoked in Agent Chat\. To connect/);
  const failed = await b.next();
  assert.equal(failed.meta.status, 'pairing_failed');
  assert.match(failed.content, /cancelled/);
  assert.equal(bearers.filter((x) => x === 'Bearer ac_revoked').length, 1, 'dead token tried once, not retried');
  await b.client.close();

  srv.close();
  console.log('pairing: ok');
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
