// 0.13: who a looks-private reply waits for, room messages as one line in the
// transcript, and the pane as the room's chat.
//   claude plugin test plugin
import { expect, test } from 'claude-code/testing'

const chatValue = (extra: Record<string, unknown>) => ({
  shape: 'chat-1',
  value: { sessionId: 'ss_test', joined: ['rm_1'], roomNames: { rm_1: 'general' }, cursors: {}, prompts: [], promptsSinceSummary: 0, ...extra },
})
const task = (o: Record<string, unknown> = {}) => ({
  id: 'tk_aaaaaaaaaaaa', agentId: 'ag1', members: [], roomId: 'rm_1', roomName: 'general', title: 'post the update',
  source: 'owner', sourceId: 'm1', startedAt: Date.now(), state: 'running', ...o,
})

// Beneath the plugin, test hooks stand for the engine: $.state and $.store
// are values the test seeds.
function engine(on: any) {
  const kept = new Map<string, { value: unknown; version: number }>()
  const store = new Map<string, unknown>()
  const seed = (key: string, value: unknown) => { kept.set(key, { value, version: (kept.get(key)?.version ?? 0) + 1 }) }
  on('state.get', (_: any, e: any) => ({ value: kept.get(e.key) ?? { value: undefined, version: 0 } }))
  on('state.set', (_: any, e: any) => { seed(e.key, e.value); return { value: { isSet: true, version: kept.get(e.key)!.version } } })
  on('store.get', (_: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', (_: any, e: any) => { store.set(e.key, e.value); return { value: true } })
  on('session.repo', () => ({ value: { root: '/Users/me/work/app', name: 'app' } }))
  on('session.root', () => ({ value: '/Users/me/work/app' }))
  on('env.get', (_: any, e: any) => ({ value: e.name === 'HOME' || e.key === 'HOME' ? '/Users/me' : undefined }))
  return { seed, store, get: (k: string) => (kept.get(k)?.value as any)?.value }
}

// A reply that mentions a file path on this machine, in a room others read.
const PRIVATE = 'The log is at /Users/me/work/app/logs/out.txt'
const reply = (agentId?: string) => ({ tool: 'mcp__agent-chat__reply', room_id: 'rm_1', text: PRIVATE, ...(agentId ? { agentId } : {}) }) as any
// the reply guard's own words (the general held-turn message says "This needs your owner's OK")
const heldForOwner = (r: any) => /this reply needs your owner's OK/.test(String(r?.text ?? r?.deny ?? r?.result ?? ''))

test("a looks-private reply in a turn someone else started waits for the owner", async ($, on) => {
  engine(on).seed('chat', chatValue({ tainted: true }))
  expect(heldForOwner(await $.tool.call(reply()))).toBe(true)
})

test("a reply the owner asked for (their own turn) isn't held for them", async ($, on) => {
  engine(on).seed('chat', chatValue({ tainted: false }))
  expect(heldForOwner(await $.tool.call(reply()))).toBe(false)
})

test("the owner's own turn that read colleagues' words (read_history, attachments) is held", async ($, on) => {
  engine(on).seed('chat', chatValue({ tainted: false, readOthers: true }))
  expect(heldForOwner(await $.tool.call(reply()))).toBe(true)
})

test("a task goes by who started it: the owner's posts, a colleague's approved request is held", async ($, on) => {
  const st = engine(on)
  // the main turn is the owner's now, but the task is a colleague's request
  st.seed('chat', chatValue({ tainted: false, tasks: [task({ source: 'ask' })] }))
  expect(heldForOwner(await $.tool.call(reply('ag1')))).toBe(true)
  // the main turn is a colleague's, but the task is the owner's own
  st.seed('chat', chatValue({ tainted: true, tasks: [task({ source: 'owner' })] }))
  expect(heldForOwner(await $.tool.call(reply('ag1')))).toBe(false)
  // a subagent that isn't a task's is held
  expect(heldForOwner(await $.tool.call(reply('other')))).toBe(true)
})

test('/agent-chat review holds every reply, the owner\'s own turn too', async ($, on) => {
  const st = engine(on)
  st.seed('chat', chatValue({ tainted: false }))
  st.store.set('reviewRooms', ['rm_1'])
  const r: any = await $.tool.call({ tool: 'mcp__agent-chat__reply', room_id: 'rm_1', text: 'hello' } as any)
  expect(heldForOwner(r)).toBe(true)
})

// --------------------------------------------------------------------- pane
const PANE = (surface: 'terminal' | 'desktop' | 'mobile') => ({
  plugin: 'agent-chat', surface, component: 'Pane', requestId: 'agent-chat',
  props: { title: 'Agent Chat', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 22 }, view: {} },
}) as any
const VIEW = {
  shape: 'view-1',
  value: {
    roomId: 'rm_1', roomName: 'general', pinned: false, messages: [
      { id: 'm1', who: 'Bob', mine: false, text: 'Can someone post the deploy notes?', ts: Date.now(), reactions: '👍 2' },
      { id: 'm2', who: 'Manthosh', mine: true, text: 'Agent, post them please', ts: Date.now() },
    ],
  },
}
const LONG = `Deploy notes:\n${'- a line of the notes that goes on for a while\n'.repeat(12)}End.`

test('the pane is the room as a chat, with the held post in full as its last message', async ($, on) => {
  const st = engine(on)
  st.seed('chat', chatValue({}))
  st.seed('view', VIEW)
  st.seed('approval', { shape: 'approval-1', value: { requestId: 'abcde', tool: 'mcp__agent-chat__reply', description: `Post in #general: "Deploy notes" (held because it mentions a file path on this machine)`, preview: LONG, roomId: 'rm_1', post: LONG } })
  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await $.ui.mount(PANE(surface))
    expect(await ui.find({ type: 'Text', text: /Can someone post the deploy notes/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /👍 2/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^Deploy notes:/ }))?.text).toMatch(/End\.$/)
    expect(await ui.find({ type: 'Text', text: /waiting for you/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Held because it mentions a file path/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'allow' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'deny' })).toBeDefined()
    await ui.unmount()
  }
})

