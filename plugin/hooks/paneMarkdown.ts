// The pane's room messages as formatted text, the way chat.facilio.bot shows
// them: markdown marks drawn (bold, italics, lists, code) instead of shown as
// typed, @mentions and links in their own colors. This file only parses; the
// pane draws the result (register.tsx). Display only: the model never sees it.
//
// A small parser of its own, not the Markdown element: Markdown can't color an
// @mention inside its text. Chat messages keep their line breaks, so each
// source line stays a line.

export type MentionKind = 'agent' | 'person' | 'everyone'
export type Align = 'left' | 'center' | 'right'
export type Span = {
  text: string
  bold?: boolean
  italic?: boolean
  strike?: boolean
  code?: boolean
  href?: string            // a link: text is what it shows
  mention?: MentionKind    // an @mention: text is "@name"
}
export type Block =
  | { kind: 'line'; spans: Span[] }                                   // a paragraph line
  | { kind: 'heading'; spans: Span[] }
  | { kind: 'item'; indent: number; marker: string; spans: Span[] }   // "•" or "1."
  | { kind: 'quote'; spans: Span[] }
  | { kind: 'code'; lines: string[] }                                 // a ``` fence
  | { kind: 'rule' }
  | { kind: 'table'; align: Align[]; rows: Span[][][]; raw: string[] }   // rows[0] is the header
  | { kind: 'blank' }

// Who is an agent: names seen as agent authors in the room, and handles that
// end in -ai (the room's own naming rule). Everyone else mentioned is a person.
export type MentionCtx = { agents: ReadonlySet<string> }

const URL_RE = /https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"*_`]/y
const MENTION_RE = /@([A-Za-z0-9][\w-]*)(?::[\w.-]+)?/y

function mentionKind(handle: string, ctx: MentionCtx): MentionKind {
  const h = handle.toLowerCase()
  if (h === 'everyone') return 'everyone'
  return ctx.agents.has(h) || h.endsWith('-ai') ? 'agent' : 'person'
}

// Inline marks of one line: `code`, [text](url), bare URLs, ***bold
// italic***, **bold**, *italic* / _italic_, ~~strikethrough~~, and
// @mentions. Unclosed marks stay as typed.
export function parseInline(src: string, ctx: MentionCtx, style: Omit<Span, 'text'> = {}): Span[] {
  const out: Span[] = []
  let buf = ''
  const flush = () => { if (buf) { out.push({ ...style, text: buf }); buf = '' } }
  const wordChar = (c: string | undefined) => !!c && /[\w.]/.test(c)
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    // `code`: taken as is, no marks inside
    if (c === '`') {
      const end = src.indexOf('`', i + 1)
      if (end > i + 1) { flush(); out.push({ ...style, code: true, text: src.slice(i + 1, end) }); i = end + 1; continue }
    }
    // [text](https://…)
    if (c === '[') {
      const m = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/y
      m.lastIndex = i
      const r = m.exec(src)
      if (r) { flush(); out.push({ ...style, text: r[1]!, href: r[2]! }); i = m.lastIndex; continue }
    }
    // a bare URL
    if ((c === 'h') && !wordChar(src[i - 1])) {
      URL_RE.lastIndex = i
      const r = URL_RE.exec(src)
      if (r) { flush(); out.push({ ...style, text: r[0], href: r[0] }); i = URL_RE.lastIndex; continue }
    }
    // @mention, not inside an email address
    if (c === '@' && !wordChar(src[i - 1])) {
      MENTION_RE.lastIndex = i
      const r = MENTION_RE.exec(src)
      if (r) { flush(); out.push({ ...style, text: r[0], mention: mentionKind(r[1]!, ctx) }); i = MENTION_RE.lastIndex; continue }
    }
    // ***bold italic*** / ___bold italic___
    if ((c === '*' || c === '_') && src[i + 1] === c && src[i + 2] === c) {
      const mark = c + c + c
      const end = src.indexOf(mark, i + 3)
      if (end > i + 3 && src[i + 3] !== ' ') {
        flush(); out.push(...parseInline(src.slice(i + 3, end), ctx, { ...style, bold: true, italic: true })); i = end + 3; continue
      }
    }
    // ~~strikethrough~~
    if (c === '~' && src[i + 1] === '~') {
      const end = src.indexOf('~~', i + 2)
      if (end > i + 2 && src[i + 2] !== ' ') {
        flush(); out.push(...parseInline(src.slice(i + 2, end), ctx, { ...style, strike: true })); i = end + 2; continue
      }
    }
    // **bold** / __bold__
    if ((c === '*' || c === '_') && src[i + 1] === c) {
      const mark = c + c
      const end = src.indexOf(mark, i + 2)
      if (end > i + 2 && src[i + 2] !== ' ') {
        flush(); out.push(...parseInline(src.slice(i + 2, end), ctx, { ...style, bold: true })); i = end + 2; continue
      }
    }
    // *italic* / _italic_ (an underscore only at a word's edge: snake_case stays)
    if ((c === '*' || c === '_') && src[i + 1] !== ' ' && src[i + 1] !== c && (c === '*' || !wordChar(src[i - 1]))) {
      let end = src.indexOf(c, i + 1)
      while (end > 0 && c === '_' && wordChar(src[end + 1])) end = src.indexOf(c, end + 1)
      if (end > i + 1 && src[end - 1] !== ' ') {
        flush(); out.push(...parseInline(src.slice(i + 1, end), ctx, { ...style, italic: true })); i = end + 1; continue
      }
    }
    buf += c
    i++
  }
  flush()
  return out
}

