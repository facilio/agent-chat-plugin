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
    // in full, drawn as markdown: the heading line, every list item, the last line
    expect(await ui.find({ type: 'Text', text: /^Deploy notes:$/ })).toBeDefined()
    expect(await ui.findAll({ type: 'Text', text: /^a line of the notes that goes on for a while$/ })).toHaveLength(12)
    expect(await ui.find({ type: 'Text', text: /^End\.$/ })).toBeDefined()
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

test('the card offers a grant for 1 hour: a person, or messages to your other sessions for a SendMessage', async ($, on) => {
  const st = engine(on)
  st.seed('chat', chatValue({}))
  st.seed('view', VIEW)
  st.seed('approval', { shape: 'approval-1', value: { requestId: 'abcde', tool: 'Bash', description: 'Run: ls (a room message started this turn)', preview: '{}', roomId: 'rm_1', grantTo: 'Shivaraj S (@shiv)' } })
  let ui = await $.ui.mount(PANE('terminal'))
  expect((await ui.find({ type: 'Button', key: 'person' }))?.text).toBe('Allow Shivaraj S (@shiv) for 1 hour')
  expect(await ui.find({ type: 'Text', text: /for this session/ })).toBeUndefined()
  await ui.unmount()
  st.seed('approval', { shape: 'approval-1', value: { requestId: 'abcdf', tool: 'SendMessage', description: 'Send a message (a room message started this turn)', preview: '{}', roomId: 'rm_1', grantTo: 'messages to your other sessions' } })
  ui = await $.ui.mount(PANE('terminal'))
  expect((await ui.find({ type: 'Button', key: 'person' }))?.text).toBe('Allow messages to your other sessions for 1 hour')
  expect(await ui.find({ type: 'Text', text: /each one says it is relayed/ })).toBeDefined()
  await ui.unmount()
})

test("a docked room view has its own close under the newest message (the engine's ✕ is under the terminal app's buttons); not inline, not while an answer waits", async ($, on) => {
  const st = engine(on)
  st.seed('chat', chatValue({}))
  st.seed('view', { ...VIEW, value: { ...VIEW.value, pinned: true } })
  const closed: string[] = []
  on('ui.close', (_: any, e: any) => { closed.push(e.id); return { value: undefined } })
  let ui = await $.ui.mount(PANE('terminal'))
  expect(await ui.find({ type: 'Text', text: '✕ close' })).toBeDefined()
  await ui.press({ key: 'pane-close' })
  await new Promise(r => setTimeout(r, 10))
  expect(st.get('view').pinned).toBe(false)
  expect(closed).toContain('agent-chat')
  await ui.unmount()
  // above the prompt the engine's own ✕ is reachable: no second one
  ui = await $.ui.mount({ ...PANE('terminal'), props: { ...PANE('terminal').props, placement: 'inline' } })
  expect(await ui.find({ type: 'Button', key: 'pane-close' })).toBeUndefined()
  await ui.unmount()
  st.seed('approval', { shape: 'approval-1', value: { requestId: 'abcde', tool: 'Bash', description: 'Run: ls', preview: '{}', roomId: 'rm_1' } })
  ui = await $.ui.mount(PANE('terminal'))
  expect(await ui.find({ type: 'Button', key: 'pane-close' })).toBeUndefined()
  await ui.unmount()
})

test('/agent-chat pane view in no room says to join one', async ($, on) => {
  const st = engine(on)
  st.seed('chat', chatValue({ joined: [] }))
  on('session.version', () => ({ value: { version: '2.1.330', base: '2.1.330' } }))
  for (const args of ['pane view', 'pane view general']) {
    const r: any = await $.command.run({ command: 'agent-chat', args } as any)
    expect(String(r.text)).toBe('Not in a room. /agent-chat join <room>')
  }
})

