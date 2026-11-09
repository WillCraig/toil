---
area: github
description: Pull requests, reviews, comments, checks, labels, assignees, issues and projects on GitHub and GitHub Enterprise Server
---

# GitHub and GitHub Enterprise Server (`github`)

Pull requests, reviews, comments, checks, labels, assignees, issues and Projects on
**GitHub.com** and **GitHub Enterprise Server**, through the REST API and, for
review threads, PR status, auto-merge, the merge queue, drafts and Projects, the
GraphQL API. The two differ only in host, so they're one area with a configurable
`baseUrl`. Verification level: `unit`.

**Supported versions:** The oldest GitHub Enterprise Server version toil supports hasn't been established. toil pins
REST API version 2022-11-28 and uses GraphQL for review threads, PR status, auto-merge,
the merge queue, drafts and Projects. GitHub.com is always current; no Enterprise Server
release has been verified yet. The auto-merge and merge-queue commands need a release
that has those features, and so do issue types, sub-issues and Projects (v2). A release
without issue types just leaves `type` off each issue; one without sub-issues
(`issue get --sub-issues`) or Projects (`project …`) gets `UNSUPPORTED`, saying so.

## Credential

A **personal access token**, either kind. A **classic token** (`ghp_…`) is the common one: Settings →
Developer settings → Personal access tokens → Tokens (classic), with the scopes below. A
**fine-grained token** (`github_pat_…`) is limited to the repositories you pick: Settings →
Developer settings → Personal access tokens → Fine-grained tokens, with the permissions below,
read or write as needed. toil tells them apart by the token and treats them alike: it sends either as
`Authorization: Bearer <token>`, with `Accept: application/vnd.github+json` and
`X-GitHub-Api-Version: 2022-11-28`. There is no OAuth app, username, password or
browser login.

What each group of commands needs from the token:

| Commands | Fine-grained token | Classic token |
|----------|--------------------|---------------|
| `issue list`, `issue search`, `issue get`, `issue history` | Issues: read, on the repository | `repo` (`public_repo` for public repositories only) |
| `repo file` | Contents: read, on the repository | `repo` (`public_repo` for public repositories only) |
| `project list`, `project fields`, `project items` | Projects: read, under the organization's permissions. A fine-grained token can't read a user's own projects | `read:project` (plus `repo` to see items from private repositories) |
| `project status` | Projects: read and write, under the organization's permissions (organization projects only) | `project` (plus `repo` to reach an item in a private repository) |
| Pull request, review, comment and check commands | Pull requests, contents and checks, read or write as needed | `repo` |

A token without the Projects permission gets `AUTH` from the `project` commands,
naming the scope.

### Scopes, for read-only use and for everything

`toil connections scopes --area github` prints exactly what each kind needs, with the
commands that need each scope (the same list Toil UI shows, with a link to make the token).
In short:

| | Read-only use needs | Everything toil can do needs |
|---|---|---|
| Classic token | `repo`, `read:project` | the same, plus `project` for `project status`: GitHub has no read-only `repo`, so toil's write gate (`writes` on the connection plus `--allow-write`) is what keeps it read-only |
| Fine-grained token | Metadata, Pull requests, Contents, Issues, Checks and Commit statuses, each Read, and Projects (organization) Read | Pull requests, Contents and Issues at Read and write, Projects (organization) at Read and write for `project status`, and Administration for `repo create` |

A `ghp_`-style classic token and a `github_pat_` fine-grained one are both sent as
`Authorization: Bearer <token>`; toil never reads a token's scopes, so a missing one is
GitHub's refusal, reported as `AUTH`.

## Configuration

| Key | Env var | Required | Meaning |
|-----|---------|----------|---------|
| `baseUrl` | `TOIL_GITHUB_BASE_URL`, then `GITHUB_API_URL` | yes | The REST API root: `https://api.github.com`, or `https://ghe.imagile.dev/api/v3` for Enterprise Server. Toil UI asks it as a choice between GitHub.com and Enterprise Server |
| `token` | `TOIL_GITHUB_TOKEN`, then `GITHUB_TOKEN` | yes | Personal access token, classic (`ghp_…`) or fine-grained (`github_pat_…`) |
| `owner` | `TOIL_GITHUB_OWNER` | no | Default owner (user or org) |
| `repo` | `TOIL_GITHUB_REPO` | no | Default repository name |
| `targetBranch` | `TOIL_GITHUB_TARGET_BRANCH` | no | Default base branch for `pr create` (`main` when unset) |
| `writes` | `TOIL_GITHUB_WRITES` | no | `true` lets write commands run (with `--allow-write`) |

