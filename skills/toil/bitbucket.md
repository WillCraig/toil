---
area: bitbucket
description: Repositories, branches, tags, commits, files, pull requests, comments, reviewers, build statuses and Pipelines on Bitbucket Data Center and Bitbucket Cloud
---

# Bitbucket (`bitbucket`)

Repositories, branches and tags, commits, files, pull requests, comments, reviewers,
build statuses and Pipelines on **Bitbucket Data Center / Server** (REST API 1.0:
`/rest/api/1.0`, plus `/rest/build-status/1.0` and `/rest/default-reviewers/1.0`) and
**Bitbucket Cloud** (`https://api.bitbucket.org/2.0`, REST API 2.0). One command tree and
one set of MCP tools serve both; each call goes to the deployment of the connection it
resolves. Verification level: `unit` for both. Data Center's behavior is the one the
command contract records; Cloud was built from Atlassian's API documentation and has
never run against a live workspace.

**Supported versions:** The oldest Bitbucket Data Center version toil supports hasn't been established. toil
calls REST API 1.0 (`/rest/api/1.0`, `/rest/build-status/1.0` and `/rest/default-reviewers/1.0`) with an HTTP access token
sent as a Bearer header. No release has been verified yet. Bitbucket Cloud (a connection with
`deployment` cloud) is always current: toil calls REST API 2.0 (`https://api.bitbucket.org/2.0`)
with an Atlassian API token sent as Basic auth with the account email, or a workspace,
project or repository access token sent as Bearer. Nothing has been run against a live
workspace yet.

## Data Center and Cloud

A connection says which one it is with `deployment`: `server` for Data Center (the
default) or `cloud`. The two keep separate API code and each returns **its own API's
shape**, unchanged; `meta.context.connection.deployment` says which one ran. What differs:

| | Data Center | Cloud |
|---|---|---|
| Credential | HTTP access token (`pat`), `Authorization: Bearer` | `email` + `apiToken` (Basic auth), or an `accessToken` (Bearer) |
| Where a call acts | `--project <key>` and `--repo <slug>` | `--ws <slug>` (a workspace) and `--repo <slug>` |
| People | usernames (`--reviewers jdoe,asmith`) | **account ids** (`--reviewers 557058:abc12345-…`) or `{uuid}`s |
| Paging | `nextPageStart` | `next` links |
| `pr diff` | `<id>` required; `data.diff` is Bitbucket's JSON diff structure as a string | `[id]` or `--spec`; `data.diff` is unified diff text |
| Pull request version | locks writes to the version it read | none |
| Only here | `check-toil-project`, `pr create-many`, `pr add-reviewer` | `repo list`, `repo get`, `branch`, `tag`, `commit list`, `commit get`, `file`, `pipeline`, `api` |

A call the connection's deployment can't serve fails **before any request** with
`UNSUPPORTED`, saying which deployment and what to do: `bitbucket pipeline list` or `--ws` on
a Data Center connection, `bitbucket pr create-many` or `--project` on a Cloud one. The error
names the connections you have that can run it.

`--project` and `--ws` are different ideas, so both stay and each is refused on the other
deployment: a Data Center project is the container of repositories, a Cloud workspace is the
account that owns them, and Cloud has projects too, inside a workspace. The one place a
Cloud call takes `--project` is `repo create`, to put the new repository in a project of the
workspace. `--reviewers` is one flag whose value is a username on Data Center and an account
id on Cloud. `pr needs-work` is one command: Cloud calls it requesting changes, and
`pr request-changes` is the same command on either deployment.

## Credential

**Data Center:** a Bitbucket **HTTP access token**: in Bitbucket, your profile picture →
Manage account → HTTP access tokens → Create token. Give it repository write (or admin, for
`repo create`) permission if you'll use the write commands. toil sends it as
`Authorization: Bearer <token>`. There is no username, password or browser login.

**Cloud:** one of two, each generated once in Atlassian's UI. A connection holds exactly one;
setting both is refused with `CONFIG_INVALID`.

