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
| `novel_project` | init, status, premise, advance; books, open, close to switch books | premise too short, cast incomplete, no such book to open |
| `novel_canon` | character cards, world entries | missing name or detail |
| `novel_outline` | volumes, chapter contracts, approval | fewer than 2 beats, unknown character |
| `novel_chapter` | write, propose, commit, restore, read, list, review | wrong phase, unapproved contract, missing cast, stale revision, waive without a reason |
| `novel_ledger` | record, query, audit facts | contradiction without an explicit `supersedes` |
| `novel_briefing` | assemble the context pack | never; it reports instead |
| `novel_check` | repetition, rhythm, tone, contract | never; it reports instead |
| `novel_roles` | inspect or set each role's model route and effort | set without a role |
| `novel_dispatch` | spawn a role subagent (writer/logic/character/chief) | wrong phase, unapproved contract, no draft for a reviewer |
| `novel_export` | whole book as txt, per-volume markdown, or the canon sheet | nothing written yet |

### Review notes, versions, switching books, export (v0.10)

- **Review notes persist.** Every reviewer round lands in `<project>/reviews/<n>.json`: who said
  it, on which model, against which draft round, and an id per note. Answer them one by one with
  `novel_chapter action="review" number=1 id="001-r1-1" state="fixed" note="…"`; a `waived` note
  must carry the reason. Without an id the same action prints the board.
- **Chapters are versioned.** Each save bumps `revision`. `write` and `restore` want the revision
  you read; a stale one is refused with both numbers. `force=true` overwrites on purpose. The
  panel sends the revision it opened, so a second editor gets a 409 instead of losing their words.
- **Books switch inside a conversation.** `novel_project action="books"` lists them,
  `action="open" root="…"` (or `book="雾港"`) pins this session to one, `action="close"` returns.
  The pin lives in `<DSH_HOME>/inkwell/sessions.json`, so it survives turn by turn.
- **Books leave the room.** `novel_export action="text" | "markdown" | "canon"` writes into
  `<project>/exports/` by default; `out` takes any absolute path.

## The workshop panel

As of v0.4 the web shell's right Sidebar carries a **小说工坊** tab
(`ctx.sidebarRightTabs.register`) — not a second right column, because there is
only one and taking it over would push the Sidebar out.

v0.5 turns it into a drawer tree, and gives it the one write it needs: creating a
book without going back to the conversation. v0.7 folds every drawer on open and
makes each row open its own page. v0.8 makes those pages editable — and gives the
chapter page a preview/edit split. v0.9 puts a shelf in front of it: 小说工坊 is
the workbench, and a book is something you pick inside it.

```text
▤ 小说工坊                        ＋ New   Refresh
2 books here
▤ 雾港            drafting · 3 ch · 6,380 words    [here]
  E:\dshplugin\.novel
▤ 旧稿            premise · 0 ch · 0 words
  D:\ novels\旧稿\.novel
⚙ Settings                              Agent team
```

Pick one and you get that book's tree:

