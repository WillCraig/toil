---
area: ado
description: Work items, boards, sprints, git repositories, pull requests and pipelines on Azure DevOps Server and Azure DevOps Services
---

# Azure DevOps (`ado`)

Work items, git repositories, pull requests and pipelines on **Azure DevOps Server**
(on-premises), and work items, a team's boards, backlogs and sprints, git repositories and
pull requests on **Azure DevOps Services** (`https://dev.azure.com/<organization>`, or the
older `https://<organization>.visualstudio.com`), through the REST API with
`api-version=7.1`. One command tree and one set of MCP tools serve both; each call goes
to the deployment of the connection it resolves. Verification level: `unit` for both.
Server's behavior is the one the command contract records; Services was built from
Microsoft's REST API reference. Its work item reads and the team settings commands
(sprints, backlogs, boards, work item type states) have been run against one live Scrum
organization; its pull request commands have not.

**Supported versions:** Azure DevOps Server 2022.1 or later (REST API 7.1). Requests
send `api-version=7.1` (`7.1-preview.1` for connection data, `7.1-preview.4` for work
item comments), which newer servers also accept. Azure DevOps Server 2022 RTM, 2020
and 2019 are out of scope: an older server's "REST API version out of range" answer
comes back as an error saying the server is too old for toil and naming 2022.1. Azure
DevOps Services (a connection with `deployment` cloud) is always current: toil sends
`api-version=7.1`, the newest released version (7.2 is preview only), with an
organization-scoped personal access token as Basic auth.

## Server and Services

A connection says which one it is with `deployment`: `server` for Azure DevOps Server (the
default) or `cloud` for Azure DevOps Services. The two keep separate API code, and
`meta.context.connection.deployment` says which one ran. What differs:

| | Server | Services |
|---|---|---|
| Where the organization is | Every path starts with a **collection**: `--collection` (or `--organization`) | The **base URL** is the organization; there are no collections |
| Credential | personal access token, any scope the commands need | **organization-scoped** personal access token |
| CI token | `SYSTEM_ACCESSTOKEN` is read for the default connection | not read; map it into `TOIL_ADO_PAT` yourself |
| Project and repo from the git remote | read (`<host>[/tfs]/<collection>/<project>/_git/<repo>`) | not read |
| A command that needs a project | every command, even ones that use none | only the ones that use one |
| `work-item comments` | the first page | every comment, with `--limit` and `--cursor` |
| `pr comments` | system comments included | left out unless `--include-system` |
| `work-item create` | `--parent`, `--input-file` | flags only |
| `work-item update` | `--input-file` | `--rev`, flags only |
| `pr update` | `--reviewers` | `--target` |
| `pr merge` | | `--message`; reads the pull request first |
| `pr resolve` | marks it fixed | `--status` |
| Only here | `connection-data`, `collection list`, `work-item assign link tag untag attachments attach download areas types fields schema`, `repo create`, `repo default-reviewers`, `commit status`, `pr files diff builds delete-comment`, `pipeline` and `run` commands, `check-toil-project` | `pr threads`, `sprint`, `backlog` and `board` commands, `api` |

A call the connection's deployment can't serve fails **before any request** with
`UNSUPPORTED`, saying which deployment and what to do: `ado pipeline list` or
`--parent` on a Services connection, `ado sprint list` or `--rev` on a Server one. The
error names the connections you have that can run it. `--collection` and `--organization`
are refused on a Services connection the same way.

## Credential

**Server:** an Azure DevOps **personal access token**: in Azure DevOps, User settings →
Personal access tokens → New Token. Give it the scopes the commands you'll use need (Work
Items, Code, Build; Read & write for the write commands).

**Services:** an **organization-scoped personal access token**: in Azure DevOps, User
settings → Personal access tokens → New Token, with **Organization** set to the one
organization this connection is for. Give it the scopes the commands you'll use need: Work
Items and Code, Read (or Read & write for the write commands), plus Project and Team Read
for `project list`, `project get`, and the `sprint`, `backlog` and `board` commands when no
team is given (toil reads the project for its default team). **Don't create a global
token** ("All accessible organizations"). Microsoft is retiring global personal access
tokens: every existing one stops working on **December 1, 2026**. A connection is one
organization, so an organization-scoped token is all it needs. A `401` or `403` is
`AUTH`, and its fix says to create an organization-scoped token and that global ones are
being retired.

toil sends either one as `Authorization: Basic base64(":" + token)`, with an empty user
name. There is no password, OAuth, Microsoft Entra ID or service principal sign-in:
those need a browser login or an app registration.