**CI fallbacks:** in GitHub Actions, the default connection takes its token from
`GITHUB_TOKEN` when `TOIL_GITHUB_TOKEN` isn't set, and its base URL from
`GITHUB_API_URL` when `TOIL_GITHUB_BASE_URL` isn't set. Each sits directly below its
`TOIL_GITHUB_*` variable and above the config file.

The GraphQL endpoint is derived from `baseUrl`: a trailing `/v3` is dropped and
`/graphql` appended, so `https://api.github.com` uses `https://api.github.com/graphql`
and `https://ghe.imagile.dev/api/v3` uses `https://ghe.imagile.dev/api/graphql`.

Environment variables (CI, or a one-off shell):

```bash
export TOIL_GITHUB_BASE_URL=https://ghe.imagile.dev/api/v3
export TOIL_GITHUB_TOKEN=<your personal access token>
```

Or `~/.toil/config.json`, with `owner`, `repo` and `targetBranch` usually set once
under `defaults.github`:

```json
{
  "version": 2,
  "connections": {
    "corp-github": { "area": "github", "baseUrl": "https://ghe.imagile.dev/api/v3" }
  },
  "defaults": { "github": { "connection": "corp-github", "owner": "imagile", "repo": "toil-probe" } }
}
```

The token never goes in this file; a plaintext one there is refused with
`CONFIG_INVALID`. Run `toil connections add corp-github --area github` (or
`toil connections login corp-github` for an existing connection) to keep it in the OS
credential store, or set `TOIL_GITHUB_TOKEN`.

## Owner and repository

Every command except `repo create` needs an owner and a repository, which come
from, in order:

1. `--owner` and `--repo`, before or after the command (`toil github --owner imagile
   --repo toil-probe pr get 7`); on `pr create` the ones after the command win
2. the first of the working folder's remotes whose host is this connection's host,
   of any name, trying `origin` first (so a fork's `upstream` counts)
   (`api.github.com` counts as `github.com`). `git@host:o/r`, `ssh://git@host[:port]/o/r`
   and `https://host[:port]/o/r` remotes are read, each with or without `.git`; an
   HTTPS remote with a user name in it isn't
3. the connection's `owner` and `repo` (usually `defaults.github`)

With neither found, the command fails with "Could not determine GitHub owner/repo".
`pr resolve` needs them too, though it acts by thread id alone. `repo create`
reads only an explicit `--owner`, always as an organization (`POST /orgs/<owner>/repos`);
without it the repository is created under the token's user.

## Commands

Every command is `toil github <resource> <action> [ids...]`, and its MCP tool is the
path with underscores (`github_pr_get`, `github_commit_checks`). Numbers (`<number>`,
`<comment-id>`, `--line`) are read as whole numbers from the start of the text, so
`12abc` is 12. Write commands need `writes` on the connection and `--allow-write`. The
deletes (`pr delete-comment`, `pr delete-review-comment`, `issue unlabel`,
`pr remove-reviewers`, `issue unassign`) run on the CLI only and are never MCP tools.
Owner, repo, labels and refs go into request paths as typed; a value that would make a
`.` or `..` path segment is refused with `INVALID_INPUT`.

- **Repositories:** `repo create` (`--name`, `--description`, `--private`,
  `--auto-init`), and `repo file <path>` (`--ref`), one file through the contents
  API: GitHub's record plus `text`, the file decoded as UTF-8 (null, with a
  `GITHUB_FILE_NOT_INLINED` warning, over 1 MB). A folder is refused.