test('a pane message draws bold italic, strikethrough and a table as columns; a table too wide for the bubble stays as typed', async ($, on) => {
  const st = engine(on)
  st.seed('chat', chatValue({}))
  const table = '| Item | Status |\n| --- | :---: |\n| Room join | ✅ done |'
  const text = `***both*** and ~~gone~~\n\n${table}\n\n---\nend`
  st.seed('view', { ...VIEW, value: { ...VIEW.value, messages: [{ id: 'm1', who: '@odin', mine: false, text, ts: Date.now() }] } })
  let ui = await $.ui.mount(PANE('terminal'))
  const both = await ui.find({ type: 'Text', text: /^both$/ })
  expect([both?.props.bold, both?.props.italic]).toEqual([true, true])
  expect((await ui.find({ type: 'Text', text: /^gone$/ }))?.props.strikethrough).toBe(true)
  expect((await ui.find({ type: 'Text', text: /^Item$/ }))?.props.bold).toBe(true)
  expect(await ui.find({ type: 'Text', text: /^─+┼─+$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\| --- \|/ })).toBeUndefined()
  // a --- rule spans the bubble's inside, as wide as its widest line
  expect(await ui.find({ type: 'Text', text: /^─{19}$/ })).toBeDefined()
  await ui.unmount()
  const wide = `| ${'a'.repeat(40)} | ${'b'.repeat(40)} |\n| --- | --- |\n| x | y |`
  st.seed('view', { ...VIEW, value: { ...VIEW.value, messages: [{ id: 'm1', who: '@odin', mine: false, text: wide, ts: Date.now() }] } })
  ui = await $.ui.mount(PANE('terminal'))
  expect(await ui.find({ type: 'Text', text: '| --- | --- |' })).toBeDefined()
  await ui.unmount()
})