In an Azure Pipelines job on **Server**, the job's own token, `SYSTEM_ACCESSTOKEN`, is
read when `TOIL_ADO_PAT` isn't set (for the default connection, and before anything in the
config file), so a pipeline step needs only `TOIL_ADO_BASE_URL`. Map it into the step's
environment (`env: SYSTEM_ACCESSTOKEN: $(System.AccessToken)`). A **Services** default
connection ignores it, because the job token is not an organization-scoped personal
access token, and would otherwise replace the one you configured. For Services, map the
token and the organization URL yourself:

```yaml
- script: toil ado work-item get 42
  env:
    TOIL_ADO_DEPLOYMENT: cloud
    TOIL_ADO_PAT: $(System.AccessToken)
    TOIL_ADO_BASE_URL: $(System.CollectionUri)
```

On Services, `System.CollectionUri` is the organization URL with a trailing slash
(`https://dev.azure.com/imagile/`), which `baseUrl` accepts.

## Configuration

| Key | Env var | Required | Meaning |
|-----|---------|----------|---------|
| `baseUrl` | `TOIL_ADO_BASE_URL` | yes | Server: the root, e.g. `https://ado.imagile.dev` (keep any context path, such as `/tfs`). Services: the organization URL, `https://dev.azure.com/<organization>` (or `https://<organization>.visualstudio.com`) |
| `pat` | `TOIL_ADO_PAT` (or `SYSTEM_ACCESSTOKEN`, Server only) | yes | Personal access token; on Services an organization-scoped one (a secret) |
| `deployment` | `TOIL_ADO_DEPLOYMENT` | no | `server` (Azure DevOps Server, the default) or `cloud` (Azure DevOps Services) |
| `collection` | `TOIL_ADO_COLLECTION` | no | Server only: default collection, when `--collection` isn't given |
| `project` | `TOIL_ADO_PROJECT` | no | Default team project, when `--project` isn't given |
| `repo` | `TOIL_ADO_REPO` | no | Default git repository, when `--repo` isn't given |
| `team` | `TOIL_ADO_TEAM` | no | Services only: default team for the `sprint`, `backlog` and `board` commands, when `--team` isn't given (else the project's default team) |
| `fieldAliases` | `TOIL_ADO_FIELD_ALIASES` | no | Work item field aliases as a JSON object, friendly name to reference name, e.g. `{"storypoints": "Microsoft.VSTS.Scheduling.StoryPoints"}` |
| `discoveredFields` | `TOIL_ADO_DISCOVERED_FIELDS` | no | Server only: fields an earlier discovery recorded; kept, not read |
| `discoveredTypes` | `TOIL_ADO_DISCOVERED_TYPES` | no | Server only: work item types an earlier discovery recorded; kept, not read |
| `writes` | `TOIL_ADO_WRITES` | no | `true` lets write commands run (with `--allow-write`) |

A Services `baseUrl` that doesn't name exactly one organization is refused with
`CONFIG_INVALID` before anything is sent: `https://dev.azure.com` with no organization
or with more after it (a project), or a `visualstudio.com` URL with any path other
than the legacy `/DefaultCollection`.

Environment variables (CI, or a one-off shell):

```bash
# Server
export TOIL_ADO_BASE_URL=https://ado.imagile.dev
export TOIL_ADO_PAT=<your personal access token>

# Services
export TOIL_ADO_DEPLOYMENT=cloud
export TOIL_ADO_BASE_URL=https://dev.azure.com/imagile
export TOIL_ADO_PAT=<your organization-scoped token>
```

Or `~/.toil/config.json`, with `collection`, `project` and `repo` usually set once
under `defaults.ado`:

```json
{
  "version": 3,
  "connections": {
    "corp-ado": { "area": "ado", "baseUrl": "https://ado.imagile.dev", "writes": true },
    "imagile-ado": { "area": "ado", "deployment": "cloud", "baseUrl": "https://dev.azure.com/imagile", "writes": true }
  },
  "defaults": { "ado": { "connection": "corp-ado", "collection": "DefaultCollection", "project": "Imagile", "repo": "imagile-api" } }
}
```

The token never goes in this file; a plaintext one there is refused with
`CONFIG_INVALID`. Run `toil connections add corp-ado --area ado` (or
`toil connections login corp-ado` for an existing connection) to keep it in the OS
credential store, or set `TOIL_ADO_PAT`. Env vars always win over the file. Another
Azure DevOps is another connection, chosen per call with `--connection imagile-ado`, or
configured from env with `TOIL_CONN_IMAGILE_ADO_AREA=ado`,
`TOIL_CONN_IMAGILE_ADO_DEPLOYMENT=cloud` plus `TOIL_CONN_IMAGILE_ADO_BASE_URL` and
`TOIL_CONN_IMAGILE_ADO_PAT`. A Services connection is one organization, so a second
organization is a second connection with its own token. A `defaults.ado` setting reaches
the connections of both deployments, so a `collection` there is simply not used by a
Services connection.

