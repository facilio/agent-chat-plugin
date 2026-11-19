// The pane's reading of a room message as markdown (paneMarkdown.ts).
//   claude plugin test plugin
import { expect, test } from 'claude-code/testing'
import { cellWidth, parseInline, parseMessage, tableLines, visibleLines, type Block } from '../hooks/paneMarkdown.ts'

const ctx = { agents: new Set(['odin', 'caraxes']) }

test('inline marks: bold, italics, code, links, mentions; unclosed marks stay as typed', () => {
  expect(parseInline('**Agent Chat 0.16.0 is out** now', ctx)).toEqual([{ bold: true, text: 'Agent Chat 0.16.0 is out' }, { text: ' now' }])
  expect(parseInline('run `/agent-chat update` *then* reload', ctx)).toEqual([
    { text: 'run ' }, { code: true, text: '/agent-chat update' }, { text: ' ' }, { italic: true, text: 'then' }, { text: ' reload' },
  ])
  expect(parseInline('@odin @seenimohamed @everyone @kraken-ai', ctx).filter(s => s.mention).map(s => [s.text, s.mention])).toEqual([
    ['@odin', 'agent'], ['@seenimohamed', 'person'], ['@everyone', 'everyone'], ['@kraken-ai', 'agent'],
  ])
  expect(parseInline('ask @caraxes:seeni-2', ctx)[1]).toEqual({ text: '@caraxes:seeni-2', mention: 'agent' })
  expect(parseInline('PR https://github.com/facilio/agent-chat-plugin/pull/3.', ctx)).toEqual([
    { text: 'PR ' }, { text: 'https://github.com/facilio/agent-chat-plugin/pull/3', href: 'https://github.com/facilio/agent-chat-plugin/pull/3' }, { text: '.' },
  ])
  // a label that doesn't name the site shows the host it really opens
  expect(parseInline('[the PR](https://example.com/x)', ctx)).toEqual([{ text: 'the PR', href: 'https://example.com/x' }, { text: ' (example.com)', note: true }])
  // an email is not a mention; snake_case is not italics; a lone * stays
  expect(parseInline('mail seeni@facilio.com about my_var_name * 2', ctx)).toEqual([{ text: 'mail seeni@facilio.com about my_var_name * 2' }])
  // a mention inside bold keeps both
  expect(parseInline('**hey @odin**', ctx)).toEqual([{ bold: true, text: 'hey ' }, { bold: true, text: '@odin', mention: 'agent' }])
})

test('blocks: lists, headings, quotes, code fences, rules; the width is measured on what shows', () => {
  const blocks = parseMessage('## Plan\n\n1. **First**\n- second\n  - nested\n> quoted\n```\nnpm test\n```\n---\nEnd.', ctx)
  expect(blocks.map(b => b.kind)).toEqual(['heading', 'blank', 'item', 'item', 'item', 'quote', 'code', 'rule', 'line'])
  expect(visibleLines(blocks)).toEqual(['Plan', '', '1. First', '• second', '  • nested', '│ quoted', '  npm test', '───', 'End.'])
})

test('bold italic and strikethrough', () => {
  expect(parseInline('***bold italic***, ~~gone~~ and **b**', ctx)).toEqual([
    { bold: true, italic: true, text: 'bold italic' }, { text: ', ' }, { strike: true, text: 'gone' }, { text: ' and ' }, { bold: true, text: 'b' },
  ])
  // a lone ~ or an unclosed ~~ stays as typed
  expect(parseInline('~5 min, ~~not closed', ctx)).toEqual([{ text: '~5 min, ~~not closed' }])
})

test('a table: cells parsed with their marks, columns aligned as the |:---:| line says, emoji two cells wide', () => {
  const text = '| Item | Status | Owner |\n| --- | :---: | ---: |\n| Room join | ✅ done | @caraxes |\n| **Formatting** test | running | caraxes |\nafter'
  const blocks = parseMessage(text, ctx)
  expect(blocks.map(b => b.kind)).toEqual(['table', 'line'])
  const t = blocks[0] as Extract<Block, { kind: 'table' }>
  expect(t.align).toEqual(['left', 'center', 'right'])
  expect(t.rows).toHaveLength(3)
  expect(t.rows[1]![2]).toEqual([{ text: '@caraxes', mention: 'agent' }])
  expect(t.rows[2]![0]).toEqual([{ bold: true, text: 'Formatting' }, { text: ' test' }])
  expect(tableLines(t).lines).toEqual([
    'Item            │ Status  │    Owner',
    '────────────────┼─────────┼─────────',
    'Room join       │ ✅ done │ @caraxes',
    'Formatting test │ running │  caraxes',
  ])
  expect(cellWidth('✅ done')).toBe(7)
  // a pipe in a line with no |---| line under it is not a table
  expect(parseMessage('a | b', ctx).map(b => b.kind)).toEqual(['line'])
})

test("a link whose label names another site shows the host it really opens", () => {
  expect(parseInline('[github.com/facilio/x](https://evil.example.com/login)', ctx)).toEqual([
    { text: 'github.com/facilio/x', href: 'https://evil.example.com/login' }, { text: ' (evil.example.com)', note: true },
  ])
  // the label names the site (www. aside): nothing added; a bare URL is its own label
  expect(parseInline('[GitHub.com/x](https://www.github.com/x)', ctx)).toEqual([{ text: 'GitHub.com/x', href: 'https://www.github.com/x' }])
  expect(parseInline('https://github.com/x', ctx)).toEqual([{ text: 'https://github.com/x', href: 'https://github.com/x' }])
})