- **An Atlassian API token with Bitbucket scopes**, plus that account's **email
  address**. Create it at https://id.atlassian.com/manage-profile/security/api-tokens
  → Create API token with scopes → Bitbucket. toil sends
  `Authorization: Basic base64(<email>:<apiToken>)`, as Atlassian documents. The
  token acts as you. Scopes:
  - reads: `read:repository:bitbucket`, `read:pullrequest:bitbucket` and
    `read:pipeline:bitbucket`, plus `read:user:bitbucket` for `toil connections test`
  - writes: `write:pullrequest:bitbucket` (pull requests and comments),
    `write:repository:bitbucket` (`branch create`, `tag create`) and
    `admin:repository:bitbucket` (`repo create`)
- **A workspace, project or repository access token**, from Repository settings,
  Project settings or Workspace settings → Access tokens. toil sends
  `Authorization: Bearer <accessToken>`. The token acts as itself, named after the
  token, on only what it was made for. Scopes: `repository`, `pullrequest` and
  `pipeline` to read; `pullrequest:write` and `repository:write` to write.
  `toil connections test` checks it against the connection's `workspace` and `repo`,
  and can't check one with neither.

**App passwords no longer work** on Cloud and toil doesn't take them. A `401`, `403` or `410`
from Bitbucket Cloud is `AUTH`, and its fix names the credential to create and the
scopes it needs. There is no OAuth app, Connect app or browser login.

## Configuration

| Key | Env var | Required | Meaning |
|-----|---------|----------|---------|
| `baseUrl` | `TOIL_BITBUCKET_BASE_URL` | yes | Data Center: the server root, e.g. `https://bitbucket.imagile.dev` (keep any context path). Cloud: the REST API root, `https://api.bitbucket.org/2.0` |
| `deployment` | `TOIL_BITBUCKET_DEPLOYMENT` | no | `server` (Data Center, the default) or `cloud` |
| `pat` | `TOIL_BITBUCKET_PAT` | Data Center | HTTP access token (a secret) |
| `email` | `TOIL_BITBUCKET_EMAIL` | Cloud, with `apiToken` | Email address of the Atlassian account the API token belongs to |
| `apiToken` | `TOIL_BITBUCKET_API_TOKEN` | Cloud, one of the two | Atlassian API token with Bitbucket scopes (a secret) |
| `accessToken` | `TOIL_BITBUCKET_ACCESS_TOKEN` | Cloud, one of the two | Workspace, project or repository access token (a secret) |
| `project` | `TOIL_BITBUCKET_PROJECT` | no | Default project key, when `--project` isn't given (on Cloud, only `repo create` reads it) |
| `workspace` | `TOIL_BITBUCKET_WORKSPACE` | no | Cloud: default workspace slug, when `--ws` isn't given |
| `repo` | `TOIL_BITBUCKET_REPO` | no | Default repository slug, when `--repo` isn't given |
| `targetBranch` | `TOIL_BITBUCKET_TARGET_BRANCH` | no | Data Center: default target branch for `pr create` (`main` when unset) |
| `writes` | `TOIL_BITBUCKET_WRITES` | no | `true` lets write commands run (with `--allow-write`) |

**CI fallback:** in Bitbucket Pipelines, a Cloud default connection takes `workspace` from
`BITBUCKET_WORKSPACE` and `repo` from `BITBUCKET_REPO_SLUG`, which Pipelines sets on
every step, when `TOIL_BITBUCKET_WORKSPACE` and `TOIL_BITBUCKET_REPO` aren't set. A Data Center
default ignores both. Pipelines sets no API credential, so the token is still yours to supply as a
secured variable.

Environment variables (CI, or a one-off shell):

```bash
# Data Center
export TOIL_BITBUCKET_BASE_URL=https://bitbucket.imagile.dev
export TOIL_BITBUCKET_PAT=<your HTTP access token>

# Cloud
export TOIL_BITBUCKET_DEPLOYMENT=cloud
export TOIL_BITBUCKET_BASE_URL=https://api.bitbucket.org/2.0
export TOIL_BITBUCKET_EMAIL=you@example.com
export TOIL_BITBUCKET_API_TOKEN=<your API token>
# or, instead of the email and API token:
export TOIL_BITBUCKET_ACCESS_TOKEN=<your access token>
```