## Where a command acts

`--collection <name>` (or its alias `--organization <name>`; Server only), `--project
<name>` and `--repo <name>` are group flags, accepted before or after the command
(`toil ado --project Imagile work-item get 42`). Over MCP they're the `collection`,
`organization`, `project` and `repo` fields. `meta.context` says where each came from.

**On Server**, without them toil reads them from the first of the workspace's remotes on
the connection's host, of any name, trying `origin` first
(`https://<host>[/tfs]/<collection>/<project>/_git/<repo>`, or the `_ssh` forms with
`ssh://git@<host>` or `git@<host>:`), then the connection's `collection`, `project`
and `repo` settings. `--collection` beats `--organization`, which beats the remote and
the settings. An `ssh://` remote with no user, an HTTPS remote with a user name, and
the short `<collection>/_git/<project>` form aren't read correctly.

**Every Server command needs a collection and a project**, even the ones that don't use
them (`whoami`, `collection list`), and fails with "Could not determine Azure
DevOps collection" (or project) when either is missing. Every `repo` and `pr` command
except `repo list` and `repo create` also needs a repo.

Ids are read as whole numbers from the start of the text on Server: `12abc` is 12, and
`abc` is sent as `NaN`. On Services they are whole numbers, checked by the schema:
`work-item get 12abc` is refused.

**On Services**, the organization is the connection, so there is no collection, and
the git remote isn't read: toil uses a toil project, then the connection's `project`, `repo`
and `team`.

- A work item belongs to the organization, so `work-item get`, `work-item update`,
  `work-item transition`, `work-item history` and `work-item get-many` need neither a
  project nor a repo.
- `work-item create`, `work-item search`, `work-item comments`, `work-item comment`,
  `work-item iterations`, `work-item states` and `repo list` need a project.
- `repo get` and every `pr` command need a project and a repo.
- Every `sprint`, `backlog` and `board` command needs a project and acts for one
  team: `--team <name or id>` on the command (not the group; `team` over MCP), else a
  toil project's or the connection's `team`, else the project's default team, which toil
  reads from the project first (one extra request) and names in an
  `ADO_DEFAULT_TEAM` warning.
- `whoami`, `project list` and `project get` need neither.

A missing project or repo on Services fails before any request with `INVALID_INPUT`,
naming the flag and the setting.

## Commands

Commands are `toil ado <resource> <action> [ids...] [--flags]`. Ids are positional:
the resource's id first, then a sub-item's (attachment, thread, comment). Every command
also takes `--connection <name>`. Write commands need `writes: true` on the connection
and `--allow-write` on the call. The tables and lists below say which deployment has
each command or flag.

Server and projects:

- `whoami`: The connection data: the authenticated user (`authenticatedUser.id` is the
  identity id the vote commands use), the instance and the deployment. On Server it is
  the collection's, on Services the organization's.
- `connection-data` (Server): The same as `whoami`.
- `collection list` (Server): The server's project collections.
- `project list`: Every team project in the collection (Server) or organization
  (Services).
- `project get <name>`: One team project by name (Services also by id).

Work items (`<id>` is the work item id):

- `work-item get <id>`: A work item with every field and relation.
- `work-item create`: Create one (`--type`, `--title`, `--description`, `--assignee`,
  `--priority`, `--field name=value` repeatable). Server also takes `--input-file` and
  `--parent <id>`, which adds a parent link afterwards; the result is the item as
  created, and a failed link is only an `ADO_PARENT_LINK_FAILED` warning, with the item
  already created. Services takes neither.
- `work-item update <id>`: Set fields (`--field name=value` repeatable). Server also
  takes `--input-file`; Services also takes `--rev <n>`, which adds a JSON Patch `test`
  of the revision first, so the server refuses the whole change if someone else changed
  the item since you read it.
- `work-item transition <id>`: Set `--state`, or `--to <intent-or-status>` (`start`,
  `review`, `done`, `reopen` or a state name), resolved against the states the item's
  own type has (`core.md`, **Moving work items by intent**).
- `work-item assign <id>` (Server): Assign to `--assignee`, a display name or email.
- `work-item link <id>` (Server): Link it to `--target <id>`, `--type related`
  (default), `parent`, `child`, `duplicate`, `duplicate-of`, or a raw relation name.
- `work-item search`: Run `--wiql`; returns the matching ids and urls, not their
  fields. `--updated-since <iso>` keeps only items changed at or after that instant: a
  date (`2026-10-01`, UTC midnight) or a date-time with its zone
  (`2026-10-01T09:00:00Z`). toil ANDs `[System.ChangedDate] >= '<instant>'` onto the
  query's own `WHERE`, in parentheses so an `OR` keeps its meaning, and asks the
  server for time precision. Time precision applies to the whole query, so with
  `--updated-since` an `=` on a date field (`[System.CreatedDate] = @Today`) matches
  one exact instant, not a day; write date conditions with `>=` and `<` instead.
  It and `--limit` work on flat queries (`FROM WorkItems`) only; a link query is
  refused. With `--limit`, each page runs the query again, so an item changed in
  between can move. A query returns at most 20,000 items, so a page can't end past
  that.
