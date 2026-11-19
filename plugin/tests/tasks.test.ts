// The task grant (tasks.ts) as the engine runs the module: what a task's
// subagent may do on a held turn, and what stays refused.
//   claude plugin test plugin
import { expect, test } from 'claude-code/testing'

const CHAT = { plugin: 'agent-chat', key: 'chat' } as const
const task = (o: Record<string, unknown> = {}) => ({
  id: 'tk_aaaaaaaaaaaa', agentId: 'ag1', members: ['ag1b'], roomId: 'rm_1', roomName: 'general', title: 'push and deploy',
  source: 'owner', sourceId: 'm1', startedAt: Date.now(), state: 'running', ...o,
})
const chatWith = (extra: Record<string, unknown>) => ({
  shape: 'chat-1',
  value: { sessionId: 'ss_test', joined: ['rm_1'], roomNames: { rm_1: 'general' }, cursors: {}, prompts: [], promptsSinceSummary: 0, tainted: true, ...extra },
})

// Beneath the plugin, test hooks stand for the engine: every tool "runs", and
// $.state is a value the test seeds (and the module's writes land in).
function engine(on: any) {
  on('tool.call', () => ({ result: 'ran' }))
  const kept = new Map<string, { value: unknown; version: number }>()
  const seed = (key: string, value: unknown) => { kept.set(key, { value, version: (kept.get(key)?.version ?? 0) + 1 }) }
  on('state.get', (_: any, e: any) => ({ value: kept.get(e.key) ?? { value: undefined, version: 0 } }))
  on('state.set', (_: any, e: any) => { seed(e.key, e.value); return { value: { isSet: true, version: kept.get(e.key)!.version } } })
  on('session.repo', () => ({ value: { root: '/Users/me/work/app', name: 'app' } }))
  on('session.root', () => ({ value: '/Users/me/work/app' }))
  on('env.get', (_: any, e: any) => ({ value: e.name === 'HOME' || e.key === 'HOME' ? '/Users/me' : undefined }))
  return { seed: (v: unknown) => seed(CHAT.key, v), get: () => kept.get(CHAT.key)?.value }
}
const ran = (r: any) => !r?.isError && r?.text !== undefined ? r.text === 'ran' || r.result === 'ran' : r?.result === 'ran'

test("a held turn: the main loop's Bash waits for the owner (and with no Agent Chat to ask, doesn't run)", async ($, on) => {
  engine(on).seed(chatWith({}))
  const r: any = await $.tool.call({ tool: 'Bash', command: 'ls' } as any)
  expect(ran(r)).toBe(false)
  expect(String(r.text ?? r.deny ?? '')).toMatch(/NOT run/)
})

test("a task's subagent runs with the session's own permissions, its own subagents too", async ($, on) => {
  engine(on).seed(chatWith({ tasks: [task()] }))
  expect(ran(await $.tool.call({ tool: 'Bash', command: 'npm run deploy', agentId: 'ag1' } as any))).toBe(true)
  expect(ran(await $.tool.call({ tool: 'Edit', file_path: 'a', old_string: 'x', new_string: 'y', agentId: 'ag1b' } as any))).toBe(true)
  // another subagent, not the task's, is still held
  expect(ran(await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'other' } as any))).toBe(false)
})

test('inside a task, acting as the owner still waits for them, and tasks start no tasks', async ($, on) => {
  engine(on).seed(chatWith({ tasks: [task()] }))
  for (const t of ['create_room', 'add_members', 'propose_avatar', 'start_task']) {
    const r: any = await $.tool.call({ tool: `mcp__agent-chat__${t}`, agentId: 'ag1' } as any)
    expect(ran(r)).toBe(false)
    expect(String(r.text ?? r.deny ?? '')).toMatch(/NOT run/)
  }
})

test('a stopped, ended or overdue task gets nothing more', async ($, on) => {
  const st = engine(on)
  st.seed(chatWith({ tasks: [task({ state: 'stopping' })], endedAgents: ['ag9'] }))
  expect(ran(await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'ag1' } as any))).toBe(false)
  expect(ran(await $.tool.call({ tool: 'Read', file_path: 'a', agentId: 'ag9' } as any))).toBe(false)
  st.seed(chatWith({ tainted: false, tasks: [task({ startedAt: Date.now() - 4 * 3600_000 })] }))
  expect(ran(await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'ag1' } as any))).toBe(false)
})

