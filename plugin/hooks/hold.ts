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
// own; create_room, add_members and propose_avatar act as the owner, so they
// are held like any other action.
export const ROOM_TOOLS = new Set(['reply', 'list_rooms', 'read_history', 'ask_owner', 'get_attachment'])

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
