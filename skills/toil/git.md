---
area: git
description: Local git status, diff, log, branches and a commit report for the repository in the workspace
---

# Local git (`git`)

Status, diff, recent commits, branches and a commits-and-lines report for the git
repository the workspace is in. Every command reads; none changes anything.
Verification level: `unit`.

**Supported versions:** The oldest git version toil supports hasn't been established. toil
runs the git already on PATH and needs git 2.24 or later for its argument
safeguards; an older one gets `GIT_NOT_FOUND`. Output parsing was checked against
git 2.49.

## Credential and configuration

None. There is no server, no connection to add, no `TOIL_GIT_*` variable and no
`--connection` flag. The repository is the one the workspace (`--workspace`, else
`TOIL_WORKSPACE`, else the working directory, else the MCP client's single root)
sits in; outside one, every command fails with `Not a git repository` (or `GIT_NOT_FOUND`, when there is no git either).

These are the only commands that need git installed. toil finds it on PATH itself,
skipping relative entries and the working directory, and runs it with no shell,
no pager, no prompts and none of your environment's tokens. It also turns off what
a repository's config could make git run: external diff drivers, textconv filters,
the fsmonitor hook and signature checks. Without git on PATH they fail with
`GIT_NOT_FOUND`, naming the PATH searched; nothing else in toil is affected.

`toil git current-pr` is an alias of `toil bitbucket pr current`, which asks
Bitbucket for the open pull request from the current branch (see `bitbucket.md`).

## Commands

### `toil git status`

`git status --porcelain`, as `{ staged, unstaged, untracked }`: lists of paths
relative to the repository root. A file with staged and unstaged changes is in
both. A rename reads `old -> new`, and a path git quotes stays quoted. MCP tool:
`git_status`.

### `toil git diff`

The uncommitted changes, parsed. MCP tool: `git_diff`.

```bash
toil git diff
toil git diff --staged --path src/retry.ts
```

| Flag | Meaning |
|------|---------|
| `--staged` | The index against HEAD, instead of the working tree against the index |
| `--path <path>` | One file, relative to the repository root |

Output: `{ files: [{ path, binary, truncated, hunks: [{ oldStart, oldCount,
newStart, newCount, lines }] }], truncated }`. Parsing stops after 5,000 lines of
git's output, with `truncated: true`. A git that fails, or a diff over 1 MB, gives
`{ files: [], truncated: false }`.

### `toil git log`

Recent commits, newest first: `[{ hash, author, date, message }]`, `date` being
the author date in ISO 8601 and `message` the subject line. MCP tool: `git_log`.

| Flag | Meaning |
|------|---------|
| `--count <n>` | How many (default 10). `0`, or anything that isn't a number, means no limit |
| `--since <date>` | Anything git accepts: `2 weeks ago`, `2026-01-31` |

A git that fails (a `--since` it can't read, an empty repository) gives `[]`.

### `toil git branch`

`git branch -a`, as `{ current, local, remote }`, remote names without their
`remotes/` prefix (`origin/main`). Lines are kept as git prints them, so a branch
checked out in another worktree reads `+ name`, a detached HEAD is `current` as
`(HEAD detached at …)`, and `origin/HEAD -> origin/main` is a remote. MCP tool:
`git_branch`.

### `toil git report`

Commits, lines and files changed on a branch, from `git log --numstat`. MCP tool:
`git_report`.

```bash
toil git report --since 2026-09-01
toil git report --base main --branch feature/retries --csv --out report.csv
```

| Flag | Meaning |
|------|---------|
| `--branch <name>` | The branch (default: the current one) |
| `--base <ref>` | Report `base..branch`, or `base..HEAD` without `--branch` |
| `--since <date>` | On or after this date: `YYYY-MM-DD` or anything git accepts |
| `--until <date>` | Before this date. A plain `YYYY-MM-DD` is the start of that day in UTC, so that day itself is left out |
| `--csv` | Also write one row per week and author, then a `TOTAL` row, as CSV. Needs `--out` |
| `--out <file>` | The CSV file, a new one inside the workspace; toil never overwrites. Needs `--csv` |

Output: `{ branch, since, until, commits: [{ hash, date, author, message,
filesChanged, insertions, deletions, netLines }], weeks: [{ week, weekStart,
weekEnd, authors, summary }], byAuthor, summary: { commitCount, totalInsertions,
totalDeletions, totalNetLines, totalFilesChanged } }`, plus `file` (the CSV's
absolute path) with `--csv`. Weeks run Monday to Sunday in UTC and are labelled by
ISO week (`2026-W40`). Absolute dates are applied again to each commit's author
date, since git's own range walks by committer date. A binary file counts 0 lines.
The CSV header is
`week,week_start,author,commits,insertions,deletions,net_lines,files_changed`.

A misspelt branch or base, or a date git can't read, gives an empty report.