The Cloud variables were `TOIL_BITBUCKET_CLOUD_*` before config version 3; those are
refused now, with the name to use instead (see **Moving from `bitbucket-cloud`**).

Or `~/.toil/config.json`. `defaults.bitbucket` reaches every Bitbucket connection, Cloud ones
too, so a Data Center `project`, `repo` and `targetBranch` go on the Data Center connection:

```json
{
  "version": 3,
  "connections": {
    "corp-bitbucket": { "area": "bitbucket", "baseUrl": "https://bitbucket.imagile.dev", "project": "PROJ", "repo": "imagile-api", "targetBranch": "develop", "writes": true },
    "imagile-bbc": { "area": "bitbucket", "deployment": "cloud", "baseUrl": "https://api.bitbucket.org/2.0", "email": "you@example.com", "writes": true }
  },
  "defaults": { "bitbucket": { "connection": "corp-bitbucket" } }
}
```

No token ever goes in this file; a plaintext one there is refused with
`CONFIG_INVALID`. Run `toil connections add corp-bitbucket --area bitbucket` (or
`toil connections login corp-bitbucket` for an existing connection) to keep it in the
OS credential store, or set the env var. Env vars always win over the file. Another Bitbucket
is another connection, chosen per call with `--connection imagile-bbc`, or configured from env
with `TOIL_CONN_IMAGILE_BBC_AREA=bitbucket`, `TOIL_CONN_IMAGILE_BBC_DEPLOYMENT=cloud` plus
`TOIL_CONN_IMAGILE_BBC_BASE_URL` and its credential. A `defaults.bitbucket` setting reaches the
connections of both deployments, so a default that only one deployment reads
(`targetBranch`, `workspace`) belongs on that deployment's connection.

## Where a command acts

**Data Center:** `--project <key>` and `--repo <slug>` are group flags, accepted before or
after the command (`toil bitbucket --project PROJ pr list`, or
`toil bitbucket pr create --project ~jdoe --repo scratch ...` for a personal
repository). Without them, toil reads them from the first of the workspace's remotes
on the connection's host, of any name, trying `origin` first (`git@<host>:PROJ/repo.git` or
`https://<host>/scm/PROJ/repo.git`; `ssh://` URLs and HTTPS with a user name aren't
recognised), so a fork whose Bitbucket remote is `upstream` works too, then the connection's
`project` and `repo` settings. `repo create` and `pr create-many` need
only a project; every other command needs both, and fails with "Could not determine
Bitbucket project/repo" when either is missing. `meta.context` says where each came
from.

**Cloud:** every command takes `--ws <slug>` and `--repo <slug>`, before or after the command
name: `toil bitbucket --ws imagile --repo toil pr list`, with the connection's `workspace`
and `repo` behind them. It's `--ws`, not `--workspace`, because toil's own `--workspace` is
the folder commands may read and write files in. The git remote is not read for a Cloud
connection. `repo list` and `repo create` need only the workspace; everything else needs
both. Over MCP they're the `workspace` and `repo` fields.

Data Center pull request and comment ids are read as whole numbers from the start of the
text: `12abc` is 12, and `abc` is sent as `NaN`. Cloud ids must be whole numbers.

## Commands

Every command is `toil bitbucket <resource> <action> [ids...] [--flags]`, ids are positional,
and its MCP tool is the path with underscores (`bitbucket_pr_get`,
`bitbucket_pr_comment_inline`). Every command also takes `--connection <name>`. Write
commands (marked ✎) need `writes: true` on the connection **and** `--allow-write`. `pr
delete-comment` is CLI only: it is never an MCP tool. The last column says who has it, and
a flag listed for one deployment is refused on the other.