- `work-item get-many <id...>`: Several work items through the batch endpoint, 200 ids
  per request, at most 1,000 per call. Returns `{ count, value, missing }`: `value`
  holds the items found in the order asked, with every field and relation, or only
  `--fields System.Title,System.State`; `missing` lists each id that doesn't exist or
  the token can't see, with an `ADO_WORK_ITEMS_MISSING` warning.
- `work-item history <id>`: Every revision of a work item, oldest first; each is the
  whole item as it stood after that change, so neighbours show what changed and when.
- `work-item feed` (`--updated-since <iso>`, `--fields a,b`): The project's change feed, the revisions of every work
  item in the project as one feed (the reporting work item revisions API, on both
  deployments), so a sync reads what changed since a date in a few requests instead of
  one `work-item history` call per item. Each entry is `{ id, rev, fields }` with every
  reportable field, or only `--fields`; people are `Name <email>` text, long text
  fields (the description) are left out, and the revisions of one item are in order but
  not next to each other. `--updated-since` takes the same date forms as `work-item
  search` and starts the feed there (revisions from it on); without it the feed starts at
  the project's first revision. It is read batch by batch, following the continuation
  token, with `--limit` and `--cursor` like any list. A feed that starts at a date holds
  only the later revisions of an older item, so an item's whole history is the feed's
  only if its revisions run from 1 to the item's `rev`; otherwise read it with
  `work-item history`.
- `work-item comments <id>`, `work-item comment <id>` (`--body`): Comments. Listing
  reads the first page only on Server; on Services it returns every comment, following
  continuation tokens, or with `--limit` at most that many and `meta.page.nextCursor`.
- `work-item tag <id>`, `work-item untag <id>` (Server): `--tags a;b` or `a,b`, matched
  ignoring case. The tag list is read and written back, with no revision check.
- `work-item attachments <id>` (Server): The attached files (id, name, url, size, dates).
- `work-item attach <id>` (Server): Upload `--file` (a path in the workspace), then link
  it (`--comment` optional). Returns the uploaded attachment's `{ id, url }`. If the link
  fails, the upload stays on the server.
- `work-item download <id> <attachment-id>` (Server): Save the attachment to `--dir`
  (default `.toil`) in the workspace; returns `{ saved, name, size }`. It never
  overwrites a file. A name Windows would read as another file is saved as one it
  won't: a device name such as `CON` gets a leading `_`, a `:` and what follows it is
  dropped, as are trailing dots and spaces. The token only goes to the configured host:
  an attachment URL naming another host is fetched from the configured one, with an
  `ADO_ATTACHMENT_HOST` warning.
- `work-item areas` (Server), `work-item iterations`: The area or iteration tree,
  `--depth` (default 10), with start and finish dates on the iterations.
- `work-item types` (Server): The work item types with their states and required fields.
- `work-item states`: The states of `--type`, each `{ name, color, category }` on
  Services, in workflow order. `category` (`Proposed`, `InProgress`, `Resolved`,
  `Completed`, `Removed`) is how a custom state is classified. A type a Services project
  doesn't have answers with no states rather than an error, so toil adds an
  `ADO_TYPE_UNKNOWN` warning.
- `work-item fields` (Server): The collection's fields, or with `--type` a type's
  (those have no `type` or `readOnly`); `--custom-only` drops `System.*` and
  `Microsoft.VSTS.*`.
- `work-item schema` (Server): The `--input-file` JSON schema and an example;
  `--example-only` returns just the example as `data`. Needs no connection.

`work-item types` and `work-item fields` have no `--save`; passing it is an unknown
option. The aliases `--save` would store are the built-in ones below, which apply
anyway. `--discover` is accepted and changes nothing.

Field names in `--field` and `--input-file` resolve through the connection's
`fieldAliases`, then the built-in aliases (`title`, `state`, `assignedto`,
`description`, `areapath`, `iterationpath`, `iteration`, `tags`, `priority`,
`severity`, `effort`, `storypoints`, `remainingwork`, `remaining`,
`acceptancecriteria`, `reprosteps` and others), matched ignoring case, spaces and
dashes; anything else is sent as a reference name (`MyOrg.Team`, or
`Microsoft.VSTS.Scheduling.StoryPoints=5`). On Services values are sent as text, and the
server converts them. To add your own alias, set `fieldAliases` as a JSON object:
`toil connections add <name> --area ado` asks for it when setting up a connection;
on one that exists, add `"fieldAliases": { "effortdays": "MyOrg.EffortDays" }` to it
in `~/.toil/config.json`, or set `TOIL_ADO_FIELD_ALIASES` (or
`TOIL_CONN_<NAME>_FIELD_ALIASES`) to the JSON. A Server `--input-file` is
`{ "type": "Bug", "fields": { "Title": "...", "Description": "@desc.html" } }`: a value
starting with `@` is read from that file. Flags win over the file, with an
`ADO_INPUT_OVERRIDDEN` warning naming the keys.

