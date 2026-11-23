# Decisions

Newest first: what was decided, why, what was not done, who decided, and the
version. See `AGENTS.md` for when to add one. The log starts at 0.18.3; for
earlier choices, the commit messages (`git log`) are the record.

---

## 0.18.8 · Tasks get the room's recent messages; they don't call room tools
- **Decided:** a task's brief carries the last 20 messages in the room before
  the request (quoted as context, not instructions), and the task is told not
  to call this plugin's tools. Its final summary is what the plugin posts in
  the room, now without the "Result of the task (it posted none itself)" line.
- **Why:** Claude Code leaves a plugin's hooks out of events the plugin itself
  caused (its re-entry rule), and a task's subagent is started by this plugin,
  so the task's calls to `reply` and `read_history` never reach the plugin and
  fail with "no tool.call hook answered this call". Tasks asked to "check the
  above things" couldn't see what "above" was.
- **Not done:** making the room tools work inside tasks. Nothing in the plugin
  API lets a plugin's own subagent reach its hooks.
- **Open:** the same rule likely means the plugin's other `tool.call` checks
  inside a task (the owner's private data still waiting for them, the stop and
  time-limit refusals) don't run either; the session's normal permissions
  still apply. To confirm with `claude --debug` on a task.
- **Who:** Manthosh.

## 0.18.7 · The agent can see what's waiting for its owner
- **Decided:** a `pending_approvals` tool lists what waits for the owner's OK
  from any of the agent's sessions: held tool calls (the card's one-line
  description, the session, time left) and colleagues' requests passed on with
  `ask_owner`. Read-only: nothing in it can answer one. The rules tell the
  agent to use it when the owner asks what's pending. On a turn a room message
  started it says only how many, since the details are another session's work.
  It never gets a tool's input. Needs the server's `approvals` action.
- **Why:** the owner asked a session what was waiting and it couldn't tell,
  while a card from another of his sessions was about to expire.
- **Not done:** letting the agent answer an approval; they exist to need the
  owner.
- **Who:** Manthosh.

## 0.18.6 / view 0.3.1 · People's messages read WhatsApp-style marks
- **Decided:** in a person's message, `*x*` is bold and `~x~` struck (WhatsApp),
  and `**x**` / `~~x~~` still work. Agents' messages stay Markdown (`*x*` is
  italic). This applies to the terminal pane (`paneMarkdown.ts`) and to the
  transcript view, which hands the person's text to Claude Code's Markdown as
  `**x**` / `~~x~~`. The web page does the same, so all three agree.
- **Why:** people write the way WhatsApp taught them; agents write Markdown.
  One reading for both turned a person's bold into italic.
- **Not done:** changing what the model receives. It gets the raw text and
  reads `*bold*` fine.
- **Who:** Manthosh.

## 0.18.5 · Room replies answer within 25 s
- **Decided:** the bridge's `POST /send` and `POST /join` share one 25 s
  deadline across their steps (wait to be online, the request, then look for
  the post in history). If the module still gives up, the reply tool says the
  message may have been posted and to check `read_history` first.
- **Why:** Claude Code's fetch gives the module 30 s per bridge call; a send
  during a reconnect could take about 55 s, so the module gave up while the
  post might still go through, which invited posting it twice.
- **Not done:** raising the module's limit; the fetch has no per-call timeout.
- **Who:** Manthosh.

## 0.18.4 · Read positions survive a resume
- **Decided:** the kept copy of a session (restored after a resume or a plugin
  update) saves room cursors as they move, at most once a second, and the
  session label too.
- **Why:** the kept cursors were saved only on a join, so a resumed session
  said hello from its last join and was sent everything since again, as new
  turns.
- **Who:** Manthosh, from a report in a room.

## 0.18.3 · Archived rooms are read-only
- **Decided:** `list_rooms` marks archived rooms. When a post fails with
  `archived`, Claude tells its owner in the terminal instead of retrying.
  Only a person can unarchive a room, on the web.
- **Why:** the server archives rooms after 7 quiet days or when a person
  archives one, and then refuses posts, reactions and joins.
- **Who:** Manthosh.

## Decisions and plans are kept in the repo
- **Decided:** the rules in `AGENTS.md`; `CLAUDE.md` imports them.
- **Why:** several people and their agents work here, often from rooms, and the
  reasons for changes were lost with the conversation.
- **Who:** Manthosh.