- **Issues:** each issue is GitHub's own, with the issue type in `type`, sub-issue
  counts in `sub_issues_summary` and the parent in `parent_issue_url`, where the server
  has them.
  - `issue create` (`--title`, `--body` or `--body-file <path>` with `-` for stdin,
    repeatable `--label` and `--assignee`).
  - `issue list` (`--state open|closed|all`, default `open`; repeatable `--label`, all
    of which must match; `--assignee`, `--type` with `none` or `*` too; `--sort
    created|updated|comments`, `--direction asc|desc`; `--updated-since <iso>`,
    GitHub's `since`). The issues endpoint mixes pull requests in; toil leaves them out
    (`pr list` has them).
  - `issue search --query <q>` (GitHub search syntax; `--sort`, `--order`,
    `--updated-since`). toil adds `is:issue`, and `updated:>=<iso>` with
    `--updated-since`, but not `--owner` or `--repo`: scope the query with `repo:`,
    `org:` or `user:`. GitHub serves only the first 1,000 results of a search, so past
    that toil stops with a `GITHUB_SEARCH_CAPPED` warning; a search GitHub timed out
    part of gets `GITHUB_SEARCH_INCOMPLETE`.
  - `issue get <number...>`, up to 100 numbers. One number returns the issue
    itself. Several return `{ issues, errors }`, read four at a time, where an issue
    GitHub can't find or answers with an error goes into `errors` as `{ number, code,
    message }`, with a `GITHUB_ISSUES_FAILED` warning; a bad token or a timeout still
    fails the call. `--sub-issues` adds `sub_issues`, each issue's sub-issues, one more
    request per issue.
  - `issue history <number>`: the issue's timeline, oldest first, as GitHub returns
    it: `closed` and `reopened` (with `state_reason`), `labeled`, `assigned`,
    `issue_type_added` and `issue_type_changed`, `sub_issue_added`,
    `cross-referenced` (the PRs that mention it), `commented` and the rest.
  - `--updated-since` reads a date the way `--created-after` does (a date alone is UTC
    midnight) and sends it as UTC to the second, `2025-01-31T00:00:00Z`.
  - Labels and assignees, on an issue or a pull request by its number: `issue label
    <number>` (repeatable `--label`), `issue unlabel <number> --label`, `issue assign
    <number>` and `issue unassign <number>` (repeatable `--assignee`). `pr label`,
    `pr unlabel`, `pr assign` and `pr unassign` are the same commands.
- **Projects (v2):** GitHub's boards, over GraphQL (read, except `project status`). They belong to an owner, so
  only `--owner` is read; `<project>` is the number in the project's URL.
  - `project list`: the owner's projects (`id`, `number`, `title`, `url`, `closed`, …).
  - `project fields <project>`: each field's `id`, `name` and `dataType`, a
    single-select field's `options` (Status), and an iteration field's
    `configuration` with its `iterations` and `completedIterations`.
  - `project items <project>`: each item's `id`, `type` (`ISSUE`,
    `PULL_REQUEST`, `DRAFT_ISSUE`), `content` (number, title, state, url and
    repository) and `fieldValues`, each with its `field.name` and value (`text`,
    `number`, `date`, a single-select `name`, or an iteration's `title` and
    `startDate`). An item's first 100 values are read, with a
    `GITHUB_PROJECT_VALUES_TRUNCATED` warning past that.
  - `project status <project> <number> --to <status>` (a write): sets the Status of an
    issue or pull request on the project, by the option's name, case-insensitive
    (`--to "in progress"`). `--owner` owns the project and `--repo` holds the issue.
    `--item <id>` (the item `id` from `project items`) names the item instead of
    `<project> <number>`, and needs neither. An unknown status is `INVALID_INPUT` listing the
    project's own options; an issue that is not on the project is `NOT_FOUND`, and toil never
    adds it. It reads the item and the project's Status field, then sends one
    `updateProjectV2ItemFieldValue`, unless the item already holds that status. `data` is
    `{ item, project: { number, title, owner }, field, from, to, changed }`. It needs
    `writes` on the connection and `--allow-write`, and is served over MCP (it deletes nothing).
- **Pull requests** (`<number>` is the pull request number): `pr list` (`--state
  open|closed|all`, default `open`; `--head user:branch`, `--base`; `--author` and
  `--created-after`/`--created-before`, ISO 8601, are filtered as each page comes in,
  the author case-insensitively; a date alone is UTC midnight, a date-time with no zone
  local time; `--updated-since <iso>` keeps pull requests updated at or after it, and
  asks GitHub for the most recently updated first, `sort=updated&direction=desc`, so
  reading stops after the page that reaches an older one), `pr get <number>`
  (`--include reviews,checks,commits,files`, any of them, adds `included`, an object
  holding only the lists asked for, each GitHub's own records with every page read:
  `reviews`, `checks` (the check runs on the head commit, `head.sha`), `commits` and
  `files`; each list is one more request, more to page; GitHub serves at most 250
  commits and 3000 files of a pull request, and a list that long gets a
  `GITHUB_LIST_CAPPED` warning; an unknown name is `INVALID_INPUT`), `pr create`
  (`--title`, `--head`, `--base`
  defaulting to `targetBranch` then `main`, `--body`/`--body-file`, `--draft`),
  `pr update <number>` (`--title`, `--body`, `--base`), `pr merge <number>` (`--method
  merge|squash|rebase`, default `merge`, always sent; `--commit-title`,
  `--commit-message`), `pr close <number>`, `pr reopen <number>`, `pr draft <number>`,
  `pr ready <number>`.
- **Merging:** `pr enable-auto-merge <number>` and `pr enqueue <number>` (`--method`,
  `--match-head-commit <sha>`), `pr disable-auto-merge <number>`.
- **Comments:** `pr comments <number>` and `pr comment <number> --body` (the general
  comments, which work on an issue's number too; `issue comments` and `issue comment`
  are the same commands), `pr review-comments <number>`,
  `pr comment-inline <number>` (`--commit`, `--file`, `--line`, `--body`, `--side
  LEFT|RIGHT`, default `RIGHT`), `pr reply <number> <comment-id> --body`,
  `pr delete-comment <comment-id>`, `pr delete-review-comment <comment-id>`.
- **Diff and files:** `pr diff <number>` returns `{ diff }`, the unified diff as text;
  `pr files <number>`.
- **Reviews:** `pr reviews <number>`, `pr approve <number>` (`--body` optional),
  `pr request-changes <number>` (`--body` required), `pr reviewers <number>`,
  `pr threads <number>` (thread ids for `pr resolve`; the first 100 threads with a
  `GITHUB_REVIEW_THREADS_TRUNCATED` warning past that, and the first 10 comments of
  each), `pr resolve <thread-id>`, `pr add-reviewers <number>` and
  `pr remove-reviewers <number>` (repeatable `--reviewer` and `--team-reviewer`, at
  least one).
- **Status:** `commit status <ref>` (the combined status; GitHub's first 30 statuses),
  `commit checks <ref>`, `pr status <number>` (review decision, mergeability, draft
  and auto-merge state, and the first 100 checks counted into `checks.passed`,
  `failed`, `pending` and `other`).

Lists page 100 at a time until a short page, and stop with an error after 1,000 pages.
Every list (`pr list`, `pr files`, `pr comments`, `pr review-comments`, `pr reviews`,
`commit checks`, `issue list`, `issue search`, `issue history` and the three `project`
lists) reads every page by default. `--limit <n>` stops after `n` items and sets
`meta.page.nextCursor`; pass it back as `--cursor` with the same `--limit` for the next
`n`, until `nextCursor` is `null`. On `pr list`, `--limit` counts the pull requests that
pass `--author` and the date filters, `--updated-since` included.

```bash
toil github issue list --state all --sort updated --direction asc --updated-since 2025-01-31T00:00:00Z --limit 100
toil github issue get 9 10 --sub-issues
toil github --owner imagile project items 3
toil github --owner imagile --repo toil-probe project status 3 9 --to "In Progress" --allow-write
toil github project status --item PVTI_abc12345 --to Done --allow-write
toil github pr list --state all --author octo-dev
toil github pr list --state all --updated-since 2025-01-31T00:00:00Z --limit 50
toil github pr get 7 --include reviews,checks
toil github repo file .github/CODEOWNERS
toil github --owner imagile --repo toil-probe pr status 7
toil github pr create --title "Add the probe" --head feature --body-file pr.md --allow-write
```

## Ticket the work

Before starting work no ticket covers, rank your open issues against it:

```bash
toil github issue search --query "repo:imagile/payments-web is:open assignee:@me" | toil util owi map | toil util owi similar --query "Card payments time out at checkout"
```

Then ask the person, as `core.md`, **Ticket the work**, says: attach the work to a
match (nothing is written), create a sub-task under it, or create a new ticket. toil
has no sub-issue command, so a sub-task is a new issue that names its parent in the
body (`Part of #12`); a new ticket is
`toil github issue create --title "<text>" --allow-write`, in the repository the
toil project names. Both are writes, made only on the person's yes.

## Checking a toil project

`check-toil-project` checks the call's toil project: each owner it names (`owner`, per repo or not, and `owners`) is a user or organization, and each repository (`repo`) exists under its owner. It's `toil github check-toil-project` (`--toil-project <name|file>`, or the toil project the folder resolves to), and it returns `{ toil project, connection, env, ok, checked, checks, unchecked }`, one check per value with its key path. The CLI exits 1 when one is missing. A failure other than not-found (a bad token, an unreachable host) fails the command. Read only.