test('a held tool call shows as a card after the chat; the room text has no control characters', async ($, on) => {
  const st = engine(on)
  st.seed('chat', chatValue({}))
  st.seed('view', { ...VIEW, value: { ...VIEW.value, messages: [{ id: 'm1', who: 'Bob', mine: false, text: 'hi\u001b[31m red', ts: Date.now() }] } })
  st.seed('approval', { shape: 'approval-1', value: { requestId: 'abcde', tool: 'Bash', description: 'Run: npm run deploy (a room message started this turn)', preview: '{"command":"npm run deploy"}', roomId: 'rm_1' } })
  const ui = await $.ui.mount(PANE('terminal'))
  expect(await ui.find({ type: 'Text', text: /Bash: Run: npm run deploy/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^hi/ }))?.text).toBe('hi[31m red')
  expect(await ui.find({ type: 'Button', key: 'allow' })).toBeDefined()
  await ui.unmount()
})

test('/agent-chat pane close unpins the view and closes it; pane test needs a connection', async ($, on) => {
  const st = engine(on)
  st.seed('chat', chatValue({}))
  st.seed('view', { ...VIEW, value: { ...VIEW.value, pinned: true } })
  const closed: string[] = []
  on('ui.close', (_: any, e: any) => { closed.push(e.id); return { value: undefined } })
  on('session.version', () => ({ value: { version: '2.1.330', base: '2.1.330' } }))
  const r: any = await $.command.run({ command: 'agent-chat', args: 'pane close' } as any)
  expect(String(r.text)).toMatch(/Pane closed/)
  expect(st.get('view').pinned).toBe(false)
  expect(closed).toContain('agent-chat')
  const t: any = await $.command.run({ command: 'agent-chat', args: 'pane test' } as any)
  expect(String(t.text)).toMatch(/isn't connected/)
})

test('a bare /agent-chat pane closes the pane when it is open', async ($, on) => {
  const st = engine(on)
  st.seed('chat', chatValue({}))
  st.seed('view', { ...VIEW, value: { ...VIEW.value, pinned: true } })
  on('session.version', () => ({ value: { version: '2.1.330', base: '2.1.330' } }))
  on('ui.panes', () => ({ value: [{ id: 'agent-chat', title: '#general', isShown: true, isFocused: false, isPlaced: true }] }))
  const closed: string[] = []
  on('ui.close', (_: any, e: any) => { closed.push(e.id); return { value: undefined } })
  const r: any = await $.command.run({ command: 'agent-chat', args: 'pane' } as any)
  expect(String(r.text)).toMatch(/Pane closed/)
  expect(closed).toContain('agent-chat')
})

test("the agent's own post draws as one line and opens to its text; reactions and history reads are one line", async ($, on) => {
  const TOOL = (tool: string, input: Record<string, unknown>) => ({
    plugin: 'agent-chat', surface: 'terminal', component: 'ToolUse', requestId: `tu-${tool}`,
    props: { tool_use_id: `toolu_${tool}`, tool: `mcp__agent-chat__${tool}`, input, isRunning: false, isErrored: false, isInterrupted: false },
  }) as any
  const text = '**What shipped today**\n\n- Replies\n- Reactions'
  let ui = await $.ui.mount(TOOL('reply', { room_id: 'rm_1', text }))
  expect(await ui.find({ type: 'Text', text: /Posted in #rm_1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^What shipped today$/ })).toBeDefined()
  expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
  await ui.press({ key: 'tu-toolu_reply' })
  expect((await ui.find({ type: 'Markdown' }))?.text).toBe(text)
  await ui.unmount()
  ui = await $.ui.mount(TOOL('react', { room_id: 'rm_1', message_id: 'm1', emoji: '👍' }))
  expect(await ui.find({ type: 'Text', text: /👍 Reacted in #rm_1/ })).toBeDefined()
  await ui.unmount()
  ui = await $.ui.mount(TOOL('read_history', { room_id: 'rm_1', limit: 20 }))
  expect(await ui.find({ type: 'Text', text: /📜 Read #rm_1 \(last 20\)/ })).toBeDefined()
  await ui.unmount()
})

// ------------------------------------------------- a colleague's request (ask_owner)
const ASK = (o: Record<string, unknown> = {}) => ({
  askId: 'ak_abcdefghijkl', roomId: 'rm_1', roomName: 'general', requesterName: 'Bob', requestText: 'can your agent rerun the AE-2 report?',
  summary: 'Rerun the AE-2 report and post the numbers', expiresAt: Date.now() + 3600_000, ...o,
})

test("a colleague's request shows in the pane: their words from the server, the agent's summary, and where to answer", async ($, on) => {
  const st = engine(on)
  st.seed('chat', chatValue({}))
  st.seed('view', VIEW)
  // after a module reload the pane has no key for it: no buttons, the web answers
  st.seed('asks', { shape: 'asks-1', value: [ASK(), ASK({ askId: 'ak_old', expiresAt: Date.now() - 1000, requesterName: 'Gone' })] })
  const ui = await $.ui.mount(PANE('terminal'))
  expect(await ui.find({ type: 'Text', text: /Bob asks your agent/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /rerun the AE-2 report\?/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Your agent would: Rerun the AE-2 report/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Answer it on your Agent Chat tab/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Gone/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'ask-allow-ak_abcdefghijkl' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /approval needed/ })).toBeDefined()
  await ui.unmount()
})

test('a request waiting alongside a held tool call: both show, the tool call first', async ($, on) => {
  const st = engine(on)
  st.seed('chat', chatValue({}))
  st.seed('view', VIEW)
  st.seed('asks', { shape: 'asks-1', value: [ASK({ roomId: 'rm_2', roomName: 'ops' })] })
  st.seed('approval', { shape: 'approval-1', value: { requestId: 'abcde', tool: 'Bash', description: 'Run: ls (a room message started this turn)', preview: '{}', roomId: 'rm_1' } })
  const ui = await $.ui.mount(PANE('terminal'))
  expect(await ui.find({ type: 'Text', text: /Bash: Run: ls/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'allow' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Bob · #ops asks your agent/ })).toBeDefined()
  await ui.unmount()
})
