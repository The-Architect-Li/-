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

Three specs work today:

| spec | notes |
| --- | --- |
| `dsh-inkwell` | from the npm registry, once published |
| `E:\path\to\checkout` | a local checkout; an absolute path is required |
| `git+https://github.com/The-Architect-Li/-.git` | builds on install, see below |

Git installs build through the package's `prepare` script, and pnpm blocks build
scripts by default. The first `add` fails with the exact key it wants; paste that
key into the profile's `pnpm-workspace.yaml` and run it again:

```yaml
allowBuilds:
  dsh-inkwell@https://codeload.github.com/The-Architect-Li/-/tar.gz/<commit>: true
```

Without that, the install lands a shell with no `lib/`. The Desktop app owns its
own profile - `dsh plugin --profile desktop` is refused by design - so install
there from the app's plugin page instead; it accepts the same specs.

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

v0.5 turns it into a drawer tree, and gives it the one write it needs: creating a
book without going back to the conversation.

```text
📕 雾港  长篇
◎ World          7
◍ Cast          12
    Overview
    Protagonist   1
    Supporting    3
    Minor         8
◷ Plot         223
    Story line    [story line]
    Beats        128
    Foreshadows  2
    Chapter cards 94
✎ Manuscript    94
    Volume I      94 chapters
        Ch.1 The Crack   [done]      3200 words
        Ch.2 Golden Boy  [done]      2950 words
        Ch.3 Tide        [ready]
```

- **Four drawers** — world, cast, plot, manuscript — each with a count, a caret,
  a selection state; cast groups by structural role, plot splits into story line
  / beats / foreshadows / chapter cards, manuscript hangs chapters under their
  volume and marks each `done` / `N drafts` / `ready` / `unwritten`. Long lists
  cap at 25 rows plus "and N more", so a 300-chapter book is not a wall.
- **It can create a book.** "New" opens the host's own directory chooser
  (`ctx.uiWorkspace.pickDirectory()`), or you can walk the in-panel browser level
  by level — including other drives on Windows. Creation goes through the same
  `ProjectStore.init` as `novel_project action="init"`, so both doors produce the
  same bytes on disk.
- **It refuses to guess.** A directory that already holds a book answers "《…》 is
  already here" with an *Open it* button instead of overwriting; a relative path
  is a 400 rather than something resolved against the host's cwd.
- **No tokens.** The snapshot is computed by `src/panel/model.ts` from disk.
- **Per session.** With `perWorkspace` on, the panel resolves the book from the
  session's `cwd`, so switching sessions switches books.
- **Optional.** The route mounts through `ctx.inject(['webServer'])`; a headless
  profile has no web server and still gets all nine tools.

Five host routes, polled every 5 seconds by the browser half:

```text
GET  /api/inkwell                        # the process-wide book
GET  /api/inkwell?session=<id>            # the book in that session's workspace
GET  /api/inkwell/snapshot?root=<abs>     # a named book
GET  /api/inkwell/dirs?path=<abs>         # one directory level, plus "is a book here?"
POST /api/inkwell/init                    # { dir, title?, targetWords? }
GET  /api/inkwell/roles                   # four agents, their routes, and what the host offers
POST /api/inkwell/roles                   # { role, provider?, model?, reasoningEffort?, maxTokens?, reset? }
```

The three reads answer 405 to anything but GET. The two writes require
`x-dsh-plugin: inkwell`, a header a cross-site simple form post cannot set.
Advancing a phase, editing a contract and writing prose still go through the
tools, so the gate stays the only writer.

### Settings → the agent team (v0.6)

A full-width `⚙ Settings` row sits at the bottom of the drawer tree (v0.6.1 moved it out of the
book header, where a lone gear was too easy to miss). The first door is the agent team: one
card per role, saying what that agent only does, which route it currently runs
on, and which layer that route came from.

```text
◍ Agent team
  commander    [session]    the model you are talking to; not configurable here
  writer       [this book]  deepseek-official/deepseek-flash          restore
      provider [deepseek-official ▾]  model [deepseek-flash ▾]  effort [default (medium) ▾]
  logic        [global]     zai/glm-4
  character    [inherit]    inherits the session model
  chief        [inherit]    inherits the session model
```

- **Your catalog, not ours.** Provider and model lists come from the host's `llm`
  service (`listProviders` / `listModels` / `resolveModelInfo`), cached 60
  seconds. A provider whose metadata will not answer just loses its effort
  picker; it never holds the page.
- **Effort follows the model.** Only the efforts that model's adapter advertises
  are offered, with its `defaultEffort` shown as the default choice.
- **Same storage as the tool.** The panel writes `roles` in `project.json`, so
  `novel_roles action="list"` sees it and the next `novel_dispatch` runs on it;
  *restore* drops the book's override and falls back to the global layer.
- **Three layers, named.** *this book* > *global* (the plugin's `roles` config) >
  *inherit* (the parent session's model). The panel only edits the first.

## Non-goals

It does not generate prose itself, does not judge literary quality, and does not
encode any platform's content policy. The panel opens exactly two write doors —
creating a book and picking an agent's model, both equivalent to a tool call —
while phase transitions, contracts and prose still go through the tools and their
gate.

## Development

```sh
npm install --legacy-peer-deps
npm run check      # typecheck + test + build + packaging smoke test
npm run verify     # mount the built lib/ with a fake context, check all 9 tools register
```

Design notes: [docs/architecture.md](docs/architecture.md).

## License

MIT
