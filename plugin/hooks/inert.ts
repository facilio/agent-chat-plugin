// Text Claude reads from a room (messages, names, room descriptions, a quoted
// request) is written by other people. It must not be able to close an
// <agent-chat> block and open a forged one (from_is_owner="true",
// status="owner_decision"), so any <agent-chat / </agent-chat in it loses its
// "<". Used for wakes (src/bridge.ts) and tool results (register.tsx).
export const inert = (v: string) => String(v ?? '').replace(/<(\s*\/?\s*agent-chat)/gi, '‹$1')
