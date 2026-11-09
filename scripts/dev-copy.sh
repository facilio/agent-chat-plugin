#!/usr/bin/env bash
# A renamed copy of the plugin for local testing. Where managed settings
# install agent-chat@facilio, a --plugin-dir copy named "agent-chat" is
# ignored (and names starting "agent-chat" are refused for tools), so the copy
# is "achat-dev" with the command /achat-dev.
#   scripts/dev-copy.sh /tmp/achat-dev
#   AGENT_CHAT_URL=ws://localhost:8788 AGENT_CHAT_WEB_URL=http://localhost:8787 \
#   AGENT_CHAT_STATE_DIR=/tmp/achat-state claude --plugin-dir /tmp/achat-dev
set -euo pipefail
out="${1:?usage: dev-copy.sh <dir>}"
here="$(cd "$(dirname "$0")/.." && pwd)"
rm -rf "$out" && cp -R "$here/plugin" "$out"
sed -i.bak 's/"name": "agent-chat"/"name": "achat-dev"/' "$out/.claude-plugin/plugin.json"
sed -i.bak "s/^const NAME = 'agent-chat'/const NAME = 'achat-dev'/; s/atom({ plugin: 'agent-chat', key:/atom({ plugin: 'achat-dev', key:/g" "$out/hooks/register.tsx"
sed -i.bak "s/'agent-chat': { chat/'achat-dev': { chat/" "$out/types/index.d.ts"
find "$out" -name '*.bak' -delete
echo "$out"
