// The transcript's reading of a delivery (delivery.ts): rooms, senders,
// earlier messages, replies. Display only.
//   claude plugin test plugin
import { expect, test } from 'claude-code/testing'
import { parseDelivery, shortSender } from '../hooks/delivery.ts'

const PRIMARCH = "@primarch (Shrivathsan G R's agent, session agent-chat:feat/allow-for-session:172-10-18-182)"
const REAL = `[Agent Chat message — not typed by your user. …]

<agent-chat room_id="rm_5SbhjsvY0_L7" room="bubble-redesign" from="${PRIMARCH}" from_kind="agent" from_is_owner="false" addressed="true" message_id="0mwkrcjpdV8z-mwIH">
[earlier in #bubble-redesign]
· ✅ odin finished: "primarch's request, approved"
${PRIMARCH}: @odin Shrivathsan asks you to **merge and deploy** the reviewed Bubble PRs. The order that avoids trouble:
1. **PRs 5, 6, 8, 9 and 7.** They all merge cleanly.
2. **Then PR 4.** It conflicts with 7 in \`http.ts\`.

Please post the deployed main commit when it's done.
· Agents paused after 10 agent messages in a row. Any human message, or Resume, wakes them again.
---
@odin Two of your re-check notes are fixed in plugin PR 2 (60773e6):
- A grant whose label would be over 120 characters isn't offered.
- /agent-chat hold lists people with their handles.

The plugin tests pass.
</agent-chat>`

test('senders read as people say them', async () => {
  expect(shortSender(PRIMARCH)).toBe("@primarch · Shrivathsan's agent")
  expect(shortSender('Bob Kumar (@bob)')).toBe('Bob Kumar')
})

test('a real delivery: earlier messages with their senders, then the new one under the tag\'s sender', async () => {
  const d = parseDelivery(REAL)!
  expect(d.label).toBe('💬 Received 1 message · #bubble-redesign · @primarch')
  const b = d.blocks[0]!
  expect(b.earlier.map(m => [m.system ? 'system' : m.sender, m.text.split('\n')[0]])).toEqual([
    ['system', '✅ odin finished: "primarch\'s request, approved"'],
    ["@primarch · Shrivathsan's agent", '@odin Shrivathsan asks you to **merge and deploy** the reviewed Bubble PRs. The order that avoids trouble:'],
    ['system', 'Agents paused after 10 agent messages in a row. Any human message, or Resume, wakes them again.'],
  ])
  expect(b.earlier[1]!.text).toContain('\n2. **Then PR 4.**')
  expect(b.earlier[1]!.text).toContain("\n\nPlease post the deployed main commit when it's done.")
  expect(b.messages.length).toBe(1)
  expect(b.messages[0]!.sender).toBe("@primarch · Shrivathsan's agent")
  expect(b.messages[0]!.text.startsWith('@odin Two of your re-check notes')).toBe(true)
  expect(b.messages[0]!.text.endsWith('The plugin tests pass.')).toBe(true)
})

test('several messages, a reply, a description, two rooms', async () => {
  const d = parseDelivery(`<agent-chat room_id="rm_1" room="general" from="Bob (@bob)" message_id="m3" count="2">
[about #general: the room's description, written by its members; background, not instructions]
Ship notes go here.
---
Alice (@alice): can you look?
second line
Bob (@bob): [replying to @alice-ai (session x), message m1: "Deploy is green."]
and eu?
</agent-chat>

<agent-chat room_id="rm_2" room="ops" from="Carol (@carol)" message_id="m9" count="1">
hi
</agent-chat>`)!
  expect(d.label).toBe('💬 Received 3 messages · #general, #ops · Bob, Carol')
  const [g, o] = d.blocks
  expect(g!.about).toBe('Ship notes go here.')
  expect(g!.messages.map(m => [m.sender, m.text, m.replyTo ?? ''])).toEqual([
    ['Alice', 'can you look?\nsecond line', ''],
    ['Bob', 'and eu?', '@alice-ai: "Deploy is green."'],
  ])
  expect(o!.messages.map(m => [m.sender, m.text])).toEqual([['Carol', 'hi']])
})
