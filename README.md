# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/icapt/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/icapt/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is a small command-line tool that applies one patch to a tree of text files. It reads unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and JSON text-editor calls; finds each edit's lines at the first of three matching tiers — exact, trailing-whitespace-insensitive, then indentation-insensitive — and changes every file or none.

## Run it

```sh
node main.ts fix.patch
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=jtabzsjz&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
