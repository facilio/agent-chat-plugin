// agent-chat-view: draws agent-chat's room-message deliveries in the
// transcript. Claude Code never runs a plugin's own render hooks on a row that
// plugin sent (the re-entry rule), so agent-chat can't fold the prompts it
// submits; this companion can. One line each by default ("💬 Received 3
// messages · #room · Bob ›"); pressing it opens them as a chat: each message
// under its sender, its markdown drawn. Display only: what the model reads is
// the delivery as agent-chat sent it.
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'
import { parseDelivery, type Delivery, type RoomBlock, type RoomMsg } from './delivery.ts'

const SENDER_PLUGIN = 'agent-chat'
const opened = atom({ plugin: 'agent-chat-view', key: 'opened' } as const, [] as string[], { shape: 'opened-1' })

// Plain text for the screen: no control characters (room text could carry
// escape sequences) and no bidi overrides; newlines kept, tabs as spaces.
const plain = (t: unknown) => String(t ?? '').replace(/\t/g, '  ').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '')

function mdBody(ui: any, text: string, dim?: boolean) {
  const t = plain(text) || ' '
  return ui.Markdown ? <ui.Markdown text={t} dimColor={dim} /> : <ui.Text dimColor={dim} wrap="wrap">{t}</ui.Text>
}
function drawMsg(ui: any, m: RoomMsg, key: string, dim?: boolean) {
  const { Box, Text } = ui
  if (m.system) return <Box key={key} marginTop={1}><Text dimColor wrap="wrap">· {plain(m.text)}</Text></Box>
  return (
    <Box key={key} flexDirection="column" marginTop={1}>
      <Text bold={!dim} dimColor={dim}>{plain(m.sender) || 'Someone'}</Text>
      {m.replyTo ? <Text dimColor wrap="wrap">↪ replying to {plain(m.replyTo)}</Text> : null}
      {mdBody(ui, m.text, dim)}
    </Box>
  )
}
function drawBlock(ui: any, b: RoomBlock, named: boolean, key: string) {
  const { Box, Text } = ui
  return (
    <Box key={key} flexDirection="column" marginTop={named ? 1 : 0}>
      {named ? <Text bold>#{plain(b.room)}</Text> : null}
      {b.about ? <Box flexDirection="column"><Text dimColor>About #{plain(b.room)} (its description, written by its members)</Text>{mdBody(ui, b.about, true)}</Box> : null}
      {b.notes.map((n, i) => <Text key={`n${i}`} dimColor wrap="wrap">{plain(n)}</Text>)}
      {b.earlier.length ? <Box flexDirection="column"><Text dimColor>Earlier in #{plain(b.room)}</Text>{b.earlier.map((m, i) => drawMsg(ui, m, `e${i}`, true))}</Box> : null}
      {b.earlier.length && b.messages.length ? <Box marginTop={1}><Text dimColor>New</Text></Box> : null}
      {b.messages.map((m, i) => drawMsg(ui, m, `m${i}`))}
    </Box>
  )
}

export const register: Register = on => {
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const p = e.props as any
    // Only agent-chat's own deliveries: the plugin that sent the row, and its frame.
    if (p.origin?.kind !== 'plugin' || p.origin?.name !== SENDER_PLUGIN || !String(p.text ?? '').includes('<agent-chat room_id=')) return next(e)
    let d: Delivery | null = null
    try { d = parseDelivery(String(p.text)) } catch { d = null }
    if (!d) return next(e)
    // Always folded: the engine marks a short row "expanded" too, so
    // isExpanded can't tell ctrl+o from a short message.
    const ui = $.ui.resolve(e) as any
    const { Box, Text, Button } = ui
    const key = d.key
    const isOpen = (await read($, opened)).includes(key)
    const toggle = () => { void update($, opened, o => o.includes(key) ? o.filter(k => k !== key) : [...o, key].slice(-50)) }
    return (
      <Box flexDirection="column">
        <Button key={`rx-${key}`} onPress={toggle}><Text dimColor>{plain(d.label)} {isOpen ? '⌄' : '›'}</Text></Button>
        {isOpen ? <Box flexDirection="column" paddingLeft={2}>{d.blocks.map((b, i) => drawBlock(ui, b, d!.blocks.length > 1, `b${i}`))}</Box> : null}
      </Box>
    )
  })
}
