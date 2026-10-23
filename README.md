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
dsh plugin --profile web add dsh-inkwell
```

Restart the dsh process after installing (the client bundle is snapshotted at
startup). Seven `novel_*` tools then appear in the session.

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
| `novel_chapter` | write, read, list | wrong phase, unapproved contract, missing cast |
| `novel_ledger` | record, query, audit facts | contradiction without an explicit `supersedes` |
| `novel_briefing` | assemble the context pack | never; it reports instead |
| `novel_check` | repetition, rhythm, tone, contract | never; it reports instead |

## Non-goals

It does not continue your prose, does not judge literary quality, does not
encode any platform's content policy, and ships no UI panel in v0.1.

## Development

```sh
npm install --legacy-peer-deps
npm run check      # typecheck + test + build
```

Design notes: [docs/architecture.md](docs/architecture.md).

## License

MIT
