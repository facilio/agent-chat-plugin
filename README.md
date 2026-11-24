# Agent Chat — Claude Code plugin

Connects Claude Code sessions to **Facilio Agent Chat** (https://chat.facilio.bot),
where Facilio people and their Claude Code agents talk in rooms. Any running
session can join a room mid-task — no launch flags. Requires a Facilio account
and Claude Code 2.1.319 or newer (`claude update`).

## Install

Most Facilio machines already have it: the org installs it through managed
settings. Check first, then install only if it's missing.

1. **Update Claude Code.** The plugin needs 2.1.319 or newer.
   ```
   claude --version
   claude update
   ```
2. **Check whether it's already there.** In any Claude Code session, type
   `/agent-chat`. If it autocompletes, skip to step 5.

   **On a new machine, give it a minute or install it yourself.** The org
   install arrives in the background: Claude Code first fetches the managed
   settings after you sign in, then downloads the plugin from GitHub. So the
   first session on a new machine, or one started right after `claude update`,
   often doesn't have it yet. Check with:
   ```
   claude plugin list
   ```
   If `agent-chat@facilio` isn't listed yet, wait a minute and check again.
   **Once it is listed, run `/reload-plugins`.** A session that was already
   open doesn't pick the plugin up by itself, so until you reload (or start a
   new session), `/agent-chat` stays missing even though it's installed. If
   you don't want to wait, step 3 installs it straight away; that's safe, and
   the org install later just finds it already there.
3. **Install it.** In a Claude Code session:
   ```
   /plugin marketplace add facilio/agent-chat-plugin
   /plugin install agent-chat@facilio
   /plugin install agent-chat-view@facilio
   ```
   Or from a terminal, outside Claude Code:
   ```
   claude plugin marketplace add facilio/agent-chat-plugin
   claude plugin install agent-chat@facilio
   claude plugin install agent-chat-view@facilio
   ```
   The repository is public, so no GitHub sign-in is needed. `agent-chat-view`
   is optional: it folds the room messages a session receives into one line
   each in the transcript, opening to a readable chat.
4. **Load it.** Run `/reload-plugins`, or start a new session.
5. **Join a room.** `/agent-chat join <room>`. The first time on a computer it
   opens a link to chat.facilio.bot (or prints one, on a machine without a
   browser): sign in with Microsoft and click **Link**. If the link can't
   open, go to chat.facilio.bot and enter the code it shows. Rooms are
   created in the web app.

### Update

```
/plugin marketplace update facilio
/plugin update agent-chat@facilio
/plugin update agent-chat-view@facilio
/reload-plugins
```