Repositories:

- `repo list`, `repo get`: Repositories in the project. `repo create` (Server, `--name`).
- `repo default-reviewers` (Server): Required reviewers policies covering the repository.
- `commit status <commit>` (Server): Statuses posted to a commit.

Pull requests (`<id>` is the pull request id):

- `pr list`: Every pull request, `--state active` (default), `abandoned`,
  `completed` or `all`. `--creator` and `--reviewer` are sent as identity id filters,
  so pass an id (from `whoami`), not an alias. `--created-after` and
  `--created-before` take ISO 8601 dates; a date alone is UTC midnight, a date-time
  without a zone is local time (Services also takes a date-time with its zone).
  `--updated-since <iso>` (the same date forms) keeps every pull request that is still
  active, plus those created or closed at or after that instant. Azure DevOps records no
  last-updated time on a pull request (only `creationDate` and `closedDate`), so this is
  a superset of what changed: a sync that merges by `pullRequestId` misses nothing. It
  combines with the other filters, and `--limit` counts the pull requests it keeps.
- `pr get <id>`: One pull request. `--include <list>` adds `data.included`, holding
  only the lists asked for (comma-separated, any case), each every page of Azure
  DevOps' own records: `reviews` (the comment threads, where each vote change is a
  system comment in a thread whose `properties.CodeReviewThreadType` is `VoteUpdate`,
  beside each reviewer's comments with `publishedDate`), `checks` (the pull request's
  statuses), `commits`, and `files` (the `changeEntries` of the latest iteration).
  Each list costs one or more extra requests; an unknown name is refused before any
  request.
- `pr create`: `--title`, `--source`, `--target` (default `main`), `--description`,
  `--reviewers <id,id>` (identity ids), `--draft`. Give branch names without
  `refs/heads/`, which toil adds. On Server a full ref gets it twice; on Services a full
  ref (`refs/heads/x`, `refs/tags/x`) is sent as given.
- `pr update <id>`: `--title`, `--description`, `--draft true|false`, in one PATCH; on
  Server also `--reviewers`, on Services also `--target`. Services doesn't change
  reviewers: the API doesn't take them on that call.
- `pr merge <id>`: Ask the server to complete it, `--strategy noFastForward`
  (default), `squash`, `rebase` or `rebaseMerge`, `--delete-source`. Completion is
  asynchronous; check `data.status`. Services also takes `--message`, reads the pull
  request for its source commit first (one with no source commit yet is refused with
  `INVALID_INPUT` before anything is changed), and its `data.mergeStatus` stays `queued`
  while policies or conflicts hold it.
- `pr abandon <id>`: Abandon it.
- `pr threads <id>` (Services): The comment threads, as the server returns them,
  system ones included.
- `pr comments <id>`: Every comment of every thread, oldest first, with `threadId` and
  `threadContext` (null for a general comment). Server includes system comments;
  Services leaves them out unless `--include-system`. `--inline-only` or
  `--general-only` narrows it.
- `pr comment <id>` (`--body`), `pr comment-inline <id>` (`--file /src/a.ts`,
  `--line 12`, `--body`, `--line-type left|right`, default `right`; a path without a
  leading `/` gets one on Services), `pr reply <id> <thread-id>` (`--body`),
  `pr resolve <id> <thread-id>` (status `fixed`; Services takes `--status`: `fixed`
  by default, `wontFix`, `closed`, `byDesign`, `pending`, or `active` to reopen).
- `pr delete-comment <id> <thread-id> <comment-id>` (Server): Returns
  `{ "deleted": true }`. CLI only: deletes are never exposed through MCP.
- `pr files <id>` (Server): Changed files of the latest iteration, at most 100.
- `pr diff <id>` (Server): Changed files between the last merge commits, at most 100;
  `--path` keeps one file (a leading `/` is added).
- `pr reviewers <id>`: Reviewers and their votes.
- `pr approve <id>`, `pr unapprove <id>`, `pr wait-for-author <id>`: Vote 10, 0 or -5
  as the token's own user.
- `pr builds <id>` (Server): Builds of the pull request's source branch (not of its
  merge ref).

Pipelines and runs (Server):

