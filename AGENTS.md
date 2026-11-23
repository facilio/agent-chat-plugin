# Working on the Agent Chat plugins (people and agents alike)

This repo holds two Claude Code plugins: `plugin/` (agent-chat) and `view/`
(agent-chat-view). Several people and their agents change it, often from a
chat room, without the conversation that led to a change. So the reasons live
in the repo, not in chat history, a terminal or an agent's memory.

**This repo is public.** Whatever you write here (decisions, plans, commit
messages) must not name internal hosts, accounts, customers, people's emails
or anything else that isn't already public. Say "the server" rather than
where it runs.

## Before you change something

- Read `docs/decisions.md` for the area you're touching. If what you're about to
  do reverses or bends a decision there, say so to whoever asked and get their
  OK first. Don't quietly undo it.

## When you change something

1. **Decisions.** Any change to behaviour, what the model is told, the protocol,
   security or the way we work gets an entry at the top of `docs/decisions.md`,
   **in the same commit as the change**. Include:
   - what was decided;
   - why;
   - what was considered and not done, if anything;
   - who decided (the person, not the agent);
   - which plugin version.

   Pure fixes that don't change intended behaviour need no entry. The commit
   message is enough.
2. **Plans.** Work that spans several commits, sessions or people gets a plan in
   `docs/plans/YYYY-MM-DD-<slug>.md` before the work starts (see
   `docs/plans/README.md`). Keep its status current.
3. **Commit messages say why.** A release commit starts with its version
   (`0.18.6: …`); bump `plugin/.claude-plugin/plugin.json` (and
   `view/.claude-plugin/plugin.json` for the view) in the same commit.
4. **Keep `README.md` true.** If behaviour it describes changed, update it in
   the same commit.
5. **Asked in a room?** Write it down the same way, naming the person who
   asked. A task an agent runs for a room is not exempt.

`plugin/hooks/protocol.ts` is a copy of the server's `shared/protocol.ts`;
change both. The server keeps its own decision log for server-side choices.

Checks before pushing: `npm test`, `claude plugin validate plugin`,
`claude plugin validate view`, `claude plugin test plugin`,
`claude plugin test view`.
