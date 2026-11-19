// A copy lives only here (agent-chat-view); agent-chat sends the deliveries this reads.
// How the transcript shows a delivery of room messages (the prompt the plugin
// sends the model): parsed back into rooms and messages, display only. The
// model's text is never changed.
//
// A delivery is one or more <agent-chat …> blocks (src/bridge.ts wakeFor):
//   [about #room: …] / description / ---        a room description, when new
//   [Agents in #room were paused …] / ---       after a resume
//   [earlier in #room] / Name: text … / ---     what came before, unaddressed
//   Name: text …                                 the messages, all but the last
//   text                                         the last (or "Name: text" when several)
// A sender is "@handle (Owner's agent, session …)" or "Name (@handle)"; a
// system line starts with "· ". A message's text runs until the next sender.

export type RoomMsg = { sender: string; full?: string; text: string; system?: boolean; replyTo?: string }
export type RoomBlock = { room: string; about?: string; notes: string[]; earlier: RoomMsg[]; messages: RoomMsg[]; decision?: string }
export type Delivery = { key: string; label: string; blocks: RoomBlock[]; firstLine?: string }

const SENDER = /^(@[A-Za-z][\w-]* \([^()\n]*\)|[^\n:@()]{1,80} \(@[\w.+-]+\)): ?(.*)$/
const REPLY = /^\[replying to (.+?), message [\w-]+: "([\s\S]*)"\]$/

// "@primarch (Shrivathsan G R's agent, session x)" -> "@primarch · Shrivathsan's agent"
// "Bob Kumar (@bob)" -> "Bob Kumar"
export function shortSender(s: string): string {
  const agent = /^(@[\w-]+) \((.+?)'s agent\b/.exec(s)
  if (agent) return `${agent[1] ?? ''} · ${(agent[2] ?? '').split(' ')[0] ?? ''}'s agent`
  const bare = /^(@[\w-]+) \(/.exec(s)          // "@alice-ai (session x)"
  if (bare) return bare[1] ?? s
  const person = /^(.+?) \(@[\w.+-]+\)$/.exec(s)
  return person?.[1] ?? s
}

function parseBlock(attrs: Record<string, string>, body: string): RoomBlock {
  const room = attrs.room ?? attrs.room_id ?? 'room'
  const b: RoomBlock = { room, notes: [], earlier: [], messages: [] }
  if (attrs.status === 'owner_decision') b.decision = attrs.decision === 'allow' ? 'allowed' : 'declined'
  const lines = body.split('\n')
  let section: 'messages' | 'earlier' | 'about' = 'messages'
  let cur: RoomMsg | null = null
  const list = () => section === 'earlier' ? b.earlier : b.messages
  const push = (m: RoomMsg) => { cur = m; list().push(m) }
  for (const line of lines) {
    if (line === '---') { section = 'messages'; cur = null; continue }
    if (section === 'about') { b.about = b.about ? `${b.about}\n${line}` : line; continue }
    if (/^\[about #.*\]$/.test(line)) { section = 'about'; cur = null; continue }
    if (/^\[earlier in #.*\]$/.test(line)) { section = 'earlier'; cur = null; continue }
    if (/^\[(Agents in #.* were paused|#.* no longer has a description).*\]$/.test(line)) { b.notes.push(line.slice(1, -1)); continue }
    if (line.startsWith('· ')) { push({ sender: '', text: line.slice(2), system: true }); cur = null; continue }
    const m = SENDER.exec(line)
    if (m) { push({ sender: shortSender(m[1] ?? ''), full: m[1], text: m[2] ?? '' }); continue }
    if (!cur) { push({ sender: '', text: line }); continue }
    const c: RoomMsg = cur
    c.text = c.text ? `${c.text}\n${line}` : line
  }
  // The last message carries no sender when it's the only one: the tag's.
  for (const m of b.messages) if (!m.sender && !m.system) { m.sender = shortSender(attrs.from ?? ''); m.full = attrs.from }
  for (const m of [...b.earlier, ...b.messages]) {
    const first = m.text.split('\n')[0] ?? ''
    const r = REPLY.exec(first)
    if (r) { m.replyTo = `${shortSender(r[1] ?? '')}: "${r[2] ?? ''}"`; m.text = m.text.split('\n').slice(1).join('\n') }
  }
  return b
}

// How room messages look in the transcript (kept the same in
// plugin/hooks/register.tsx and view/hooks/delivery.ts): one gray line each,
// two columns in, the message's first line under it.
//   ↙️ #room (1) · Bob ›          what reached the agent (agent-chat-view)
//   ↗️ #room · @agent (a reply) › what the agent posted (agent-chat)
export const IN_ICON = '↙️'
export const OUT_ICON = '↗️'
// The rows' text color, darker than Claude Code's own gray (246)
export const ROW_FG = '#6c6c6c'
// The first words of the delivery's newest message, for its one-line label.
export const PREVIEW_CHARS = 60
export function firstWords(text: string, max = PREVIEW_CHARS): string {
  const t = text.replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

export function parseDelivery(text: string): Delivery | null {
  const blocks: RoomBlock[] = []
  let n = 0, last = ''
  const from = new Set<string>()
  for (const m of text.matchAll(/<agent-chat ([^>\n]*)>\n([\s\S]*?)\n<\/agent-chat>/g)) {
    const attrs: Record<string, string> = Object.fromEntries([...(m[1] ?? '').matchAll(/(\w+)="([^"]*)"/g)].map(a => [a[1] ?? '', a[2] ?? '']))
    n += Number(attrs.count) > 0 ? Number(attrs.count) : 1
    last = attrs.message_id ?? last
    if (attrs.from) from.add(shortSender(attrs.from).split(' · ')[0] ?? attrs.from)
    blocks.push(parseBlock(attrs, m[2] ?? ''))
  }
  if (!blocks.length) return null
  const rooms = [...new Set(blocks.map(b => b.room))]
  const who = [...from].slice(0, 2).join(', ') + (from.size > 2 ? ` +${from.size - 2}` : '')
  const decision = blocks.find(b => b.decision)?.decision
  const newest = blocks[blocks.length - 1]!.messages.filter(m => !m.system).pop()
  const hashed = rooms.map(r => `#${r}`).join(', ')
  // The arrow says it came in: room (count) · who, the newest message's first line under it
  const label = `${IN_ICON} ${hashed}${decision ? '' : ` (${n})`} · ${decision ? `You ${decision} a request` : who || 'Someone'}`
  const firstLine = !decision && newest ? `${n > 1 && newest.sender ? `${newest.sender}: ` : ''}${firstWords(newest.text, 200)}` : undefined
  return { key: `${last}:${n}:${blocks.length}`, label, blocks, firstLine }
}
