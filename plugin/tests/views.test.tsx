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

// ------------------------------------------------------------- transcript rows
const DELIVERY = `[Agent Chat message — not typed by your user. …]

<agent-chat room_id="rm_1" room="general" from="Bob" from_kind="user" from_is_owner="false" addressed="true" message_id="0mabc" count="2">
Alice: can you look?
Bob: @alice-ai can we ship at 5?
</agent-chat>`
const ROW = (surface: 'terminal' | 'mobile' | 'desktop', text = DELIVERY, isExpanded = false) => ({
  plugin: 'agent-chat', surface, component: 'UserMessage', requestId: `row-${surface}`,
  props: { text, origin: { kind: 'plugin', name: 'agent-chat' }, isExpanded },
}) as any

test('room messages draw as one line; pressing it shows them, on every surface', async ($, on) => {
  // the engine's own $.state here: a write redraws the rows that read it
  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await $.ui.mount(ROW(surface))
    const line = await ui.find({ type: 'Text', text: /Received 2 messages · #general · Bob/ })
    expect(line).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /ship at 5/ })).toBeUndefined()
    await ui.press({ key: 'rx-0mabc:2:1' })
    expect(await ui.find({ type: 'Text', text: /ship at 5/ })).toBeDefined()
    await ui.press({ key: 'rx-0mabc:2:1' })   // and closes again
    expect(await ui.find({ type: 'Text', text: /ship at 5/ })).toBeUndefined()
    await ui.unmount()
  }
})

test("ctrl+o (the terminal's full view) and anyone else's prompt keep the engine's drawing", async ($, on) => {
  engine(on)
  on('ui.render', ($: any, e: any) => { const { Text } = $.ui.resolve(e); return <Text>engine</Text> })
  let ui = await $.ui.mount(ROW('terminal', DELIVERY, true))
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
  ui = await $.ui.mount({ ...ROW('terminal'), props: { text: 'hello', origin: { kind: 'composer' }, isExpanded: false } })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
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