- `pipeline list`, `pipeline get <id>`: Pipelines (build definitions).
- `pipeline run <id>`: Queue a run of the pipeline, `--branch` (a short name gets
  `refs/heads/`), `--parameter k=v` repeatable. `--wait` polls every `--poll` seconds
  (10) for up to `--timeout` seconds (600). A result other than `succeeded` still
  returns the build, with an `ADO_BUILD_NOT_SUCCEEDED` warning, and the CLI exits 1.
  The command's own time limit is 11 minutes, so a longer `--timeout` also needs
  `TOIL_TIMEOUT_MS`.
- `run list`: Runs, `--definition <id>` or `--name <pipeline>`, `--branch` (as given,
  e.g. `refs/heads/main`), `--status`, `--top` (default 50; `--top 0` lists every
  run).
- `run get <id>`, `run cancel <id>`: One run; cancel it.
- `run logs <id>`: The run's logs; with `--log-id`, that log's text as
  `{ "log": "..." }`.

Sprints, backlogs and boards (Services): these read a team's settings, which is where
Azure DevOps keeps what its boards are built from. Each returns the server's own JSON (a
list's `value`, or the whole body).

- `sprint list`: The sprints the team has selected, in the team's order: `id`, `name`,
  `path` and `attributes { startDate, finishDate, timeFrame }`. `timeFrame` is `past`,
  `current` or `future`, and the team settings set it even when the sprint has no dates,
  so this is how to tell which sprint is current; the iteration tree
  (`work-item iterations`) carries dates only where someone set them. `--state current`
  (or a comma-separated list of `past`, `current`, `future`) keeps only those; anything
  else is `INVALID_INPUT`.
- `sprint items <id>`: Takes a sprint's `id` from `sprint list` and returns
  `workItemRelations`: each `{ rel, source, target: { id, url } }`, with `rel` and
  `source` null for a top-level item and `System.LinkTypes.Hierarchy-Forward` with the
  parent as `source` for a child. Ids only: fetch fields with `work-item get-many`.
- `backlog list`: The backlog levels: `id` (a category reference name such as
  `Microsoft.RequirementCategory`), `name`, `rank`, `type`, `workItemTypes`,
  `defaultWorkItemType`, `columnFields` and `isHidden`. `backlog items <id>` returns that
  level's `workItems` in backlog (priority) order, each `{ rel, source, target: { id }
  }`.
- `board list`: The boards, one per backlog level (`id`, `name`, `url`). `board get <id>`
  takes the id or the name and returns the board's `columns`, each `{ id, name,
  itemLimit, columnType, stateMappings, isSplit }`, its `rows` (swimlanes),
  `allowedMappings` and `fields`. A team can rename its columns (To Do, Doing, Testing,
  Done over New, Approved, Committed, Done), so the column an item sits in can't be
  worked out from its state: `stateMappings` (`{ "<work item type>": "<state>" }`) says
  which state each column holds.

Paging: `project list`, `pipeline list`, `run list`, `pr list`, `pr builds`,
`work-item search`, `work-item history`, `work-item feed` and (Services) `work-item comments` return the
whole list by default. With `--limit <n>` they return at most that many and set
`meta.page.nextCursor`; pass it back as `--cursor`, with the same `--limit`, for the
next page, until it's `null`. `run list` takes `--limit` or `--top`, not both. Every
list except `work-item search` (one request) reads page by page and stops with an
`HTTP` error after 1,000 pages, naming the list.

Write commands need `writes: true` on the connection and `--allow-write` on the call.

```bash
toil ado --collection DefaultCollection --project Imagile work-item get 42
toil ado work-item create --type Bug --title "Login broken" --field "Story Points=3" --allow-write
toil ado work-item link 42 --target 7 --type child --allow-write
toil ado --repo imagile-api pr list --state all
toil ado --repo imagile-api pr list --state all --updated-since 2026-10-01T00:00:00Z --limit 100
toil ado --repo imagile-api pr get 42 --include reviews,checks,commits,files
toil ado pr comment-inline 42 --file /src/app.ts --line 12 --body "Off by one?" --allow-write
toil ado work-item search --wiql "SELECT [System.Id] FROM WorkItems" --updated-since 2026-10-01 --limit 200
toil ado work-item get-many 42 7 --fields System.Title,System.State
toil ado pipeline run 5 --branch main --wait --allow-write
toil ado run logs 101 --log-id 3
# On a Services connection (--connection imagile-ado, or make it the default)
toil ado --project Imagile work-item update 42 --field state=Active --rev 3 --allow-write --connection imagile-ado
toil ado --project Imagile --repo imagile-api pr merge 42 --strategy squash --delete-source --allow-write --connection imagile-ado
toil ado --project Imagile sprint list --state current --connection imagile-ado
toil ado --project Imagile board get "Backlog items" --team "Imagile Team" --connection imagile-ado
```

Over MCP the same commands are tools named after the path, with spaces and
hyphens as underscores (`ado_work_item_get`, `ado_pr_comment_inline`), and a
positional id is the `id` field.

## Output, Server and Services

`data` is the server's own JSON, so each deployment returns its own API's shape, and
where they agree it is the same one. `toil util owi map` reads `work-item get`,
`work-item get-many`, `work-item history` and `work-item iterations` output from either
into Open Work Items, with `source.deployment` saying which. The differences, for anything
that reads both:

- **Work items** have the same shape: `id`, `rev`, `fields` keyed by reference name,
  `relations`, `url`. On Services every `url` is under the organization
  (`https://dev.azure.com/<org>/_apis/...`) with no collection segment.