```text
←  ▤ 雾港  drafting
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

- **A shelf first** (v0.9): the panel opens on books, not on drawers. Every row
  carries title, phase, chapter count, word count and its directory; `here` marks
  the book this session resolves to, `last` the one this browser opened. `←`
  returns to the shelf from anywhere in a book.
- **Where the list comes from** (v0.9): three sets, unioned — a `?root=` the
  browser pinned, the book the session resolves for itself, and the shelf of roots
  this machine has opened (`$DSH_HOME/inkwell/books.json`, paths and timestamps
  only, newest 40). All three are checked against the disk, so a deleted or moved
  book simply is not listed: the shelf is a hint, not a claim.
- **Four drawers** — world, cast, plot, manuscript — each with a count, a caret,
  a selection state; cast groups by structural role, plot splits into story line
  / beats / foreshadows / chapter cards, manuscript hangs chapters under their
  volume and marks each `done` / `N drafts` / `ready` / `unwritten`. Long lists
  cap at 25 rows plus "and N more", so a 300-chapter book is not a wall.
- **Folded on open** (v0.7): the panel lands as a table of contents, not as
  ninety-four chapter rows; collapse state is kept for the panel's session.
- **A row opens its page** (v0.7): click 沈砚 and the whole sidebar becomes his
  card — voice, appearance, goal, secret, the chapters he appears in, the facts
  the ledger holds about him. Group rows (Protagonist, Volume I) expand instead.
- **And that page is editable** (v0.8): edit on a character or world page types
  into the same files; a chapter page previews the prose paragraph by paragraph
  and switches to a text box with a live word count (the same whitespace-stripped
  count the store records). Saves go through `POST /entry`, so saying "change
  Shen Yan's goal" in the conversation and typing it in the panel write to one
  place, not two.
- **When it cannot save, it says why** (v0.8): an unapproved chapter shows the
  gate's sentence on the page before you reach for the button; a body that drops
  a required character comes back 409 with the missing names.
- **It creates a book in one click** (v0.11). "New" raises the host's own
  directory chooser (`ctx.uiWorkspace.pickDirectory()`); a small card then asks
  for the title (defaulted from the folder name) and an optional word target.
  Creation goes through the same `ProjectStore.init` as
  `novel_project action="init"`, so both doors produce the same bytes on disk.
- **And it moves you there** (v0.11). After creating, the panel registers the
  folder as a workspace (`workspaces.create({ path })`, idempotent), asks for its
  session (`connectWorkspace`), pins that session to the book
  (`POST /api/inkwell/pin`), and navigates to it (`openSession`). You end up in a
  fresh conversation under that folder, with the workspace in the sidebar; that
  workspace sees this book, other folders see theirs.
- **It refuses to guess.** A directory that already holds a book answers "《…》 is
  already here" with an *Open it* button instead of overwriting; a relative path
  is a 400 rather than something resolved against the host's cwd.
- **No tokens.** The snapshot is `src/panel/model.ts`, the pages are
  `src/panel/entry.ts`, the shelf rows are `src/panel/shelf.ts`; all three are
  computed from disk.
- **Per session.** With `perWorkspace` on (the default since v0.11), the panel
  resolves the book from the session's pin, else its `cwd`, so switching sessions
  switches books.
- **Optional.** The route mounts through `ctx.inject(['webServer'])`; a headless
  profile has no web server and still gets all ten tools.

The host routes, polled by the browser half:

```text
GET  /api/inkwell                        # the process-wide book
GET  /api/inkwell?session=<id>            # the book that session is pinned to (else its cwd)
GET  /api/inkwell/snapshot?root=<abs>     # a named book
GET  /api/inkwell/books                   # the shelf: books this machine has opened
GET  /api/inkwell/dirs?path=<abs>         # one directory level, plus "is a book here?"
POST /api/inkwell/init                    # { dir, title?, targetWords? }
POST /api/inkwell/pin                     # { session, root } pin one session to one book
GET  /api/inkwell/entry?kind=&key=        # the page behind a row: character / world / chapter
POST /api/inkwell/entry                   # { kind, key, fields } edit that character, place or body
GET  /api/inkwell/roles                   # four agents, their routes, and what the host offers
POST /api/inkwell/roles                   # { role, provider?, model?, reasoningEffort?, maxTokens?, reset? }
```

The reads answer 405 to anything but GET. There are four writes — create a book,
pin a session to it, pick an agent's model, edit one existing row — and each
requires `x-dsh-plugin: inkwell`, a header a cross-site simple form post cannot
set. Advancing a phase, approving an outline, committing a chapter and recording a
ledger fact still go through the tools, so the gate stays the only writer of the
things that need an argument. The shelf cannot delete, rename or move a book:
that is the file manager's job, not a sidebar's. `/entry` answers 404 for a row
the book no longer has — a browser holding a stale tree should be told to refresh
rather than shown a blank card.

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
encode any platform's content policy. The panel opens exactly three write doors —
creating a book, picking an agent's model, and editing a row that already exists
(all equivalent to a tool call, and the third one through the very same
`saveChapterBody` the writer tool uses) — while phase transitions, outline
approval, committing and ledger facts still go through the tools and their gate.
The shelf lists books; it never deletes, renames or moves one.

## Development

```sh
npm install        # the declared devDependencies resolve without flags
npm run check      # typecheck + test + build + packaging smoke test
npm run verify     # mount the built lib/ with a fake context, check all 10 tools register
```

Design notes: [docs/architecture.md](docs/architecture.md).

## License

MIT
