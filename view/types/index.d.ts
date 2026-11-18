// What agent-chat-view keeps in $.state: the room-message rows the person opened.
export type AgentChatViewOpened = string[]
declare module 'claude-code' {
  interface PluginState {
    'agent-chat-view': { opened: Shaped<AgentChatViewOpened> }
  }
}