| Command | Arguments and flags | Deployments and what it returns |
|---------|-------|---------|
| `repo list` | `--filter --limit --cursor` | Cloud: repositories in the workspace |
| `repo get` | | Cloud: the repository |
| `repo create` ✎ | `--name --description --public` | Data Center: a repository in the project. Cloud: a private one in the workspace (`--public` makes it public; `--project` puts it in a project of the workspace) |
| `repo default-reviewers` | | Data Center: the default-reviewer conditions. Cloud: the repository's default reviewers |
| `branch list` | `--filter --limit --cursor` | Cloud: branches, each with its target commit |
| `branch create` ✎ | `--name --commit` | Cloud: the created branch |
| `tag list` | `--filter --limit --cursor` | Cloud: tags, each with its target commit |
| `tag create` ✎ | `--name --commit --message` | Cloud: the created annotated tag |
| `commit list` | `--branch --path --limit --cursor` | Cloud: commits, newest first (100 unless `--limit` says otherwise) |
| `commit get` | `<commit>` | Cloud: the commit |
| `commit status` | `<commit>` | Build statuses of the commit. Data Center needs a project and repo it doesn't use |
| `file get` | `<path> --ref` | Cloud: `{ path, commit, content }` |
| `file list` | `[path] --ref` | Cloud: the folder's files and subfolders (the repository root without a path) |
| `pr list` | `--state --author --reviewer --created-after --created-before --query --updated-since --limit --cursor` | Pull requests in one state (`OPEN` unless `--state` says otherwise). `--author`, `--reviewer` and the dates are Data Center's, `--query` is Cloud's |
| `pr get` | `<id> --include` | The pull request, plus `included` lists on request |
| `pr create` ✎ | `--title --source --target --description --reviewers --close-source-branch --draft` | The created pull request. `--close-source-branch` and `--draft` are Cloud's |
| `pr create-many` ✎ | `--from --to --repos --title --description --reviewers` | Data Center: one pull request per repository |
| `pr update` ✎ | `<id> --title --description --reviewers --target` | The updated pull request. `--target` is Cloud's |
| `pr merge` ✎ | `<id> --strategy --message --delete-branch` | The merged pull request. `--message` is Cloud's, and a queued merge there is `{ pending, taskStatus }` |
| `pr decline` ✎ | `<id>` | The declined pull request |
| `pr current` | | The open pull request from the current git branch, or `null` (`toil git current-pr` is the same command) |
| `pr comments` | `<id> --no-with-replies --inline-only --general-only` | Comments, oldest first, replies included |
| `pr comment` ✎ | `<id> --body` | The comment |
| `pr comment-inline` ✎ | `<id> --file --line --body --line-type` | The comment |
| `pr reply` ✎ | `<id> <comment-id> --body` | The reply |
| `pr resolve` ✎ | `<id> <comment-id> --comment-version` | Data Center: `{ resolved }`, at `--comment-version`. Cloud: the resolution record |
| `pr delete-comment` ✎ | `<id> <comment-id> --comment-version` | `{ deleted }`, at `--comment-version` on Data Center |
| `pr diff` | `[id] --spec --file --context-lines` | `{ diff }`. Data Center needs `<id>`; `--spec` is Cloud's |
| `pr files` | `<id>` | Paths the pull request changes |
| `pr approve` ✎ / `pr unapprove` ✎ | `<id>` | The participant record (Cloud's `unapprove` returns `{ unapproved }`) |
| `pr needs-work` ✎ | `<id>` | The participant record; also `pr request-changes` |
| `pr reviewers` | `<id>` | Reviewers, with their status (Data Center) or `approved` and `state` (Cloud) |
| `pr add-reviewer` ✎ | `<id> --user` | Data Center: adds the user as a reviewer. On Cloud, `pr update --reviewers` takes the whole list |
| `pr builds` | `<id>` | Build statuses on the pull request |
| `pipeline list` | `--branch --limit --cursor` | Cloud: pipeline runs, newest first (100 unless `--limit` says otherwise) |
| `pipeline get` | `<pipeline>` | Cloud: the pipeline run |
| `pipeline steps` | `<pipeline>` | Cloud: its steps |
| `pipeline logs` | `<pipeline> <step>` | Cloud: `{ log }`, the step's log text |
| `api` | `<method> <path> --query --body-file --content-type` | Cloud: any REST API 2.0 endpoint |
| `check-toil-project` | | Data Center: checks the call's toil project (see below) |

```bash
# Data Center
toil bitbucket --project PROJ --repo imagile-api pr list --state OPEN --author jdoe
toil bitbucket pr get 42 --include reviews,checks
toil bitbucket pr list --updated-since 2026-10-01 --limit 20
toil bitbucket pr create --title "Add retries" --source feature/retries --allow-write
toil bitbucket pr comments 42 --no-with-replies

# Cloud
toil bitbucket --ws imagile --repo toil pr list --state ALL --limit 20 --connection imagile-bbc
toil bitbucket --ws imagile --repo toil file get src/retry.ts --ref feature/retries --connection imagile-bbc
toil bitbucket --ws imagile --repo toil pr diff 42 --file src/retry.ts --connection imagile-bbc
toil bitbucket --ws imagile --repo toil pipeline list --branch main --limit 5 --connection imagile-bbc
```

### Pull requests on Data Center

- `pr list` returns every page unless `--limit` says otherwise. `--state` is `OPEN` (default),
  `MERGED`, `DECLINED` or `ALL`; `--author` and `--reviewer` take usernames; `--created-after`
  (inclusive), `--created-before` (exclusive) and `--updated-since` (inclusive, on the last
  update) take ISO 8601 dates. Bitbucket has no date filter, so toil applies them to each page as
  it reads it. A date alone is UTC midnight; a date-time without a zone is local time. With
  `--limit N` it returns at most N of the pull requests that pass, and `meta.page.nextCursor`
  resumes: pass it back as `--cursor`, with `--limit`.
- `pr get --include reviews,checks,commits,files` adds an `included` object holding only the
  lists named, each as Bitbucket returns it, every page read: `reviews` (the `APPROVED`,
  `UNAPPROVED` and `REVIEWED` activities; `REVIEWED` is needs-work), `checks` (the build
  statuses `pr builds` returns, which is one page), `commits`, and `files` (the changes, as
  Bitbucket sends them). Each list costs more requests; an unknown name is refused before any is
  sent.
- `pr create` without `--reviewers` applies Bitbucket's default-reviewer conditions. The target
  is `--target`, then the connection's `targetBranch`, then `main`.
- `pr create-many` promotes `--from` to `--to` in every repository in `--repos a,b`, one at a
  time, skipping repositories with nothing to promote. Each one reports `created`,
  `nothing_to_promote` or `error`, with counts in `summary`. The command succeeds even when
  every repository failed, so check `summary.error`; that case also carries a
  `BITBUCKET_ALL_FAILED` warning in `meta.warnings`. Its time limit is 30 minutes rather than 2,
  so a long batch still reports every repository. The title defaults to
  `Promote <from> to <to>`.
- `pr update` changes `--title`, `--description` or `--reviewers` (which replaces the whole
  list). Anything not given is resent as it is now, so nothing is cleared.
- `pr merge` merges at the current version. `--strategy` is sent as Bitbucket's merge strategy
  id (`squash`, `ff`; Bitbucket calls a merge commit `no-ff`). `--delete-branch` sets
  Bitbucket's `autoSubject` and doesn't delete the branch; the merge still succeeds, with a
  `BITBUCKET_BRANCH_NOT_DELETED` warning.
- `pr current` reads the branch from `.git` (no git needed). With no Bitbucket connection, or
  one missing its `pat`, it succeeds with `{ "message": "Requires Bitbucket config. ..." }`
  (the latter with a `CONFIG_INCOMPLETE` warning).
- `pr comments` flattens replies in, with `parentId`. `--no-with-replies` returns top-level
  comments only (replies stay nested under `comments`). `pr comment-inline` anchors the line to
  the new version of the file. `pr resolve` takes the thread's root comment and
  `--comment-version` (default `0`; `pr comments` reports each comment's `version`).
- `pr diff <id>`: `data.diff` is Bitbucket's JSON diff structure as a string, not unified diff
  text. `pr files` is one request of up to 1000 changes; an entry that Bitbucket returns as a
  path object comes back as that object in a JSON string.
- `pr needs-work` marks needs-work as the token's user, adding them as a reviewer first when
  they aren't one. That addition stays if the status change then fails. `pr add-reviewer`
  adds `--user`.
- `pr builds` and `commit status` return one page of statuses, at Bitbucket's default size
  (25), for the newest commit.

### Pull requests on Cloud

`--reviewers` takes a comma-separated list of **Atlassian account ids** (`557058:abc12345-…`),
or `{uuid}`s in braces, as `pr get` and `repo default-reviewers` show them; Bitbucket Cloud has
no usernames in its API. `pr list --query` filters with Bitbucket's query language, for example
`--query 'author.account_id = "557058:abc12345"'` or
`--query 'source.branch.name = "feature/retries"'`, where Data Center has `--author` and
`--reviewer`. `--updated-since` takes an ISO 8601 date (midnight UTC) or a date and time with a
zone, and goes to Bitbucket as `updated_on >= <instant>` in the same query, after any `--query`
in parentheses.

`pr get <id> --include reviews,checks,commits,files` adds an `included` object holding only the
lists named, each as Bitbucket returns it with every page read: `reviews` (the activity entries
holding an `approval` or `changes_requested`), `checks` (the build statuses `pr builds`
returns), `commits`, and `files` (the diffstat entries, with `lines_added` and `lines_removed`
for each file). Each list costs more requests; an unknown name is refused before any is sent.

### Paging on Cloud

Lists follow Bitbucket's `next` link, 100 items a request, and toil follows a link only when it's
on the connection's own host and names the same list. Without `--limit`, `repo list`,
`branch list`, `tag list` and `pr list` read every page; `commit list` and `pipeline list`
return the newest 100, since a history has no end worth reaching. With `--limit N` they return
at most N, and `meta.page.nextCursor` resumes: pass it back as `--cursor` (with `--limit` on the
lists that read every page). Every other list is read in full. Paging stops after 1,000
requests with an error naming the list.

## Any endpoint on Cloud: `bitbucket api`

When no command above covers a Cloud endpoint, `bitbucket api` calls it directly. It sends the
connection's own credential, the same way every other `bitbucket` command does, to a path
under the connection's `baseUrl` (so the path starts after `/2.0`). On a Data Center connection
it fails with `UNSUPPORTED`:

```bash
toil bitbucket api GET repositories/imagile/toil --connection imagile-bbc
toil bitbucket api GET repositories/imagile/toil/refs/branches --query 'q=name ~ "release"' --query pagelen=10 --connection imagile-bbc
toil bitbucket api GET repositories/imagile/toil/pullrequests/42/merge/task-status/abc12345 --connection imagile-bbc
toil bitbucket api POST repositories/imagile/toil/pullrequests/42/comments --body-file comment.json --allow-write --connection imagile-bbc
```

- **The path** is relative to `baseUrl`, with or without a leading `/` (in Git Bash
  on Windows, leave it off: the shell rewrites `/repositories/...` into a file path,
  which is refused). A full URL, a scheme, `//host`, a leading backslash or a `.` /
  `..` segment is refused with `INVALID_INPUT` before anything is sent, so the token
  never leaves the connection's host.
- **The method decides the gate.** `GET` and `HEAD` are reads. `POST`, `PUT`,
  `PATCH` and `DELETE` are writes: they need `writes: true` on the connection
  **and** `--allow-write`. `DELETE` works only on the CLI: over MCP,
  `bitbucket_api` refuses it with `INVALID_INPUT`.
- **`--query key=value`** adds a query parameter; repeat it for more, or to repeat
  a key. **`--body-file <path>`** sends that file (inside the workspace, or `-` for
  stdin) as the body, as `application/json` unless `--content-type` says
  otherwise.
- **Output:** a JSON body is `data`, parsed. A text body (`text/*`, XML, or no content
  type) is `data` as text. Any other body is binary: `data` is its bytes as base64,
  with an `API_BINARY` warning. Text and binary are capped at 1 MB, with an
  `API_TRUNCATED` warning when the body was longer. An empty body (a `204`, a `HEAD`)
  is `null`. `meta.response` is `{ status, contentType }`. Errors use the usual codes
  (`AUTH`, `NOT_FOUND`, `HTTP`, `NETWORK`) with Bitbucket's own message; a `410` here
  is `AUTH`, as it is on every other command. A body labelled JSON that doesn't parse comes back as text,
  with an `API_NOT_JSON` warning.
- **Over MCP** it's the `bitbucket_api` tool, with `method`, `path`, `query` (an
  array of `key=value` strings), `bodyFile`, `contentType` and `allowWrite`.

Prefer a wrapped command when one exists: it knows the endpoint's paging and quirks,
and `bitbucket api` doesn't.

## Notes on Cloud

- `file get` and `file list` read at `--ref`, a branch, tag or commit hash (the
  repository's main branch without it). A branch or tag is first resolved to its
  newest commit, which `data.commit` reports, so a branch name with a `/` works. A
  file comes back as text; read a folder with `file list`, not `file get`.
- `pr diff <id>` and `pr files` read the pull request first and diff its source commit
  against its destination with `topic=true`, the three-dot diff Bitbucket shows on
  the pull request, so `--file` and `--context-lines` apply. `pr diff --spec` takes one
  commit (against its first parent) or `a..b`. Pass exactly one of an id and `--spec`.
  A pull request from a fork isn't diffed this way: use `--spec` in the fork, or `api`.
- `pr update` reads the pull request first and sends back its current title,
  description and reviewers for anything not given, so nothing is cleared by
  omission. `--reviewers` replaces the whole list.
- `pr merge --delete-branch` sends `close_source_branch`, which deletes the source
  branch after the merge. `--strategy` is one of `merge_commit`, `squash`,
  `fast_forward`, `squash_fast_forward`, `rebase_fast_forward` or `rebase_merge`; left
  out, the repository's default applies. When Bitbucket queues the merge or takes
  longer than it waits (`202`), `data` is `{ pending: true, taskStatus }` with a
  `BITBUCKET_CLOUD_MERGE_PENDING` warning: read `taskStatus` with
  `bitbucket api GET` until its `task_status` is `SUCCESS`.
- `pr needs-work` (`pr request-changes`) requests changes; `pr unapprove` withdraws an approval.
  Adding a single reviewer is `pr update --reviewers` with the whole list.
- `pr comment-inline` anchors `ADDED` and `CONTEXT` lines in the new file (`to`) and
  `REMOVED` lines in the old one (`from`).
- `pr resolve` takes the thread's root comment; one that's already resolved is
  an HTTP `409`.
- `pr current` matches the current git branch against open pull requests' source
  branch. It reads the branch from `.git`, and the workspace and repository from
  `--ws` and `--repo` or the connection, never from the remote.
- `pipeline logs` follows a redirect to signed storage with every header dropped, so
  the credential stays on `baseUrl`'s host. Pipeline and step uuids are taken with or
  without their braces.
- Not covered: Issues and Wikis (removed from Bitbucket Cloud in August 2026), the
  cross-workspace APIs (retired in April 2026), anything only a Connect app can
  reach, starting or stopping a pipeline, and deleting branches, tags or
  repositories.
- A 429 is retried after the delay Bitbucket asks for, as in every area.

## Moving from `bitbucket-cloud`

Bitbucket Cloud used to be its own area. It is `bitbucket` with `"deployment": "cloud"` now,
and the old names are gone, not deprecated:

- **Config:** a version 1 or 2 file loads as it is: a connection with `"area": "bitbucket-cloud"`
  is read as `"area": "bitbucket", "deployment": "cloud"`, and `defaults.bitbucket-cloud` folds
  into `defaults.bitbucket` with care, because `defaults.bitbucket` reaches every Bitbucket
  connection. The connection default folds as is. A Cloud default for another key (`workspace`,
  `repo`) moves to `defaults.bitbucket` only when no Data Center connection would inherit it, and
  is otherwise written onto the Cloud connections. In the other direction, when a file has both
  moved Cloud connections and Data Center ones, each shared key `defaults.bitbucket` already had
  (`project`, `repo`, `targetBranch`) is written onto the Data Center connections and leaves
  `defaults.bitbucket`, so it doesn't start reaching Cloud. Any command that saves a connection
  writes the file back as version 3 (so does the welcome menu's game save). Keychain entries are
  untouched. A version 3 file that still says `"area": "bitbucket-cloud"` warns with
  `CONFIG_RENAMED_AREA`, naming the new form.
- **`CONFIG_DEFAULT_KEPT`:** when both areas named a default connection, `bitbucket`'s stays the
  default and the warning names the Cloud one that was set aside. `toil connections migrate`
  saves the file as version 3 and clears the warning.
- **Toil UI and older toil:** a version 3 file is refused by toil 0.1.0-beta.2, so toil UI's pin
  moves to the toil release that has this change.
- **Commands and tools:** the `bitbucket-cloud` command path is `bitbucket`, the
  `bitbucket_cloud_*` tools are `bitbucket_*`, and `--areas bitbucket-cloud` is
  `--areas bitbucket`. `pr request-changes` is an alias of `pr needs-work`, whose tool is
  `bitbucket_pr_needs_work`. The old forms fail with `INVALID_INPUT` naming the new one.
- **Env vars:** `TOIL_BITBUCKET_CLOUD_*` is refused with `CONFIG_INVALID`; use `TOIL_BITBUCKET_*`
  with `TOIL_BITBUCKET_DEPLOYMENT=cloud`, or `TOIL_CONN_<NAME>_*` with
  `TOIL_CONN_<NAME>_DEPLOYMENT=cloud`. `TOIL_CONN_<NAME>_AREA=bitbucket-cloud` is refused the same
  way, with `TOIL_CONN_<NAME>_AREA=bitbucket` and `TOIL_CONN_<NAME>_DEPLOYMENT=cloud` as the fix.
  An empty `TOIL_BITBUCKET_CLOUD_*` is skipped unless `TOIL_STRICT_ENV=true`, which refuses it
  too (see `core.md`, **Configuration**).
- **Old `TOIL_BITBUCKET_*` values on a Cloud default:** `TOIL_BITBUCKET_*` reaches bitbucket's
  default connection. When that connection is Cloud (a migrated `bitbucket-cloud` one, or
  `deployment` set in `defaults.bitbucket`) and `TOIL_BITBUCKET_DEPLOYMENT` isn't set, the call
  fails with `CONFIG_INVALID` naming the variables, so Data Center values and a token never land
  on Bitbucket Cloud by accident. Set `TOIL_BITBUCKET_DEPLOYMENT=cloud` if the values are Cloud
  ones, or define a separate Data Center connection with `TOIL_CONN_<NAME>_*`.
  `TOIL_CONN_<NAME>_*` is never affected.
- **Toil projects:** a `bitbucket-cloud` section is read as `bitbucket` (also under an environment and
  in a person's `ids`), with a `TOIL_PROJECT_RENAMED_AREA` warning to rename it (`toil projects check`
  reports it). With both, `bitbucket` wins. A toil project has one `bitbucket` section, so it picks
  one Bitbucket connection: a body of work that uses both a Data Center and a Cloud Bitbucket takes
  two toil projects. A person keeps one Bitbucket id per toil project now (a username on Data Center, an
  account id on Cloud), as with Jira.
- **Pipelines:** `BITBUCKET_WORKSPACE` and `BITBUCKET_REPO_SLUG` still fill `workspace` and `repo`,
  but only on a default connection that is Cloud, and the default is Data Center unless you say
  otherwise. Set `TOIL_BITBUCKET_DEPLOYMENT=cloud` in the pipeline.

## Checking a toil project

`check-toil-project` checks the call's toil project on a Data Center connection: each project key it names (`project`, per repo or not, and `projects`) exists, and each repository (`repo`) in its project. It's `toil bitbucket check-toil-project` (`--toil-project <name|file>`, or the toil project the folder resolves to), and it returns `{ toil project, connection, env, ok, checked, checks, unchecked }`, one check per value with its key path. The CLI exits 1 when one is missing. A failure other than not-found (a bad token, an unreachable host) fails the command. Read only. A Cloud connection gets `UNSUPPORTED`.
