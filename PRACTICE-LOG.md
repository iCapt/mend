# Practice log

How the entry did against the kit's 100 practice checks
(unified 30, search_replace 20, v4a 20, json 15, cli 15), and what
changed between runs. Run with the starter's `check.ts` beside
`main.ts` and `runner.ts`.

## Run 1 — 65 of 100 (score 650)

Failures fell into five groups, all in my code, not in the checks:

- Unified paths kept their `a/` / `b/` prefixes, so every edit
  looked for a file like `b/quota.js` that does not exist. This
  alone failed most unified checks, plus both `c-strict` checks.
- Context lines were written from the patch instead of from the
  file, so trailing spaces from the patch leaked into the output
  (v-update-anchor, v-add-delete, v-move, v-update-plain, v-cursor,
  and the trailing-whitespace unified checks).
- V4A Add File lines kept their leading `+`, so added files were
  written with `+` at the start of every line.
- A SEARCH/REPLACE block with empty old lines (a creation) checked
  for the file's existence the wrong way round and reported
  `missing` instead of creating it.
- The tier-2 re-indent rule was my own guess: it re-indented new
  lines from the old line they followed instead of replacing the
  leading whitespace of O's first line with that of the file's
  first matched line.

## Fixes

- Strip a leading `a/` / `b/` from unified `---` / `+++` paths,
  cut paths at the first tab, treat `/dev/null` as no file, and
  use the `diff --git` paths when nothing else names one (a
  malformed `diff --git` line is now a parse error).
- Context lines are written as the file's own matched line, never
  the patch's. Tier-2 re-indent now follows the spec exactly: a
  non-context line that starts with P (the leading whitespace of
  O's first line) has that P replaced by F (the leading whitespace
  of the file's first matched line).
- V4A Add File lines drop their `+`; any other non-blank line in
  an Add section is a parse error. A body line starts a chunk only
  for the first chunk; later chunks need an `@@` line. A Move to
  now checks that the new path does not exist yet.
- SEARCH/REPLACE creation checks `exists` first, and a block with
  no path line takes the previous block's path.
- A unified creation is now just the `+` lines of all its hunks,
  ending with a line break unless a `\` line follows its last `+`
  line; a unified move now checks that the new path does not exist.

## Run 2 — 100 of 100 (score 1000)

Re-ran the full 100 checks after the fixes: all passed, in every
group. Ran the full set a second time to check it was stable:
again 100 of 100.

## House baseline, for comparison

The house enters a strict applier (exact matching only, tier 0).
Measured by forcing strict matching in a throwaway copy of
`main.ts` and running the same 100 checks: 73 of 100 (score 730).
This entry scores 1000, 270 points above the house.
