// agent-chat-view draws agent-chat's deliveries: folded, opening to a chat.
//   claude plugin test view
import { expect, test } from 'claude-code/testing'

// ------------------------------------------------------------- transcript rows
const DELIVERY = `[Agent Chat message — not typed by your user. …]

<agent-chat room_id="rm_1" room="general" from="Bob (@bob)" from_kind="user" from_is_owner="false" addressed="true" message_id="0mabc" count="2">
Alice (@alice): can you look?
Bob (@bob): @alice-ai can we ship at 5?
</agent-chat>`
const ROW = (surface: 'terminal' | 'mobile' | 'desktop', text = DELIVERY, isExpanded = false) => ({
  plugin: 'agent-chat-view', surface, component: 'UserMessage', requestId: `row-${surface}`,
  props: { text, origin: { kind: 'plugin', name: 'agent-chat' }, isExpanded },
}) as any

test('room messages draw as one line; pressing it shows them, on every surface', async ($, on) => {
  // the engine's own $.state here: a write redraws the rows that read it
  for (const surface of ['terminal', 'desktop', 'mobile'] as const) {
    const ui = await $.ui.mount(ROW(surface))
    const line = await ui.find({ type: 'Text', text: /Received 2 messages · #general · Bob/ })
    expect(line).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: /ship at 5/ })).toBeUndefined()
    await ui.press({ key: 'rx-0mabc:2:1' })
    // open: each message under its sender, its text drawn as markdown
    expect(await ui.find({ type: 'Text', text: /^Bob$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Alice$/ })).toBeDefined()
    expect(await ui.find({ type: 'Markdown', text: /@alice-ai can we ship at 5\?/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /<agent-chat/ })).toBeUndefined()
    await ui.press({ key: 'rx-0mabc:2:1' })   // and closes again
    expect(await ui.find({ type: 'Markdown', text: /ship at 5/ })).toBeUndefined()
    await ui.unmount()
  }
})

test("short deliveries fold too (the engine marks them expanded); anyone else's prompt keeps the engine's drawing", async ($, on) => {
  on('ui.render', ($: any, e: any) => { const { Text } = $.ui.resolve(e); return <Text>engine</Text> })
  const short = '<agent-chat room_id="rm_1" room="general" from="Bob" message_id="0mxyz" count="1">\nok\n</agent-chat>'
  let ui = await $.ui.mount(ROW('terminal', short, true))
  expect(await ui.find({ type: 'Text', text: /Received 1 message · #general · Bob/ })).toBeDefined()
  await ui.unmount()
  ui = await $.ui.mount({ ...ROW('terminal'), props: { text: 'hello', origin: { kind: 'composer' }, isExpanded: false } })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})


test("another plugin's prompt with the same frame is left alone", async ($, on) => {
  on('ui.render', ($: any, e: any) => { const { Text } = $.ui.resolve(e); return <Text>engine</Text> })
  const ui = await $.ui.mount({ ...ROW('terminal'), props: { text: DELIVERY, origin: { kind: 'plugin', name: 'someone-else' }, isExpanded: false } })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})
