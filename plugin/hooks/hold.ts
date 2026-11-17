import { userHandle } from './protocol.ts'

// ------------------------------------- what a room-woken turn may do unasked
// A turn that someone besides the owner started (a colleague's message, an
// agent's, a room description) is "tainted": Claude read text the owner didn't
// write, and a model can be talked into things. On such a turn every tool that
// could change this machine or send anything out waits for the owner's
// Allow/Deny, whatever the session's permission mode (auto mode included).
// Only tools that just read this machine run unasked; what they read can leave
// only through `reply`, which has its own guard (privacy.ts).
//
// This is a hold on turns, not taint tracking: a colleague's words stay in the
// context after the owner speaks, and a turn the owner starts runs with the
// session's normal permissions.

// Built-in tools that only read local state and send nothing anywhere.
// Anything not listed (Bash, Edit, Write, WebFetch, WebSearch, Agent, Skill,
// MCP tools, scheduling …) is held. Absent from the list means held.
export const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'ToolSearch', 'TodoWrite', 'TaskList', 'TaskGet'])

// This plugin's own tools that a room turn needs. `reply` is guarded on its
// own; start_task starts work only from a message the backend says the owner
// wrote (tasks.ts); create_room, add_members and propose_avatar act as the
// owner, so they are held like any other action.
export const ROOM_TOOLS = new Set(['reply', 'list_rooms', 'read_history', 'ask_owner', 'get_attachment', 'start_task'])

// This plugin's tools that act as the owner: held even inside a task.
export const OWNER_ACTS = new Set(['create_room', 'add_members', 'propose_avatar'])

export function holdsOnTaintedTurn(tool: string, plugin: string): boolean {
  if (READ_TOOLS.has(tool)) return false
  const own = `mcp__${plugin}__`
  return !(tool.startsWith(own) && ROOM_TOOLS.has(tool.slice(own.length)))
}

// The tool's own arguments from a tool.call event (they ride beside its keys).
export function toolArgs(e: Record<string, unknown>): Record<string, unknown> {
  const { tool, tool_use_id, agentId, requestMeta, consent, ...args } = e
  return args
}

// ------------------------------- "Allow <person> for this session" (pure)
// The people behind a held turn: an agent counts as its owner (the bridge
// works that out per wake). Null when any untrusted part of the turn can't
// be pinned on people: then no per-person grant is offered.
export type Person = { email: string; name: string }
export function turnPeople(batch: Array<{ trusted: boolean; from: Person[] | null }>): Person[] | null {
  const held = batch.filter(w => !w.trusted)
  if (!held.length || held.some(w => !w.from)) return null
  const people = [...new Map(held.flatMap(w => w.from ?? []).map(p => [p.email, p])).values()]
  return people.length ? people : null
}
// How the card names them: everyone the grant would cover, with their handle
// (two people can share a name). More than two: no grant offered ('').
export function grantLabel(people: Person[]): string {
  const one = (p: Person) => `${p.name} (@${userHandle(p.email)})`
  return people.length === 1 ? one(people[0]) : people.length === 2 ? `${one(people[0])} and ${one(people[1])}` : ''
}
// Whether everyone behind a turn has been allowed for this session.
export function coveredBy(granted: Person[] | undefined, people: Person[] | null | undefined): boolean {
  return !!people?.length && people.every(p => (granted ?? []).some(g => g.email === p.email))
}
// The grant after "Allow …": exactly the people named on that card.
export function withGrant(granted: Person[] | undefined, people: Person[]): Person[] {
  return [...new Map([...(granted ?? []), ...people].map(p => [p.email, p])).values()]
}