test('only the plugin starts an agent-chat:task subagent', async ($, on) => {
  engine(on)
  on('agent.spawn', () => ({ model: 'm', agentId: 'agX' }))
  const r: any = await $.agent.spawn({ subagentType: 'agent-chat:task', prompt: 'Agent Chat task tk_bbbbbbbbbbbb for X. deploy', description: 'x' } as any)
  expect(r.agentId).toBeUndefined()
  expect(String(r.deny)).toMatch(/Only the agent-chat plugin/)
})

test("a task's report coming back is dropped: no turn for it, nothing held", async ($, on) => {
  const st = engine(on)
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  st.seed(chatWith({ tainted: false, endedAgents: ['ag1'] }))
  const r: any = await $.prompt.submit({ text: '<agent-message from="ag1">\n[Subagent hand-back] all done', origin: { kind: 'peer' } } as any)
  expect(String(r.drop ?? '')).toMatch(/task's report/)
  expect(ran(await $.tool.call({ tool: 'Bash', command: 'ls' } as any))).toBe(true)
})

test("another agent's peer message doesn't count as a task's report", async ($, on) => {
  const st = engine(on)
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  st.seed(chatWith({ tainted: false, endedAgents: ['ag1'] }))
  const r: any = await $.prompt.submit({ text: '<agent-message from="someone-else">\nhello', origin: { kind: 'peer' } } as any)
  expect(r.drop).toBeUndefined()
  expect(ran(await $.tool.call({ tool: 'Bash', command: 'ls' } as any))).toBe(true)
})

test('after a plugin update (empty state), the session comes back to its rooms', async ($, on) => {
  const st = engine(on)
  const store = new Map<string, unknown>([['sessions', { cc1: { sessionId: 'ss_kept', joined: ['rm_9'], roomNames: { rm_9: 'kept' }, cursors: {}, at: 1 } }]])
  on('store.get', (_: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_: any, e: any) => { store.set(e.key, e.value); return { value: undefined } })
  on('session.id', () => ({ value: 'cc1' }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('tool.list', () => ({ value: [] }))
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__agent-chat__${e.name}` } }))
  on('command.register', () => ({ value: { command: 'agent-chat' } }))
  on('agent.register', () => ({ value: { agent: 'agent-chat:task' } }))
  on('agent.list', () => ({ value: [] }))
  on('process.spawn', async function* () { throw new Error('no processes in a test') } as any)
  st.seed(undefined)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as any)
  const got: any = st.get()
  expect(got?.value?.sessionId).toBe('ss_kept')
  expect(got?.value?.joined).toEqual(['rm_9'])
})

test("a held turn reads its own project unasked; anything outside it, or private data, waits", async ($, on) => {
  engine(on).seed(chatWith({}))
  expect(ran(await $.tool.call({ tool: 'Read', file_path: 'src/a.ts' } as any))).toBe(true)
  expect(ran(await $.tool.call({ tool: 'Grep', pattern: 'x' } as any))).toBe(true)
  for (const input of [{ tool: 'Read', file_path: '/Users/me/.claude/projects/p/memory/MEMORY.md' }, { tool: 'Read', file_path: '/Users/me/other/notes.md' }, { tool: 'Read', file_path: '.env' }, { tool: 'Glob', pattern: '/Users/me/.ssh/*' }]) {
    const r: any = await $.tool.call(input as any)
    expect(ran(r)).toBe(false)
    expect(String(r.text ?? r.deny ?? '')).toMatch(/NOT run/)
  }
})

test("an untainted turn (the owner's own) reads anywhere", async ($, on) => {
  engine(on).seed(chatWith({ tainted: false }))
  expect(ran(await $.tool.call({ tool: 'Read', file_path: '/Users/me/.claude/CLAUDE.md' } as any))).toBe(true)
})

test("inside a task: work runs, the owner's private data waits", async ($, on) => {
  engine(on).seed(chatWith({ tasks: [task()] }))
  expect(ran(await $.tool.call({ tool: 'Bash', command: 'npm test', agentId: 'ag1' } as any))).toBe(true)
  expect(ran(await $.tool.call({ tool: 'Read', file_path: '/tmp/out.log', agentId: 'ag1' } as any))).toBe(true)
  for (const input of [{ tool: 'Read', file_path: '/Users/me/.claude/projects/p/memory/user.md' }, { tool: 'Bash', command: 'cat ~/.claude/CLAUDE.md' }, { tool: 'Bash', command: 'ls $HOME/.ssh' }]) {
    const r: any = await $.tool.call({ ...input, agentId: 'ag1' } as any)
    expect(ran(r)).toBe(false)
  }
})

test('"Allow <person> for 1 hour": turns only they start skip the hold; anyone else still asks; after the hour it asks again', async ($, on) => {
  const st = engine(on)
  const hour = Date.now() + 3600_000
  const manthosh = { email: 'manthosh@facilio.com', name: 'Manthosh Kumar', until: hour }, shiv = { email: 'shiv@facilio.com', name: 'Shivaraj S', until: hour }
  st.seed(chatWith({ turnFrom: [manthosh], grantedPeople: [manthosh] }))
  expect(ran(await $.tool.call({ tool: 'Bash', command: 'npm test' } as any))).toBe(true)
  // someone else in the turn (or only someone else): held
  st.seed(chatWith({ turnFrom: [manthosh, shiv], grantedPeople: [manthosh] }))
  expect(ran(await $.tool.call({ tool: 'Bash', command: 'ls' } as any))).toBe(false)
  st.seed(chatWith({ turnFrom: [shiv], grantedPeople: [manthosh] }))
  expect(ran(await $.tool.call({ tool: 'Bash', command: 'ls' } as any))).toBe(false)
  // a turn that can't be pinned on people (a room description): held
  st.seed(chatWith({ turnFrom: null, grantedPeople: [manthosh] }))
  expect(ran(await $.tool.call({ tool: 'Bash', command: 'ls' } as any))).toBe(false)
  // /agent-chat hold on: nobody granted, held again
  st.seed(chatWith({ turnFrom: [manthosh], grantedPeople: [] }))
  expect(ran(await $.tool.call({ tool: 'Bash', command: 'ls' } as any))).toBe(false)
  // the hour is up: held again (the card comes back)
  st.seed(chatWith({ turnFrom: [manthosh], grantedPeople: [{ ...manthosh, until: Date.now() - 1 }] }))
  expect(ran(await $.tool.call({ tool: 'Bash', command: 'ls' } as any))).toBe(false)
  // a grant stored before grants expired (no until): held, asks once more
  st.seed(chatWith({ turnFrom: [manthosh], grantedPeople: [{ email: manthosh.email, name: manthosh.name }] }))
  expect(ran(await $.tool.call({ tool: 'Bash', command: 'ls' } as any))).toBe(false)
})

test('"Allow messages to your other sessions for 1 hour": SendMessage on a held turn goes out unasked until then; nothing else does', async ($, on) => {
  const st = engine(on)
  const shiv = { email: 'shiv@facilio.com', name: 'Shivaraj S' }
  st.seed(chatWith({ turnFrom: [shiv], sendUntil: Date.now() + 3600_000 }))
  expect(ran(await $.tool.call({ tool: 'SendMessage', to: 'agent-chat-58', message: 'hi' } as any))).toBe(true)
  // the send grant covers SendMessage only
  expect(ran(await $.tool.call({ tool: 'Bash', command: 'ls' } as any))).toBe(false)
  // run out: held again
  st.seed(chatWith({ turnFrom: [shiv], sendUntil: Date.now() - 1 }))
  expect(ran(await $.tool.call({ tool: 'SendMessage', to: 'agent-chat-58', message: 'hi' } as any))).toBe(false)
  // none: held
  st.seed(chatWith({ turnFrom: [shiv] }))
  expect(ran(await $.tool.call({ tool: 'SendMessage', to: 'agent-chat-58', message: 'hi' } as any))).toBe(false)
})

test('/agent-chat hold lists grants with the time left; hold on clears the people and the send grant', async ($, on) => {
  const st = engine(on)
  const shiv = { email: 'shiv@facilio.com', name: 'Shivaraj S', until: Date.now() + 42 * 60_000 }
  st.seed(chatWith({ grantedPeople: [shiv, { email: 'old@facilio.com', name: 'Old Grant', until: Date.now() - 1 }], sendUntil: Date.now() + 10 * 60_000 }))
  on('session.version', () => ({ value: { version: '2.1.330', base: '2.1.330' } }))
  const r: any = await $.command.run({ command: 'agent-chat', args: 'hold' } as any)
  expect(String(r.text)).toMatch(/Shivaraj S \(@shiv\) · 42 min left/)
  expect(String(r.text)).toMatch(/Messages to your other sessions · 10 min left/)
  expect(String(r.text)).not.toMatch(/Old Grant/)
  await $.command.run({ command: 'agent-chat', args: 'hold on' } as any)
  const v: any = (st.get() as any).value
  expect(v.grantedPeople).toEqual([])
  expect(v.sendUntil).toBe(undefined)
})

test("a per-person grant lifts the tool hold only: reads outside the project and private data still wait", async ($, on) => {
  const st = engine(on)
  const shiv = { email: 'shiv@facilio.com', name: 'Shivaraj S' }
  st.seed(chatWith({ turnFrom: [shiv], grantedPeople: [{ ...shiv, until: Date.now() + 3600_000 }] }))
  expect(ran(await $.tool.call({ tool: 'Bash', command: 'npm test' } as any))).toBe(true)
  expect(ran(await $.tool.call({ tool: 'Read', file_path: 'src/a.ts' } as any))).toBe(true)
  for (const input of [{ tool: 'Read', file_path: '/Users/me/other/notes.md' }, { tool: 'Read', file_path: '/Users/me/.claude/projects/p/memory/MEMORY.md' }, { tool: 'Bash', command: 'cat ~/.claude/CLAUDE.md' }, { tool: 'Read', file_path: '.env' }]) {
    const r: any = await $.tool.call(input as any)
    expect(ran(r)).toBe(false)
  }
})

test('/agent-chat status names the loaded plugin version, and a newer one installed beside it', async ($, on) => {
  on('store.get', () => ({ value: undefined }))
  engine(on).seed(chatWith({ joined: [] }))
  on('fs.read', () => ({ value: '{"version":"0.11.2"}' }))
  on('fs.list', () => ({ value: [{ name: '0.11.1', kind: 'dir', size: 0 }, { name: '0.11.2', kind: 'dir', size: 0 }, { name: '0.12.0', kind: 'dir', size: 0 }] }))
  on('session.version', () => ({ value: { version: '2.1.330', base: '2.1.330' } }))
  const r: any = await $.command.run({ command: 'agent-chat', args: 'status' } as any)
  expect(String(r.text)).toMatch(/plugin: 0\.11\.2 \(0\.12\.0 is installed: \/reload-plugins or a new session loads it\)/)
})

test('/agent-chat update outside a marketplace install runs nothing and says so', async ($, on) => {
  engine(on).seed(chatWith({ joined: [] }))
  on('session.version', () => ({ value: { version: '2.1.330', base: '2.1.330' } }))
  const ran: unknown[] = []
  on('process.run', (_: any, e: any) => { ran.push(e.argv); return { value: { exitCode: 0, stdout: '', stderr: '' } } })
  const r: any = await $.command.run({ command: 'agent-chat', args: 'update' } as any)
  expect(String(r.text)).toMatch(/isn't a marketplace install/)
  expect(ran.length).toBe(0)
})

test("the session's Claude Code name (ListAgents, /rename) is read from its sessions file and shown in status", async ($, on) => {
  on('store.get', () => ({ value: undefined }))
  const st = engine(on)
  st.seed(chatWith({ joined: [] }))
  const files: Record<string, string> = {
    '/Users/me/.claude/sessions/111.json': JSON.stringify({ pid: 111, sessionId: 'other', name: 'not-me' }),
    '/Users/me/.claude/sessions/222.json': JSON.stringify({ pid: 222, sessionId: 'cc1', name: 'chillout', nameSource: 'custom' }),
  }
  on('session.id', () => ({ value: 'cc1' }))
  on('fs.list', (_: any, e: any) => ({ value: String(e.path).endsWith('/sessions') ? [{ name: '111.json', kind: 'file', size: 1 }, { name: '111.abc.key', kind: 'file', size: 1 }, { name: '222.json', kind: 'file', size: 1 }] : [] }))
  on('fs.read', (_: any, e: any) => files[e.path] !== undefined ? { value: files[e.path] } : { value: '{"version":"0.11.4"}' })
  on('session.version', () => ({ value: { version: '2.1.330', base: '2.1.330' } }))
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  await $.prompt.submit({ text: 'hello', origin: { kind: 'composer' } } as any)
  for (let i = 0; i < 20 && !(st.get() as any)?.value?.title; i++) await new Promise(r => setTimeout(r, 5))
  expect((st.get() as any)?.value?.title).toBe('chillout')
  const r: any = await $.command.run({ command: 'agent-chat', args: 'status' } as any)
  expect(String(r.text)).toMatch(/This session: chillout \(only you see it\)\n/)
  expect(String(r.text)).toMatch(/^state: not connected/)
  expect(String(r.text).split("\n").length).toBeGreaterThan(4)
})

test("a reaction on a turn someone else started isn't held (one emoji, wakes nobody); making a room still is", async ($, on) => {
  engine(on).seed(chatWith({}))
  const r: any = await $.tool.call({ tool: 'mcp__agent-chat__react', room_id: 'rm_1', message_id: 'm1', emoji: '👍' } as any)
  expect(String(r.text ?? r.deny ?? '')).not.toMatch(/owner's OK/)
  const c: any = await $.tool.call({ tool: 'mcp__agent-chat__create_room', name: 'x' } as any)
  expect(String(c.text ?? c.deny ?? '')).toMatch(/NOT run/)
})

test('a message sent to another session on a room-started turn says first that it is relayed; the owner\'s own turn is not labelled', async ($, on) => {
  const st = engine(on)
  const shiv = { email: 'shiv@facilio.com', name: 'Shivaraj S' }
  const sent: string[] = []
  on('session.send', (_: any, e: any) => { sent.push(String(e.text)); return { isDelivered: true } })
  st.seed(chatWith({ tainted: true, turnFrom: [shiv], turnRooms: ['general'] }))
  await ($.session as any).send({ to: 'agent-chat-58', text: 'please run the deploy' })
  expect(sent[0]!.startsWith('[Relayed by Agent Chat: a room message from Shivaraj S in #general')).toBe(true)
  expect(sent[0]!.endsWith('\n\nplease run the deploy')).toBe(true)
  // already labelled: not twice
  await ($.session as any).send({ to: 'agent-chat-58', text: sent[0] })
  expect(sent[1]).toBe(sent[0])
  // the owner's own turn: as written
  st.seed(chatWith({ tainted: false }))
  await ($.session as any).send({ to: 'agent-chat-58', text: 'hello' })
  expect(sent[2]).toBe('hello')
})

// A room message that names the owner: 📣 and a toast, once per message.
test('a message naming the owner shows 📣 and one toast, quiet on (heard) or off (wake)', async ($, on) => {
  const st = engine(on)
  on('session.id', () => ({ value: 'cc1' }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('tool.list', () => ({ value: [] }))
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__agent-chat__${e.name}` } }))
  on('command.register', () => ({ value: { command: 'agent-chat' } }))
  on('agent.register', () => ({ value: { agent: 'agent-chat:task' } }))
  on('agent.list', () => ({ value: [] }))
  on('prompt.submit', () => ({ drop: 'test' }))
  on('clock.every', () => ({ value: undefined }))
  const store = new Map<string, unknown>()
  on('store.get', (_: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_: any, e: any) => { store.set(e.key, e.value); return { value: undefined } })
  on('clock.sleep', () => ({ value: undefined }))
  on('session.identity', () => ({ value: { email: 'seenimohamed@example.com' } }))
  const toasts: string[] = []
  const logs: string[] = []
  on('ui.toast', (_: any, e: any) => { toasts.push(e.text); return { value: undefined } })
  on('ui.log', (_: any, e: any) => { logs.push(e.text); return { value: undefined } })
  const line = (o: unknown) => JSON.stringify(o) + '\n'
  const named = { messageId: 'm1', from: 'Manthosh Kumar', text: '@seenimohamed are you **free** at 4?' }
  let spawned = 0
  on('process.spawn', async function* () {
    spawned++
    yield { stream: 'stdout', text: line({ type: 'ready' }) }
    yield { stream: 'stdout', text: line({ type: 'heard', roomId: 'rm_1', roomName: 'general', ...named, files: 0 }) }
    // the same message again (a redelivery): no second toast
    yield { stream: 'stdout', text: line({ type: 'heard', roomId: 'rm_1', roomName: 'general', ...named, files: 0 }) }
    yield { stream: 'stdout', text: line({ type: 'wake', roomId: 'rm_1', roomName: 'general', addressed: false, trusted: false, ownerMentions: [{ messageId: 'm2', from: '@odin', text: '@seenimohamed done' }], text: '<agent-chat room_id="rm_1" room="general" mentions_owner="true" message_id="m2" count="1">\n@seenimohamed done\n</agent-chat>' }) }
    await new Promise(() => {})
  } as any)
  st.seed(chatWith({ tainted: false }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true } as any)
  for (let i = 0; i < 50 && toasts.length < 2; i++) await new Promise(r => setTimeout(r, 10))
  expect(spawned).toBe(1)
  expect(toasts).toEqual(['📣 Manthosh Kumar in #general: @seenimohamed are you free at 4?', '📣 @odin in #general: @seenimohamed done'])
  expect(logs.filter(l => l === '📣 #general (1) · Manthosh Kumar › @seenimohamed are you free at 4?').length).toBe(2)
})