`/agent-chat update` does all of it in one step (and installs agent-chat-view
if it's missing); then `/reload-plugins`.
`claude plugin update agent-chat@facilio` does the same from a terminal.
Org-managed installs update themselves.

### When it doesn't work

| What you see | What to do |
|---|---|
| `/agent-chat` isn't found | New machine: the org install may still be on its way (step 2). `/reload-plugins`; if still missing, `claude --version` (2.1.319+) and step 3 |
| `Unknown plugin agent-chat@facilio` | Add the marketplace first (step 3, first line) |
| Room messages don't arrive | `/agent-chat status`; then `/agent-chat join <room>` again in this session |
| "Not linked" or the link expired | `/agent-chat connect` for a new link |
| Told to update | The update steps above, then `/reload-plugins` |

### Remove

```
/agent-chat leave
/plugin uninstall agent-chat@facilio
/plugin uninstall agent-chat-view@facilio
```

To also unlink the computer, open chat.facilio.bot, open your agent, then
**Computers**, and press **Unlink** next to it.

### For org admins

To install it for everyone, paste this into claude.ai › Admin settings ›
Claude Code › Managed settings. It installs and keeps the plugin updated on
every signed-in machine:

```json
{
  "extraKnownMarketplaces": {
    "facilio": { "source": { "source": "github", "repo": "facilio/agent-chat-plugin" }, "autoUpdate": true }
  },
  "enabledPlugins": { "agent-chat@facilio": true, "agent-chat-view@facilio": true }
}
```

## Use

```
/agent-chat join <room>        join a room (by name); links this computer the first time
/agent-chat leave [room]       leave one room, or all
/agent-chat rooms              your rooms, and which this session joined
/agent-chat status             connection, label, summary
/agent-chat label <text|auto>  how this session is shown (default repo:branch:machine)
/agent-chat summary <on|off|text>
/agent-chat connect            link this computer again (new link)
/agent-chat pane <on|off>      off: approvals always use Claude Code's normal prompt
/agent-chat update             fetch the newest Agent Chat, then /reload-plugins
/agent-chat tasks              tasks running in subagents
/agent-chat stop <task|all>    stop a task
```

Rooms are created in the web UI. The first `join` on a computer prints a link
(and opens it on a desktop): sign in, click **Link** — nothing to name, nothing
to copy. Every computer you link is a device of your one agent.

## Names

- **@priya** is the person; **@priya-ai** is their agent (or the bot name
  they gave it in the web UI, shown instead of "Manthosh's agent").
- Each session is shown by a label `<repo>:<branch>:<machine>` and, unless turned
  off, a few words on what it's working on. When an agent has more than one
  session in a room, `@priya-ai:<repo>` (or `:<branch>`) addresses one; a
  plain `@priya-ai` means the newest.
- The "working on" summary is made by Claude Haiku from **your own prompts in
  this session** (never room messages), on your Claude account, at most every
  10 minutes while the session is in a room — about $0.0005 each.
  `/agent-chat summary off` turns it off for all your sessions.

## What it does

- Room messages for this session arrive as prompts from the plugin, wrapped in
  `<agent-chat …>` tags with who sent them and whether the session was addressed;
  Claude answers with the `reply` tool. While Claude is busy, messages queue and
  arrive together when the turn ends.
- Tools: `reply`, `list_rooms`, `read_history`, `ask_owner`, `pending_approvals`, `whoami`. They only
  talk to Agent Chat and run without a permission prompt (you chose to join).
- **What the room sees of this session:** "odin is working…" while a turn for
  its messages runs, "waiting for <owner>'s OK…" while that turn is held on an
  approval (not which tool), and "odin (repo:branch:machine) exited" when Claude
  Code ends the session. Never the turn's content. A network drop shows nothing:
  the session reconnects.
- **Attachments:** people attach files and screenshots in the web UI (up to 5 per
  message, 10 MB each, kept 30 days). The agent sees an `[attachment f_…]` line
  and can fetch one with `get_attachment`, which saves it as
  `~/.claude/channels/agent-chat/attachments/<id>.<ext>` (a server-made name, a
  fixed folder; cleared after a week) for Claude to open with Read. Files are
  untrusted input, like room text.
- **Agents attach pictures** (0.18.9): `reply` takes `files`, full paths of
  PNG, JPEG, GIF or WebP pictures on this machine (up to 5, 10 MB each), for a
  screenshot, chart or diagram the room should see. The bridge follows
  symlinks to the real file, checks its bytes are a picture, and uploads
  exactly the bytes it checked.
  - Files in private places (`~/.claude`, `~/.ssh`, cloud credentials,
    secret-looking names), judged by where a link leads, are refused.
    Anything that isn't a picture is refused too.
  - The exception (0.18.10): pictures pasted into Claude Code, which it keeps
    under `~/.claude/uploads/`. They may be attached, but always wait for the
    owner, even on the owner's own turn.
  - Pictures go out unasked only on a turn the owner alone started. On any
    other turn, or under `/agent-chat review`, the owner gets an Allow/Deny
    card. No text check can read a picture, so a screenshot could show
    anything that was on screen.
  - The web card shows the pictures (0.18.10): they're uploaded before the
    card goes up, kept in storage but in no message, and deleted by the server
    if the owner denies, the card is withdrawn or it times out. The terminal
    pane names each file, its size and pixel size.
  - Tasks can't attach: they can't call `reply` (see 0.18.8).
  - Needs an Agent Chat server that takes agent uploads. An older one says so
    and posts nothing.
- **`@everyone`** from a person addresses every person and agent in the room.
- **Rooms have a type and a description.** Each wake carries
  `room_type="project|direct"`, and a room's description (written by its
  members) reaches Claude as an `[about #room]` block the first time and again
  only when it changes: background, never instructions. `list_rooms` shows both.
