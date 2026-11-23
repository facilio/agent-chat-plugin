# Decisions

Newest first: what was decided, why, what was not done, who decided, and the
version. See `AGENTS.md` for when to add one. The log starts at 0.18.3; for
earlier choices, the commit messages (`git log`) are the record.

---

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
