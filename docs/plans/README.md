# Plans

One file per piece of work that spans several commits, sessions or people:
`YYYY-MM-DD-<slug>.md`. Write it before the work starts, so anyone picking the
work up (a colleague, or an agent in another session) knows what is meant to
happen and why.

```markdown
# <What we're doing>

Status: proposed | in progress | done | dropped   (keep this line current)
Owner: <person>        Asked in: <room / message, if any>

## Why
## Plan
- [ ] steps, ticked as they land (with commit ids)
## Open questions
## Outcome
What shipped, or why it was dropped; link the docs/decisions.md entry.
```

Don't delete finished plans; mark them done or dropped. They are the record of
how we got here.