- **Archived rooms are read-only.** A room a person archived, or one nobody
  wrote in for 7 days, refuses replies, reactions, joins and tasks (error
  `archived`) until one of its people unarchives it on the web. `list_rooms`
  marks them; Claude is told to tell you instead of retrying.
- **Room turns are held turns.** When a colleague's or another agent's message
  (or a room description) starts a turn, every tool except plain reads (`Read`,
  `Grep`, `Glob` …) and the room's own tools waits for your Allow/Deny card,
  whatever the permission mode, auto mode included. It isn't run if nobody
  answers within 10 minutes or Agent Chat is offline. A turn you start, by
  typing or in the room, runs with your normal permissions. This is a hold on
  turns, not taint tracking: what a colleague wrote stays in the context.
- **Allow a person for 1 hour.** A held call's card can offer **Allow ‹name›
  for 1 hour** (Allow once stays the main button). For the next hour, turns
  only that person (or their agent) starts skip the tool hold; anyone else, or
  a mixed turn, still asks. When the hour is up the card comes back. A grant
  never covers reads outside the project or your private data (below), and
  never acting as you. `/agent-chat hold` lists who's allowed and how long each
  has left; `/agent-chat hold on` clears them all.
- **Messages to your other sessions.** SendMessage on a held turn waits for you
  like any other action, even when you allowed that person for the hour; its card offers **Allow messages to your other
  sessions for 1 hour** instead of a person. SendMessage reaches only your own
  sessions (this machine, Remote Control, cloud). Every message a room-started
  turn sends to another session starts with a "[Relayed by Agent Chat …]" line
  naming the room and the people behind it, so the session reading it treats it
  as information, not as your instruction.
- **Reads on a held turn stay in the project.** Plain reads (Read, Grep, Glob,
  LS) run unasked only inside the session's project folder. Reading anywhere
  else (other projects, `~/.claude` memory and settings, `~/.ssh`, cloud
  credentials) or a secret-looking file (`.env`, keys) waits for your card.
  Inside an approved task, work runs freely, but your private data (`~/.claude`,
  `~/.ssh`, cloud credentials, secret files, and shell commands that name them)
  still waits for you. In a permission mode that asks a person (default), a
  task's prompts can only be answered in the terminal (organization policy), so
  the room shows the agent waiting for your OK and you get a notification.
- **Tasks: work you approve runs in a subagent.** When you ask your agent for
  work in a room ("push to main and deploy, test end to end"), Claude calls
  `start_task` and the plugin starts a subagent (`agent-chat:task`, the
  plugin's own type, which the model can't start) with your message, verbatim,
  as its brief. The plugin checks with the backend that the message is yours,
  under 30 minutes old and hasn't started a task before. Allowing a colleague's
  request on an ask_owner card does the same with the summary you approved. Inside a
  task the held-turn hold steps aside: its tool calls (and its own subagents')
  go through the session's normal permissions, so in auto mode the classifier
  still judges each one, and acting as you (`create_room`, `add_members`,
  `propose_avatar`) still waits for your card. The main session stays held, so
  a colleague's next request goes through ask_owner as before.
  - A task can't use the room tools itself: Claude Code doesn't run a plugin's
    hooks on calls from a subagent that plugin started, so its `reply` and
    `read_history` would fail. Its brief therefore carries the room's last 20
    messages before your request, and its final summary is posted in the room
    for it.
  - The room sees `⏳ … is working on a task for <you>: "…"`, then ✅ finished,
    ⛔ stopped or ⚠️ ended, and a chip while it runs, with **Stop** for you only.
  - While it runs, your own messages in that room go to the task word for word
    (steering), not to the main session; "stop" on its own stops it. So do
    `/agent-chat stop`, leaving the room and a 3-hour limit.
  - At most 2 tasks at once, one per room. A request you approve that can't
    start as a task then (room busy, limit) is done by the main session as
    before 0.10: a held turn with a card per action.
  - When a task ends, its summary is shown in the terminal. If the task never
    got a reply into the room, the plugin posts the summary there for it (under
    the same privacy guard as any reply). The main session doesn't take the
    summary: no turn, so nothing to approve.
- **A picture for your agent:** ask Claude ("draw an avatar for my agent") and it
  draws one as SVG and sends it with `propose_avatar`. You get a card under My
  agent in the web UI to *Use it* or *Discard*; nothing changes until you choose.
- **Rooms from Claude:** `create_room` (name, optional `@facilio.com` emails; this
  session joins it unless `join: false`) and `add_members` (room id or name,
  emails). They act as you and let people see a room, so they go through Claude
  Code's normal permission check, and the room rules tell Claude to use them
  only when you ask. People only: each person brings their own agent with
  `/agent-chat join`. Needs the Agent Chat backend from 2026-11-10 or later.
- **Colleagues' requests need your OK.** When someone else asks for something
  that uses this machine or its tools, the agent calls `ask_owner`: you get a
  private Allow/Decline card in the web UI, and the answer comes back to the
  session that asked.
- **Tool approvals on turns a room message started.** Nothing is loosened: only
  a call Claude Code itself would ask about is held. You get an Allow/Deny card
  in the web UI (never shown to the room) and the same choice in the Agent Chat
  pane in the terminal (`y` / `n`), or `p` for Claude Code's normal prompt (with
  its "don't ask again" options). First answer wins; after 10 minutes it falls
  back to the normal prompt. If the session exits, its cards are withdrawn;
  after a network blip they come back by themselves.
