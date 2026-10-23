# dsh-inkwell

> A deterministic constraint kernel for long-form fiction on DeepSeek Harness.
> [中文说明](README.zh.md)

Long-form fiction fails in ways a model cannot see in its own output: canon
drifts, the same paragraph reappears three chapters later, every character
talks with the same rhythm, and the outline silently stops matching the prose.

dsh-inkwell does not write. It governs the hand that writes — phase gates, a
fact ledger, chapter contracts, repetition and stock-phrase scans, and a
budgeted context pack. Everything is a pure function over text on disk, so it
costs no tokens and returns the same answer twice.

## Principle

**Code enforcement over prompt discipline.** Every rule that depends on the
model's self-restraint eventually fails at 300,000 characters. So each rule here
lives somewhere that can refuse:

- wrong phase → `tools/pre-execute` denies before the tool body runs;
- unapproved chapter contract → the draft is not accepted;
- a contracted character missing from the prose → **the chapter is not saved**;
- a fact contradicting the ledger → **the entry is not written**, unless it
  names the entry it replaces.

## Install

```sh
dsh plugin --profile <your-profile> add dsh-inkwell
```

Restart the dsh process after installing (plugins are mounted at startup). Nine
`novel_*` tools then appear in the session.

Installing from git works too, but pnpm blocks build scripts until you allow
them; whitelist the package in the profile's `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  dsh-inkwell: true
```

Without that, the install lands a shell with no `lib/`.

The **commander pipeline** is the default shape: the main session talks to you,
dispatches a writer subagent, runs logic and character reviewers plus a chief
adjudicator, and only commits a chapter when you nod.

## One book per workspace

A dsh process usually serves several workspaces at once, so the project root is
resolved against **the calling session's own working directory**, not the
process's:

- a relative `root` (the default `.novel`) resolves under each session's
  workspace — two windows, two books, no shared canon;
- an absolute `root` pins one book for every session;
- `perWorkspace: false` restores the v0.2 behaviour of one book at the process
  directory.

A refusal names the directory it looked in, so "no project" is never mysterious.

Each role can also pin a model and a `reasoningEffort`:

```text
novel_roles action="set" role="writer" provider="zai" model="glm-4.6" reasoningEffort="high"
novel_roles action="set" role="logic"  reasoningEffort="low"    # change one field, keep the rest
novel_roles action="set" role="writer" reasoningEffort=""       # empty = explicitly unset in this book
```

That last line is the three-state override: omitted inherits, a value pins,
empty means "this book wants nothing here" and stops the global default from
filling it back in. Keys stay in DSH settings — the plugin only stores provider
and model names.

## Workflow

```text
premise ──→ canon ──→ outline ──→ drafting ──→ review ──→ done
```

Each transition is gated by data, and a refusal names exactly what is missing.

## Tools

| Tool | Purpose | Refuses when |
|---|---|---|
| `novel_project` | init, status, premise, advance | premise too short, cast incomplete |
| `novel_canon` | character cards, world entries | missing name or detail |
| `novel_outline` | volumes, chapter contracts, approval | fewer than 2 beats, unknown character |
| `novel_chapter` | write, propose, commit, read, list | wrong phase, unapproved contract, missing cast |
| `novel_ledger` | record, query, audit facts | contradiction without an explicit `supersedes` |
| `novel_briefing` | assemble the context pack | never; it reports instead |
| `novel_check` | repetition, rhythm, tone, contract | never; it reports instead |
| `novel_roles` | inspect or set each role's model route and effort | set without a role |
| `novel_dispatch` | spawn a role subagent (writer/logic/character/chief) | wrong phase, unapproved contract, no draft for a reviewer |

## The workshop panel

As of v0.4 the web shell's right Sidebar carries a **小说工坊** tab
(`ctx.sidebarRightTabs.register`) — not a second right column, because there is
only one and taking it over would push the Sidebar out.

It does one thing: project the book on disk into a dashboard you can read at a
glance — phase, what blocks the next transition, word progress against the
target, the chapter table with draft rounds, the busiest characters, and the
threads still owed a payoff.

- **Read-only.** No button on the panel advances a phase or edits a contract;
  that still goes through the tools, so the gate stays the only writer.
- **No tokens.** The snapshot is computed by `src/panel/model.ts` from disk.
- **Per session.** With `perWorkspace` on, the panel resolves the book from the
  session's `cwd`, so switching sessions switches books.
- **Optional.** The route mounts through `ctx.inject(['webServer'])`; a headless
  profile has no web server and still gets all nine tools.

One host route, polled every 5 seconds by the browser half:

```text
GET /api/inkwell                 # the process-wide book
GET /api/inkwell?session=<id>    # the book in that session's workspace
```

Anything but GET answers 403/405 — a read-only panel needs no write surface.

## Non-goals

It does not generate prose itself, does not judge literary quality, and does not
encode any platform's content policy. The panel is a dashboard, not a second
entry point: it holds no write operations.

## Development

```sh
npm install --legacy-peer-deps
npm run check      # typecheck + test + build + packaging smoke test
npm run verify     # mount the built lib/ with a fake context, check all 9 tools register
```

Design notes: [docs/architecture.md](docs/architecture.md).

## License

MIT
