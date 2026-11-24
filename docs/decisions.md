# Decisions

Newest first: what was decided, why, what was not done, who decided, and the
version. See `AGENTS.md` for when to add one. The log starts at 0.18.3; for
earlier choices, the commit messages (`git log`) are the record.

---

## 0.18.10 · Pictures pasted into Claude Code may be attached, after the owner sees them
- **Decided:**
  - A picture whose real path is under `~/.claude/uploads/` (where Claude Code
    keeps pictures pasted into it) is no longer refused. It always waits for
    the owner's card, even on a turn the owner alone started. The rest of
    `~/.claude` is still refused, including the attachments `get_attachment`
    saves.
  - Every held picture is uploaded before the card goes up, so the web card
    shows it. It sits in storage only, in no message. The server deletes it if
    the owner denies, the card is withdrawn, or the plugin gives up waiting.
    Allowed, the reply posts that same upload.
  - The terminal pane can't draw pictures; it names each file, its size and
    pixel size, and marks a pasted one.
  - This bends 0.18.9's "private places are refused" for that one folder.
- **Why:** the owner asked: "For photos ~/.claude/uploads/ ask for approval
  with preview in web ui. Maybe with path in Claude code pane". "Post the
  screenshot I just pasted" was refused, and a held picture's card didn't show
  the picture being approved.
- **Not done:** other folders under `~/.claude`. Deleting the pictures of a
  card nobody answers whose session never ends: storage expiry (30 days)
  takes them.
- **Needs:** a server whose `permission_request` takes `roomId` and `files`.
  An older one ignores them: the card shows no picture, and nothing is deleted
  on Deny.
- **Who:** Manthosh.

## 0.18.9 · Agents attach pictures to their replies
- **Decided:**
  - `reply` takes `files`: local paths of PNG, JPEG, GIF or WebP pictures, up
    to 5, 10 MB each.
  - The bridge resolves each path (symlinks followed), needs a regular file,
    decides the type from the bytes, never the name, and keeps the bytes it
    read under a one-use token. The upload sends those bytes, so a file
    swapped after the check isn't what goes out.
  - Refused outright: private places (the same list as the read checks), judged
    on the given path and on where it leads, and anything that isn't one of
    the four picture types.
  - Pictures go out unasked only when the reply text would: a turn the owner
    alone started, with nothing anyone else wrote read in, or a task the owner
    started. Every other turn holds the reply for the owner's card, which names
    each file's real path, size and pixel size. That includes turns where the
    text alone would post, because no check can read a picture.
- **Why:** asked for by the owner: agents make screenshots, charts and
  diagrams a room wants to see, and could only describe them. Before this,
  only people attached files.
- **Not done:**
  - Other file types (logs, PDFs, archives): the easy way to send a secret out.
  - Scanning pictures for private details.
  - Attachments in tasks: they can't call `reply` (0.18.8).
  - Showing attachments in the agent-chat-view transcript, which shows none
    today.
- **Needs:** a server with the `upload` action. On an older one the reply says
  so and posts nothing.
- **Who:** Manthosh.

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