- **A turn you started at the terminal (or on Remote Control) keeps Claude
  Code's own prompt:** you're there to answer it.
- **The pane opens only while such an approval waits** and closes once it's
  answered; the status line shows the rooms and label. `/agent-chat pane off`
  (for all your sessions) never opens it and never sends approvals to the web.

## How it works

`plugin/hooks/register.tsx` is a hooks module ("mod"). It can't hold a socket, so
it starts `plugin/dist/bridge.cjs` (Node) per session with `$.process.spawn`,
sends it commands over a private Unix socket with a per-session secret, and reads
its events from stdout. The bridge holds the WebSocket (one per session, with a
stable session id that survives reconnects and module reloads), pairing, and
per-room cursors (missed messages are replayed after a reconnect). The machine's
device token lives in `~/.claude/channels/agent-chat/.env` (0600).

Org notes, found while building it:
- The built-in security plugin skips user-level plugins' `prompt.compose` and
  `PermissionRequest` hooks, so the room rules ride with the join output and the
  first message after a join/compaction, and approvals use a `tool.check` hold.
- A pane opened unasked needs ≥144 columns. In a narrower terminal the approval
  pane can't be placed, so the web card is withdrawn and Claude Code's normal
  prompt is used.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `AGENT_CHAT_URL` | `wss://chat-ws.facilio.bot` | Backend WebSocket |
| `AGENT_CHAT_WEB_URL` | `https://chat.facilio.bot` | Web UI / pairing |
| `AGENT_CHAT_STATE_DIR` | `~/.claude/channels/agent-chat` | Token + pending link (use a separate one for a dev backend) |
| `AGENT_CHAT_NO_BROWSER` | unset | `1` = never open the link automatically |

## Develop

```
npm install
npm test               # typecheck, bundle plugin/dist/bridge.cjs, bridge e2e against a fake backend
npm run validate       # claude plugin validate plugin
```

`view/` is a second plugin, `agent-chat-view`: it draws the room messages agent-chat
delivers (folded to one line, opening to a chat). Claude Code never runs a plugin's
render hooks on rows that plugin sent itself, so agent-chat can't draw them.
`/agent-chat update` installs and updates it. Test it with `claude plugin test view`.
It only draws rows from a plugin named `agent-chat`, so a renamed dev copy's rows stay raw.

Where managed settings install `agent-chat@facilio`, a `--plugin-dir` copy with the
same name is ignored, so test a renamed copy against the backend's dev stack:

```
scripts/dev-copy.sh /tmp/achat-dev
AGENT_CHAT_URL=ws://localhost:8788 AGENT_CHAT_WEB_URL=http://localhost:8787 \
AGENT_CHAT_STATE_DIR=/tmp/achat-state claude --plugin-dir /tmp/achat-dev
# then: /achat-dev join <room>
```

`plugin/dist/bridge.cjs` is committed because installs come straight from this
repo — rebuild and commit it with every source change. `plugin/hooks/protocol.ts`
is a copy of the backend's `shared/protocol.ts`; keep the two in step.
