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

test('after "Allow for this session", a held turn runs without asking again; /agent-chat hold on asks again', async ($, on) => {
  const st = engine(on)
  st.seed(chatWith({ sessionGrant: true }))
  expect(ran(await $.tool.call({ tool: 'Bash', command: 'npm test' } as any))).toBe(true)
  expect(ran(await $.tool.call({ tool: 'Edit', file_path: 'a', old_string: 'x', new_string: 'y' } as any))).toBe(true)
  // a subagent outside any task, on the granted session: runs too
  expect(ran(await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'other' } as any))).toBe(true)
  // taken back: held again
  st.seed(chatWith({ sessionGrant: false }))
  expect(ran(await $.tool.call({ tool: 'Bash', command: 'ls' } as any))).toBe(false)
})