// pane view shows only rooms this session is in; joining is /agent-chat join's.
// A fake bridge: the process says ready, and its HTTP answers are canned.
function fakeBridge(on: any) {
  const calls: { method: string; path: string; body: any }[] = []
  on('process.spawn', async function* () { yield { stream: 'stdout', text: JSON.stringify({ type: 'ready' }) + '\n' }; await new Promise(() => {}) } as any)
  on('http.fetch', (_: any, e: any) => {
    const path = new URL(e.url).pathname
    const method = e.init?.method ?? 'GET'
    const body = e.init?.body ? JSON.parse(e.init.body) : undefined
    calls.push({ method, path, body })
    const answer: any =
      path === '/status' ? { state: 'online', me: { name: 'caraxes', ownerEmail: 'seenimohamed@example.com' } }
      : path === '/join' ? { id: 'rm_2', name: 'agent-chat-enhancements', members: [] }
      : path === '/history' ? []
      : {}
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(answer) } }
  })
  on('session.id', () => ({ value: 'cc1' }))
  on('session.identity', () => ({ value: { email: 'seenimohamed@example.com' } }))
  on('session.version', () => ({ value: { version: '2.1.330', base: '2.1.330' } }))
  on('tool.list', () => ({ value: [] }))
  on('tool.register', (_: any, e: any) => ({ value: { tool: `mcp__agent-chat__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.scroll', () => ({ value: { offset: 0 } }))
  on('clock.sleep', () => ({ value: undefined }))
  return calls
}
test('/agent-chat pane view never joins: a room this session is not in says to join it first', async ($, on) => {
  const st = engine(on)
  st.seed('chat', chatValue({}))
  const calls = fakeBridge(on)
  const run = async (args: string) => String(((await $.command.run({ command: 'agent-chat', args } as any)) as any).text)
  expect(await run('pane view agent-chat-enhancements')).toBe('Not in #agent-chat-enhancements from this session. Join it first: /agent-chat join agent-chat-enhancements   (in: #general)')
  expect(await run('pane view general')).toMatch(/^Showing #general /)
  expect(await run('pane view')).toMatch(/^Showing #general /)
  expect(calls.filter(c => c.path === '/join')).toHaveLength(0)
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
  expect(await ui.find({ type: 'Text', text: /^↗️ #rm_1 · @agent ›$/ })).toBeDefined()
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

// Quiet mode. Off unless turned on; kept in $.store for every session.
test('/agent-chat quiet on|off is kept across sessions and starts off', async ($, on) => {
  const st = engine(on)
  st.seed('chat', chatValue({}))
  on('session.version', () => ({ value: { version: '2.1.330', base: '2.1.330' } }))
  const run = async (args: string) => String(((await $.command.run({ command: 'agent-chat', args } as any)) as any).text)
  expect(await run('quiet')).toMatch(/^quiet: off/)
  expect(await run('quiet on')).toMatch(/^Quiet on/)
  expect(st.store.get('quiet')).toBe(true)
  expect(await run('quiet')).toMatch(/^quiet: on/)
  expect(await run('quiet off')).toMatch(/^Quiet off/)
  expect(st.store.get('quiet')).toBe(false)
  expect(await run('help')).toMatch(/\/agent-chat quiet <on\|off>/)
})

// Quiet mode: a room turn's react rows and result lines aren't drawn.
const ROOM_ROWS = (calls: string[]) => ({ shape: 'roomRows-1', value: { calls } })
test("quiet: a room turn's react rows and result lines aren't drawn; ctrl+o shows them; its text is", async ($, on) => {
  const st = engine(on)
  on('ui.render', ($: any, e: any) => { const { Text } = $.ui.resolve(e); return <Text>engine</Text> })
  st.seed('chat', chatValue({}))
  st.seed('roomRows', ROOM_ROWS(['toolu_room']))
  const said = (text: string) => ({ plugin: 'agent-chat', surface: 'terminal', component: 'AssistantMessage', requestId: 'a1', props: { text, isFirstOfReply: true } }) as any
  // the agent's own text is drawn: it is nowhere else, and ctrl+o can't bring a text row back
  let ui = await $.ui.mount(said('I added a 👍 to "this is really interesting".'))
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
  const call = (id: string, isExpanded = false) => ({ plugin: 'agent-chat', surface: 'terminal', component: 'ToolUse', requestId: id,
    props: { tool_use_id: id, tool: 'mcp__agent-chat__react', input: { room_id: 'rm_1', emoji: '👍' }, isRunning: false, isErrored: false, isInterrupted: false, isExpanded } }) as any
  ui = await $.ui.mount(call('toolu_room'))
  expect(await ui.find({ type: 'Text' })).toBeUndefined()
  await ui.unmount()
  const result = (id: string) => ({ plugin: 'agent-chat', surface: 'terminal', component: 'ToolResult', requestId: id, props: { tool_use_id: id, tool: 'mcp__agent-chat__react', output: 'reacted 👍', isErrored: false } }) as any
  ui = await $.ui.mount(result('toolu_room'))
  expect(await ui.find({ type: 'Text' })).toBeUndefined()
  await ui.unmount()
  // the result line of a call that isn't a quiet room turn's is drawn (gray, in the default style)
  ui = await $.ui.mount(result('toolu_mine'))
  expect((await ui.find({ type: 'Text' }))?.text).toBe('⎿  reacted 👍')
  await ui.unmount()
  ui = await $.ui.mount({ ...result('toolu_err'), props: { ...result('toolu_err').props, isErrored: true } })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
  ui = await $.ui.mount({ ...result('toolu_bash'), props: { ...result('toolu_bash').props, tool: 'Bash' } })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
  for (const c of [call('toolu_room', true), call('toolu_mine')]) {
    ui = await $.ui.mount(c)
    expect(await ui.find({ type: 'Text', text: /^👍 Reacted in #general$/ })).toBeDefined()
    await ui.unmount()
  }
  // ctrl+o brings back the hidden result line
  ui = await $.ui.mount({ ...result('toolu_room'), props: { ...result('toolu_room').props, isExpanded: true } })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})

test("quiet: a reply keeps its ↗️ line; a value stored by an earlier build (texts, own) hides no text", async ($, on) => {
  const st = engine(on)
  on('ui.render', ($: any, e: any) => { const { Text } = $.ui.resolve(e); return <Text>engine</Text> })
  st.seed('chat', chatValue({}))
  st.seed('roomRows', { shape: 'roomRows-1', value: { texts: ['Done.', 'Posted the summary.'], calls: ['toolu_reply'], own: ['Done.'] } })
  const said = (text: string) => ({ plugin: 'agent-chat', surface: 'terminal', component: 'AssistantMessage', requestId: 'a1', props: { text, isFirstOfReply: true } }) as any
  for (const t of ['Done.', 'Posted the summary.']) {
    const ui = await $.ui.mount(said(t))
    expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
    await ui.unmount()
  }
  let ui
  const reply = { plugin: 'agent-chat', surface: 'terminal', component: 'ToolUse', requestId: 'toolu_reply',
    props: { tool_use_id: 'toolu_reply', tool: 'mcp__agent-chat__reply', input: { room_id: 'rm_1', text: 'Posted the summary.' }, isRunning: false, isErrored: false, isInterrupted: false } } as any
  ui = await $.ui.mount(reply)
  expect(await ui.find({ type: 'Text', text: /^↗️ #general · @agent ›$/ })).toBeDefined()
  await ui.unmount()
  const sent = { plugin: 'agent-chat', surface: 'terminal', component: 'ToolResult', requestId: 'toolu_reply', props: { tool_use_id: 'toolu_reply', tool: 'mcp__agent-chat__reply', output: 'sent', isErrored: false } } as any
  ui = await $.ui.mount(sent)
  expect(await ui.find({ type: 'Text' })).toBeUndefined()
  await ui.unmount()
})

test("the agent's post is one gray line that opens to the post with a fold line; its \"⎿ sent\" is gray too", async ($, on) => {
  const st = engine(on)
  on('ui.render', ($: any, e: any) => { const { Text } = $.ui.resolve(e); return <Text>engine</Text> })
  st.seed('chat', chatValue({}))
  const post = { plugin: 'agent-chat', surface: 'terminal', component: 'ToolUse', requestId: 'p1',
    props: { tool_use_id: 'toolu_p', tool: 'mcp__agent-chat__reply', input: { room_id: 'rm_1', text: '**Politics**\n\nA long essay.', reply_to: 'm1' }, isRunning: false, isErrored: false, isInterrupted: false } } as any
  let ui = await $.ui.mount(post)
  const row = await ui.find({ type: 'Text', text: /^↗️ #general · @agent \(a reply\) ›$/ })
  expect(row?.props.color).toBe('inactive')
  expect(await ui.find({ type: 'Text', text: /^Politics$/ })).toBeDefined()
  // (this test's stand-in $.state doesn't redraw on a write: mount again after each press)
  await ui.press({ key: 'tu-toolu_p' }); await ui.unmount(); ui = await $.ui.mount(post)
  expect(await ui.find({ type: 'Markdown' })).toBeDefined()
  await ui.press({ key: 'tu-toolu_p-fold' }); await ui.unmount(); ui = await $.ui.mount(post)
  expect(await ui.find({ type: 'Markdown' })).toBeUndefined()
  await ui.unmount()
  ui = await $.ui.mount({ plugin: 'agent-chat', surface: 'terminal', component: 'ToolResult', requestId: 'r2', props: { tool_use_id: 'toolu_r', tool: 'mcp__agent-chat__reply', output: 'sent', isErrored: false } } as any)
  expect((await ui.find({ type: 'Text', text: '⎿  sent' }))?.props.dimColor).toBe(true)
  await ui.unmount()
})

// The pane draws a room message as formatted text, like the web: marks drawn,
// @mentions and links in their own colors (paneMarkdown.ts).
test('a pane message is drawn as markdown: bold, a list, code, colored @mentions and links; control characters still go', async ($, on) => {
  const st = engine(on)
  st.seed('chat', chatValue({}))
  const text = '@seenimohamed @caraxes **Agent Chat 0.16.0 is out**\u001b[2J. Run `/agent-chat update`.\n\n1. **Fixed:** the bridge\n- see https://github.com/facilio/agent-chat-plugin/pull/3\n- @everyone please update'
  st.seed('view', { ...VIEW, value: { ...VIEW.value, agents: ['odin', 'caraxes'], messages: [{ id: 'm1', who: '@odin', mine: false, text, ts: Date.now() }] } })
  const ui = await $.ui.mount(PANE('terminal'))
  expect(await ui.find({ type: 'Text', text: /\*\*/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /^Agent Chat 0\.16\.0 is out$/ }))?.props.bold).toBe(true)
  expect((await ui.find({ type: 'Text', text: /^\/agent-chat update$/ }))?.props.color).toBe('permission')
  expect((await ui.find({ type: 'Text', text: /^@caraxes$/ }))?.props.color).toBe('merged')
  expect((await ui.find({ type: 'Text', text: /^@seenimohamed$/ }))?.props.color).toBe('suggestion')
  expect((await ui.find({ type: 'Text', text: /^@everyone$/ }))?.props.color).toBe('warning')
  expect((await ui.find({ type: 'Link' }))?.props.href).toBe('https://github.com/facilio/agent-chat-plugin/pull/3')
  expect(await ui.find({ type: 'Text', text: /^1\. $/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^• $/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\u001b/ })).toBeUndefined()
  await ui.unmount()
})
