#!/usr/bin/env bash
# A renamed copy of the plugin for local testing. Where managed settings
# install agent-chat@facilio, a --plugin-dir copy named "agent-chat" is
# ignored (and names starting "agent-chat" are refused for tools), so the copy
# is "achat-dev" with the command /achat-dev.
#   scripts/dev-copy.sh /tmp/achat-dev      (also writes /tmp/achat-dev-view)
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
# The companion that folds its room messages (view/), renamed to match: it
# draws only the rows its sender plugin submits.
view="$out-view"
rm -rf "$view" && cp -R "$here/view" "$view"
sed -i.bak 's/"name": "agent-chat-view"/"name": "achat-dev-view"/' "$view/.claude-plugin/plugin.json"
sed -i.bak "s/^const SENDER_PLUGIN = 'agent-chat'/const SENDER_PLUGIN = 'achat-dev'/; s/atom({ plugin: 'agent-chat-view', key:/atom({ plugin: 'achat-dev-view', key:/g" "$view/hooks/register.tsx"
sed -i.bak "s/'agent-chat-view': { opened/'achat-dev-view': { opened/" "$view/types/index.d.ts"
find "$view" -name '*.bak' -delete
echo "$view"
