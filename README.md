# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/lalangweb3/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/lalangweb3/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies AI-written edits in four formats — unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches and JSON text-editor tool calls — to a tree of text files, to one written specification (SPEC.md). It finds the lines an edit names at the first of three matching tiers, even when the model drifted their whitespace or indentation, and changes every file or none.

## Run it

```sh
node main.ts [options] [PATCH]
```

## What it does

`mend` reads a patch from a file (or standard input when PATCH is `-` or absent) and applies it to the current directory's files. The format is detected from the patch itself — unified diff, SEARCH/REPLACE, V4A (`*** Begin Patch`), or JSON (an array of tool calls, or one JSON object per line) — or forced with `--format`. `--strict` requires exact matches only; `--check` reports what would change without writing anything. Every edit in a patch applies, or none of them do: a failure leaves the tree untouched.

Options and exit codes, the matching tiers, and the exact output rows are specified in [`SPEC.md`](SPEC.md). The entrypoint is [`main.ts`](main.ts) (Node 22, standard library only); [`runner.ts`](runner.ts) is the kit's harness, kept as shipped.

## Local checks

```sh
node check.ts <practice.json>   # kit's practice set: 100 of 100 passed (score 1000)
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=2pjpz4b5&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