const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/
// A table row's cells: the outer pipes dropped, split on the rest (not \|).
function cells(line: string): string[] {
  const t = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '')
  return t.split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'))
}

// Cells a string takes on the terminal: an emoji takes two, a joiner or
// variation selector none.
export function cellWidth(s: string): number {
  let w = 0
  for (const ch of s) {
    if (/[\u200d\ufe00-\ufe0f\u0300-\u036f]/.test(ch)) continue
    w += /\p{Extended_Pictographic}|[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\uff00-\uff60\uffe0-\uffe6]/u.test(ch) ? 2 : 1
  }
  return w
}
// A table's column widths and its rows as drawn ("a │ b"), header first,
// then a ─┼─ line.
export function tableLines(b: Extract<Block, { kind: 'table' }>): { widths: number[]; lines: string[] } {
  const t = (s: Span[]) => s.map(x => x.text).join('')
  const widths = b.align.map((_, k) => Math.max(1, ...b.rows.map(r => cellWidth(t(r[k] ?? [])))))
  const pad = (s: string, k: number) => {
    const gap = widths[k]! - cellWidth(s)
    const a = b.align[k]
    const left = a === 'right' ? gap : a === 'center' ? Math.floor(gap / 2) : 0
    return ' '.repeat(left) + s + ' '.repeat(gap - left)
  }
  const row = (r: Span[][]) => r.map((c, k) => pad(t(c), k)).join(' │ ')
  return { widths, lines: [row(b.rows[0]!), widths.map(w => '─'.repeat(w)).join('─┼─'), ...b.rows.slice(1).map(row)] }
}

export function parseMessage(text: string, ctx: MentionCtx): Block[] {
  const blocks: Block[] = []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const fence = /^\s*(```|~~~)/.exec(line)
    if (fence) {
      const code: string[] = []
      let j = i + 1
      while (j < lines.length && !lines[j]!.trimStart().startsWith(fence[1]!)) code.push(lines[j++]!)
      blocks.push({ kind: 'code', lines: code })
      i = j
      continue
    }
    if (!line.trim()) {
      if (blocks.length && blocks[blocks.length - 1]!.kind !== 'blank') blocks.push({ kind: 'blank' })
      continue
    }
    // a table: a row of cells, then a |---|:---:| line under it
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!)) {
      const align = cells(lines[i + 1]!).map(c => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left') as Align)
      const raw = [line, lines[i + 1]!]
      const rows = [cells(line)]
      let j = i + 2
      while (j < lines.length && lines[j]!.includes('|') && lines[j]!.trim()) { raw.push(lines[j]!); rows.push(cells(lines[j]!)); j++ }
      const n = align.length
      blocks.push({ kind: 'table', align, raw, rows: rows.map(r => Array.from({ length: n }, (_, k) => parseInline(r[k] ?? '', ctx))) })
      i = j - 1
      continue
    }
    let r: RegExpExecArray | null
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { blocks.push({ kind: 'rule' }); continue }
    if ((r = /^\s*#{1,6}\s+(.*)$/.exec(line))) { blocks.push({ kind: 'heading', spans: parseInline(r[1]!, ctx, { bold: true }) }); continue }
    if ((r = /^(\s*)[-*+]\s+(.*)$/.exec(line))) { blocks.push({ kind: 'item', indent: Math.floor(r[1]!.length / 2), marker: '•', spans: parseInline(r[2]!, ctx) }); continue }
    if ((r = /^(\s*)(\d{1,3}[.)])\s+(.*)$/.exec(line))) { blocks.push({ kind: 'item', indent: Math.floor(r[1]!.length / 2), marker: r[2]!, spans: parseInline(r[3]!, ctx) }); continue }
    if ((r = /^\s*>\s?(.*)$/.exec(line))) { blocks.push({ kind: 'quote', spans: parseInline(r[1]!, ctx) }); continue }
    blocks.push({ kind: 'line', spans: parseInline(line, ctx) })
  }
  while (blocks.length && blocks[blocks.length - 1]!.kind === 'blank') blocks.pop()
  return blocks
}

// The text each block shows, one string per row before wrapping: what the
// bubble's width is measured on (not the raw marks).
export function visibleLines(blocks: Block[]): string[] {
  const t = (s: Span[]) => s.map(x => x.text).join('')
  return blocks.map(b =>
    b.kind === 'code' ? b.lines.map(l => `  ${l}`)
    : b.kind === 'item' ? [`${'  '.repeat(b.indent)}${b.marker} ${t(b.spans)}`]
    : b.kind === 'quote' ? [`│ ${t(b.spans)}`]
    : b.kind === 'rule' ? ['───']
    : b.kind === 'table' ? tableLines(b).lines
    : b.kind === 'blank' ? ['']
    : [t(b.spans)]).flat()
}