- **Identities** (`System.AssignedTo`, `System.CreatedBy`, `createdBy`, `reviewers`)
  are the same object, `{ displayName, id, uniqueName, url, imageUrl, descriptor }`,
  but on Services `uniqueName` is the user's sign-in email, `descriptor` starts with
  `aad.` (or `msa.`), and `url` is on `vssps.dev.azure.com`. On Server `uniqueName` is
  often `DOMAIN\user`.
- **Warning codes** are the same where the idea is: `ADO_WORK_ITEMS_MISSING` on both.
  `ADO_TYPE_UNKNOWN` and `ADO_DEFAULT_TEAM` are Services'.

## Any endpoint: `ado api` (Services)

When no command above covers an endpoint on a Services connection, `ado api` calls it
directly. It sends the connection's own token, the same way every other `ado` command
does, to a path under the organization URL. Add `api-version` yourself:

```bash
toil ado api GET _apis/projects --query api-version=7.1 --connection imagile-ado
toil ado api GET Imagile/_apis/wit/workitemtypes --query api-version=7.1 --query '$expand=states' --connection imagile-ado
toil ado api PATCH _apis/wit/workitems/42 --query api-version=7.1 --body-file patch.json --content-type application/json-patch+json --allow-write --connection imagile-ado
```

- **The path** is relative to `baseUrl`, with or without a leading `/` (in Git Bash
  on Windows, leave it off: the shell rewrites `/_apis/...` into a file path, which is
  refused). A full URL, a scheme, `//host`, a leading backslash or a `.` / `..`
  segment is refused with `INVALID_INPUT` before anything is sent, so the token never
  leaves the connection's host.
- **The method decides the gate.** `GET` and `HEAD` are reads. `POST`, `PUT`,
  `PATCH` and `DELETE` are writes: they need `writes: true` on the connection
  **and** `--allow-write`. `DELETE` works only on the CLI: over MCP,
  `ado_api` refuses it with `INVALID_INPUT`.
- **`--query key=value`** adds a query parameter; repeat it for more, or to repeat
  a key. **`--body-file <path>`** sends that file (inside the workspace, or `-` for
  stdin) as the body, as `application/json` unless `--content-type` says otherwise.
  A work item change is `application/json-patch+json`.
- **Output:** a JSON body is `data`, parsed. A text body (`text/*`, XML, or no content
  type) is `data` as text. Any other body is binary: `data` is its bytes as base64,
  with an `API_BINARY` warning. Text and binary are capped at 1 MB, with an
  `API_TRUNCATED` warning when the body was longer. An empty body (a `204`, a `HEAD`)
  is `null`. `meta.response` is `{ status, contentType }`. Errors use the usual codes
  (`AUTH`, `NOT_FOUND`, `HTTP`, `NETWORK`) with Azure DevOps's own message. A body
  labelled JSON that doesn't parse comes back as text, with an `API_NOT_JSON` warning.
- **Over MCP** it's the `ado_api` tool, with `method`, `path`, `query` (an array
  of `key=value` strings), `bodyFile`, `contentType` and `allowWrite`.

Prefer a wrapped command when one exists: it knows the endpoint's paging and quirks,
and `ado api` doesn't. On a Server connection it fails with `UNSUPPORTED`.

## Ticket the work

Before starting work no ticket covers, rank your open work items against it.
`work-item search` returns ids, so read them with `work-item get-many` and map that:

```bash
toil ado work-item search --wiql "SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @Me AND [System.State] NOT IN ('Done', 'Closed', 'Removed')"
toil ado work-item get-many 42 43 47 | toil util owi map | toil util owi similar --query "Card payments time out at checkout"
```

Then ask the person, as `core.md`, **Ticket the work**, says: attach the work to a
match (nothing is written), create a sub-task under it, or create a new ticket. On a
Server connection a sub-task is
`toil ado work-item create --type Task --parent 42 --title "<text>" --allow-write`. On a
Services connection `work-item create` takes no parent, so a sub-task is created with
`toil ado work-item create --type Task --title "<text>" --allow-write` and linked to its
parent on the board. A new ticket takes the project from the toil project. Both are writes,
made only on the person's yes.

## Checking a toil project

`check-toil-project` (Server) checks the call's toil project against the server: each team project it names (`project`, per repo or not, and `projects`) exists in its collection, and each repository (`repo`) in its project. The collection is the section's `collection`, else `--collection` or the connection's; a value with no collection anywhere is `INVALID_INPUT`. It's `toil ado check-toil-project` (`--toil-project <name|file>`, or the toil project the folder resolves to), and it returns `{ toil project, connection, env, ok, checked, checks, unchecked }`, one check per value with its key path. The CLI exits 1 when one is missing. A failure other than not-found (a bad token, an unreachable host) fails the command. Read only. A toil project has one `ado` section, so it picks one Azure DevOps connection: a body of work on both Server and Services takes two toil projects.

## Notes

- `toil connections test` reads the collection's connection data (or the list of
  collections when no collection is set) on Server, and the organization's connection
  data, which names the token's own user, on Services.
- A 429 is retried after the delay Azure DevOps asks for, as in every area.
- Not covered on Services yet: pipelines and builds, attachments, work item types and
  fields, areas, links, tags, team capacity and settings changes, and PR files and
  diffs. `ado api` reaches all of them.

## Moving from `ado-cloud`

Azure DevOps Services used to be its own area. It is `ado` with `"deployment": "cloud"`
now, and the old names are gone, not deprecated:

- **Config:** a version 1 or 2 file loads as it is: a connection with `"area": "ado-cloud"`
  is read as `"area": "ado", "deployment": "cloud"`, and `defaults.ado-cloud` folds into
  `defaults.ado` with care, because `defaults.ado` reaches every Azure DevOps connection
  (the same rules as Jira's fold: a Services default for another key moves to `defaults.ado`
  only when no Server connection would inherit it, and what `defaults.ado` already said is
  written onto the Server connections instead of reaching the Services ones). Any command
  that saves a connection writes the file back as version 3. Keychain entries are untouched.
- **`CONFIG_DEFAULT_KEPT`:** when both areas named a default connection, `ado`'s stays
  the default and the warning names the Services one that was set aside. `toil connections migrate`
  saves the file as version 3 and clears it.
- **Commands and tools:** the `ado-cloud` command path is `ado` (use `--connection`, or make
  the Services connection the default), the `ado_cloud_*` tools are `ado_*`, and `--areas
  ado-cloud` is `--areas ado`. The old forms fail with `INVALID_INPUT` naming the new one.
- **Env vars:** `TOIL_ADO_CLOUD_*` is refused with `CONFIG_INVALID`; use `TOIL_ADO_*` with
  `TOIL_ADO_DEPLOYMENT=cloud`, or `TOIL_CONN_<NAME>_*` with `TOIL_CONN_<NAME>_DEPLOYMENT=cloud`.
  `TOIL_CONN_<NAME>_AREA=ado-cloud` is refused the same way. An empty `TOIL_ADO_CLOUD_*` is
  skipped unless `TOIL_STRICT_ENV=true`, which refuses it too (see `core.md`,
  **Configuration**). In an Azure Pipelines step, set `TOIL_ADO_DEPLOYMENT: cloud` beside
  `TOIL_ADO_PAT` and `TOIL_ADO_BASE_URL`.
- **Old `TOIL_ADO_*` values on a Services default:** `TOIL_ADO_*` reaches ado's default
  connection. When that connection is Services (a migrated `ado-cloud` one, or `deployment`
  set in `defaults.ado`) and `TOIL_ADO_DEPLOYMENT` isn't set, the call fails with
  `CONFIG_INVALID` naming the variables, so Server values and a token never land on a
  Services organization by accident. Set `TOIL_ADO_DEPLOYMENT=cloud` if the values are
  Services ones, or define a separate Server connection with `TOIL_CONN_<NAME>_*`.
- **`SYSTEM_ACCESSTOKEN`:** read for a Server default only. A Services default connection
  ignores it.
- **Toil projects:** an `ado-cloud` section is read as `ado` (also under an environment and in a
  person's `ids`), with a `TOIL_PROJECT_RENAMED_AREA` warning to rename it. With both, `ado`
  wins. Transition pins are `ado.transitions`.
- **Flags and codes:** `--creator` and `--reviewer` take `<id>` (they always did; Server's
  help called it an alias). The Services warning codes `ADO_CLOUD_WORK_ITEMS_MISSING`,
  `ADO_CLOUD_TYPE_UNKNOWN` and `ADO_CLOUD_DEFAULT_TEAM` are `ADO_WORK_ITEMS_MISSING`,
  `ADO_TYPE_UNKNOWN` and `ADO_DEFAULT_TEAM`.
