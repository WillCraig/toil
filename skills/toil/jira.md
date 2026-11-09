---
area: jira
description: Issues, JQL search, transitions, comments, worklogs, labels, links, attachments, custom fields, projects, users, boards and sprints on Jira Data Center and Jira Cloud
---

# Jira (`jira`)

Issues, JQL search, transitions, comments, worklogs, labels, links, attachments,
custom fields, projects, users, boards and sprints on **Jira Data Center / Server**
(`/rest/api/2` and `/rest/agile/1.0`) and **Jira Cloud** (`https://<your-site>.atlassian.net`,
REST API 3 and the Agile REST API 1.0). One command tree and one set of MCP tools serve
both; each call goes to the deployment of the connection it resolves. Verification
level: `unit` for both. Data Center's behavior is the one the command contract records;
Cloud was built from Atlassian's API documentation and has never run against a live site.

**Supported versions:** Jira Data Center 8.14 or later (REST API 2 and Agile REST API 1.0). toil
authenticates to Data Center with a personal access token, which Jira Data Center added in
8.14. No release has been verified yet. Jira Cloud (a connection with `deployment` cloud) is
always current: toil calls REST API 3 (`/rest/api/3`, with the enhanced JQL search at
`/rest/api/3/search/jql`) and the Agile REST API 1.0, with an Atlassian account email and API
token sent as Basic auth. Nothing has been run against a live Cloud site yet.

## Data Center and Cloud

A connection says which one it is with `deployment`: `server` for Data Center (the
default) or `cloud`. The two keep separate API code and each returns **its own API's
shape**, unchanged; `meta.context.connection.deployment` says which one ran. What differs:

| | Data Center | Cloud |
|---|---|---|
| Credential | personal access token, `Authorization: Bearer` | account `email` + API token, Basic auth |
| People | usernames (`--assignee jsmith`, `user` fields send `{ "name": … }`) | **accountIds** (`--assignee 5b10ac8d82e05b22cc7d4ef5`, `user` fields send `{ "accountId": … }`) |
| Rich text | strings (wiki markup) | Atlassian Document Format (ADF), plain text in, `…Text` beside it out |
| `issue search` | `{ issues, total, startAt, maxResults }`, `--start-at` | `{ issues, maxResults, isLast }`, no total, no `--start-at` |
| `issue log-work --started` | optional, defaults to now | required |
| Only here | `api` | `project list`, `project get`, `user search`, `sprint get`, `sprint create`, `sprint update`, `sprint start`, `sprint complete` |

A call the connection's deployment can't serve fails **before any request** with
`UNSUPPORTED`, saying which deployment and what to do: `jira api` or `--start-at` on a
Cloud connection, `jira project list`, `user search` or `sprint create` on a Data Center one. The error
names the connections you have that can run it. `--assignee` is one flag whose value is a
username on Data Center and an accountId on Cloud.

## Credential

**Data Center:** a Jira **personal access token**: in Jira, your profile picture → Profile →
Personal Access Tokens → Create token. toil sends it as `Authorization: Bearer <token>`.
There is no username, password or browser login.

**Cloud:** an **Atlassian account API token** plus that account's **email address**. Create
the token at https://id.atlassian.com/manage-profile/security/api-tokens (Atlassian
account → Security → API tokens → Create API token). toil sends
`Authorization: Basic base64(<email>:<apiToken>)`, as Atlassian documents for scripts.
There is no password, OAuth app or browser login. The token acts with the account's own
permissions, so a read sees what that account can see.

If the email and token don't match, Jira Cloud may treat the call as anonymous rather than
refuse it: a 401 is `AUTH`, but a missing issue can also surface as `NOT_FOUND`, and a
search as no results. When a call that should work finds nothing, check `email` first.

## Configuration

| Key | Env var | Required | Meaning |
|-----|---------|----------|---------|
| `baseUrl` | `TOIL_JIRA_BASE_URL` | yes | Data Center: the server root, e.g. `https://jira.imagile.dev` (keep any context path, e.g. `https://jira.imagile.dev/jira`). Cloud: the site root, `https://<your-site>.atlassian.net` |
| `apiToken` | `TOIL_JIRA_API_TOKEN` | yes | Data Center: personal access token. Cloud: Atlassian account API token (a secret) |
| `deployment` | `TOIL_JIRA_DEPLOYMENT` | no | `server` (Data Center, the default) or `cloud` |
| `email` | `TOIL_JIRA_EMAIL` | Cloud | Email address of the Atlassian account the token belongs to; Cloud only |
| `customFields` | `TOIL_JIRA_CUSTOM_FIELDS` (JSON) | no | Custom fields addressable by friendly name; see **Custom fields** |
| `project` | `TOIL_JIRA_PROJECT` | no | Default project for `issue create` |
| `issueType` | `TOIL_JIRA_ISSUE_TYPE` | no | Default issue type for `issue create` (`Task` when unset) |
| `priority` | `TOIL_JIRA_PRIORITY` | no | Default priority for `issue create` |
| `writes` | `TOIL_JIRA_WRITES` | no | `true` lets write commands run (with `--allow-write`) |

Environment variables (CI, or a one-off shell):

```bash
# Data Center
export TOIL_JIRA_BASE_URL=https://jira.imagile.dev
export TOIL_JIRA_API_TOKEN=<your personal access token>

# Cloud
export TOIL_JIRA_DEPLOYMENT=cloud
export TOIL_JIRA_BASE_URL=https://jira-cloud.imagile.dev
export TOIL_JIRA_EMAIL=you@example.com
export TOIL_JIRA_API_TOKEN=<your API token>
```

The examples use the placeholder hosts `jira.imagile.dev` and `jira-cloud.imagile.dev`,
which never resolve; your own is `https://<your-site>.atlassian.net`. The Cloud variables
were `TOIL_JIRA_CLOUD_*` before config version 3; those are refused now, with the name to
use instead (see **Moving from `jira-cloud`**).

Or `~/.toil/config.json`, with `project`, `issueType` and `priority` usually set once under
`defaults.jira` so every Jira connection shares them:

```json
{
  "version": 3,
  "connections": {
    "corp-jira": { "area": "jira", "baseUrl": "https://jira.imagile.dev", "writes": true },
    "imagile-cloud": { "area": "jira", "deployment": "cloud", "baseUrl": "https://jira-cloud.imagile.dev", "email": "you@example.com", "writes": true }
  },
  "defaults": { "jira": { "connection": "corp-jira", "project": "ABC", "issueType": "Story" } }
}
```

The token never goes in this file; a plaintext one there is refused with
`CONFIG_INVALID`. Run `toil connections add corp-jira --area jira` (or
`toil connections login corp-jira` for an existing connection) to keep it in the OS
credential store, which writes `"apiToken": "keychain:…"`, or set `TOIL_JIRA_API_TOKEN`.

Env vars always win over the file. Another Jira is another connection, chosen per call
with `--connection imagile-cloud`, or configured from env with
`TOIL_CONN_IMAGILE_CLOUD_AREA=jira`, `TOIL_CONN_IMAGILE_CLOUD_DEPLOYMENT=cloud` plus
`TOIL_CONN_IMAGILE_CLOUD_BASE_URL`, `TOIL_CONN_IMAGILE_CLOUD_EMAIL` and
`TOIL_CONN_IMAGILE_CLOUD_API_TOKEN`. A `defaults.jira` setting reaches the connections of
both deployments.

## Commands

Every command also takes `--connection <name>`. Write commands (marked ✎) need
`writes: true` on the connection **and** `--allow-write`; over MCP they are only
listed when writes are on, and `allowWrite: true` stands in for the flag.

| Command | Arguments and flags | Returns |
|---------|-------|---------|
| `issue get` | `<key...>` (up to 100) | The issue as Jira returns it; registered custom fields under their friendly names. On Cloud plus `descriptionText`. With several keys, `{ issues, errors }` |
| `issue history` | `<key> --limit --cursor` | The issue's change history: `id`, `author`, `created`, `items` |
| `issue create` ✎ | `--project --type --summary --description --priority --assignee <user> --labels --parent --field (repeatable) --fields-file --input-file` | The created issue, read back (on Cloud plus `descriptionText`) |
| `issue update` ✎ | `<key> --summary --description --priority --assignee <user> --labels --field --fields-file --input-file` | `{ updated }` |
| `issue schema` | `--deployment <server\|cloud> --example-only` | `{ schema, example }` for `--input-file`, or just the example; needs no connection, so it takes the deployment as a flag (Data Center by default) |
| `issue transition` ✎ | `<key> --transition <name-or-id>` or `--to <intent-or-status>` | `{ transitioned, transition }`; with `--to`, `meta.transition` says what it resolved to |
| `issue transitions` | `<key>` | Transitions available now |
| `issue comment` ✎ | `<key> --body` | The comment (on Cloud plus `bodyText`) |
| `issue comments` | `<key> --limit --cursor` | Every comment, or a page of them (on Cloud each with `bodyText`) |
| `issue log-work` ✎ | `<key> --time-spent --comment --started` | The worklog (on Cloud plus `commentText`) |
| `issue search` | `--jql` or `--jql-file`, `--limit --start-at --cursor --updated-since --changelog --fields` | Data Center: `{ issues, total, startAt, maxResults }`. Cloud: `{ issues, maxResults, isLast }`. `--start-at` is Data Center only |
| `issue label` ✎ / `issue unlabel` ✎ | `<key> --labels a,b` | `{ updated, labelsAdded }` / `{ updated, labelsRemoved }` |
| `issue assign` ✎ | `<key> --assignee <user>` | `{ assigned, assignee }`: a username on Data Center, an accountId on Cloud |
| `issue link` ✎ | `<key> --target --type` | `{ linked, to, type }` |
| `issue attach` ✎ | `<key> --file` | The attachments created |
| `issue attachments` | `<key>` | Attachments (id, filename, size, mimeType, content) |
| `issue download` | `<key> <attachment-id> --dir` | `{ saved, filename, size }`; saves to `.toil/` by default |
| `issue fields` | `--discover --custom-only --project --issue-type` | Registered fields, or Jira's field list with `suggestedType` and `allowedValues` |
| `field discover` | `--project <key>` (`--per-type 1-3`, `--limit`) or `--issue <key>` (repeatable) | `{ issueTypes, fields, commands }`: per issue type, the custom fields that hold a value on the sample, each with an example, an alias and the OWI field it likely is; see **Finding custom fields** |
| `issue set-sprint` ✎ | `<key> --sprint <id>` | `{ updated, sprint }` |
| `project list` (Cloud) | `--query --limit --cursor` | Every visible project, or a page of them |
| `project get` (Cloud) | `<project>` | The project |
| `user search` (Cloud) | `--query --limit --cursor` | One page of matching users, with `accountId` |
| `board list` | `--project --limit --cursor` | Boards (id, name, scrum or kanban) |
| `sprint list` | `--board` or `--project`, `--state active,future,closed`, `--limit --cursor` (with `--board`) | Sprints with dates and goal |
| `sprint get` (Cloud) | `<sprint>` | The sprint as Jira returns it (state, dates, goal, board) |
| `sprint create` ✎ (Cloud) | `<name> --board <id> --start --end --goal` | The new sprint, state `future` |
| `sprint update` ✎ (Cloud) | `<sprint> --name --start --end --goal` | The sprint; only what you pass changes |
| `sprint start` ✎ (Cloud) | `<sprint> --start --end` | The now active sprint; start defaults to now, end to its planned end |
| `sprint complete` ✎ (Cloud) | `<sprint> --move-open-to <sprint\|backlog>` | `{ sprint, moved, movedTo }`; issues not done move first, then the sprint closes |
| `api` (Data Center) | `<method> <path> --query key=value (repeatable) --body-file --content-type` | The response body; see **Any endpoint** below. ✎ for `POST`, `PUT`, `PATCH`, `DELETE` |
| `check-toil-project` | `--toil-project <name\|file>` (or the folder's toil project) | `{ toil project, connection, env, ok, checked, checks, unchecked }`: each project and field id the toil project names, found or not; exit 1 when one is missing |

Over MCP the same commands are tools named after the path, with spaces and
hyphens as underscores (`jira_issue_get`, `jira_sprint_list`,
`jira_issue_log_work`), taking camelCase fields named after the arguments and
flags (`key`, `issueType`, `limit`, `attachmentId`). Cloud has no tools of its own
(`jira_cloud_*` is gone): the same tool runs on the connection you name.

## Examples

```bash
toil jira issue get ABC-123
toil jira issue search --jql 'project = ABC AND status = "In Progress"' --limit 20
toil jira issue search --jql-file query.jql --fields summary,status,"Story Points"
toil jira issue create --project ABC --type Bug --summary "Login broken on Safari" --priority High --allow-write
toil jira issue transition ABC-123 --transition "In Progress" --allow-write
toil jira issue transition ABC-123 --to review --allow-write
toil jira issue comment ABC-123 --body "Reproduced on staging." --allow-write
toil jira issue log-work ABC-123 --time-spent "2h 30m" --comment "Investigated the failing build" --allow-write
toil jira issue link ABC-123 --target ABC-456 --type Blocks --allow-write
toil jira sprint list --project ABC --state active,future
toil jira issue set-sprint ABC-123 --sprint 42 --allow-write
toil jira issue download ABC-123 10001 --dir downloads
toil jira field discover --project ABC --per-type 1
```

On a Cloud connection, name it (or make it the default) and mind the differences above:

```bash
toil jira user search --query smith --connection imagile-cloud
toil jira issue create --connection imagile-cloud --project PROJ --type Bug --summary "Login broken" --description "Open the login page in Safari; the button does nothing." --assignee 5b10ac8d82e05b22cc7d4ef5 --allow-write
toil jira issue log-work PROJ-123 --connection imagile-cloud --time-spent "2h 30m" --started 2026-01-15T09:00:00.000+0000 --allow-write
toil jira project get PROJ --connection imagile-cloud
toil jira sprint create "Sprint 7" --board 1 --start 2026-11-02 --end 2026-11-16 --connection imagile-cloud --allow-write
toil jira sprint start 7 --connection imagile-cloud --allow-write
toil jira sprint complete 7 --move-open-to backlog --connection imagile-cloud --allow-write
toil jira sprint list --project PROJ --state active --connection imagile-cloud
```

`issue search` without `--limit` pages through every match, so bound broad queries.

## People: usernames and accountIds

On **Data Center**, `--assignee` is a username (`jsmith`). On **Cloud** it is an
**accountId**, never a username or email: Jira Cloud has no usernames in its API. Find
one with `user search --query <name or email>`. People in Cloud output (`assignee`,
`reporter`, `author`) carry `accountId` and `displayName`; an email address appears only
where the person's profile settings allow it.

## Rich text on Cloud (ADF)

On Data Center a description or comment is a string. On Cloud a description, a comment
body and a worklog comment are ADF documents. toil converts them simply, and no more:

- **In** (`--description`, `--body`, `--comment`): plain text. A blank line starts a
  new paragraph; a single line break becomes a hard break. Markdown, wiki markup and
  HTML are **not** interpreted: `**bold**` arrives as those characters. A line break
  has to be a real one: in bash, `$'one\ntwo'`; `\n` inside ordinary quotes is two
  characters.
- **In, from `--input-file`**: `fields.description` may also be an ADF document
  object (`{ "type": "doc", ... }`), sent as it is, for formatting plain text can't
  carry.
- **Out**: Jira's ADF is returned untouched (`fields.description`, `body`,
  `comment`), and a plain-text rendering sits beside it: `descriptionText` on an issue
  (`null` when it has no description), `bodyText` on each comment and `commentText` on
  a worklog. Formatting is dropped; text, mentions, emoji, links, dates, list items
  (`- `, `1. `) and table cells (`a | b`) keep their words.

## Search and paging

```bash
toil jira issue search --jql 'project = ABC' --limit 100
toil jira issue search --jql 'project = ABC' --limit 100 --cursor 100
toil jira issue search --jql 'project = ABC ORDER BY updated' --updated-since 2026-10-01T09:30:00Z
toil jira issue history ABC-123
toil jira issue get ABC-1 ABC-2 ABC-7
toil jira issue comments ABC-123 --limit 50
```

These are what a sync needs: read everything once, then only what changed.

- **Paging.** Every list and search pages the same way. Without `--limit`, it
  returns every item. With one, it returns that many and `meta.page.nextCursor`
  says where the next page starts; pass it back as `--cursor`, unchanged. `null`
  means that was the last page. `issue transitions`, `issue attachments` and
  `issue fields` have no paging, because Jira sends each of them whole.
  `sprint list` pages only with `--board`, since `--project` gathers sprints
  from several boards. On Data Center `meta.page.nextCursor` is also the `--start-at`
  for the next page.
- **Cloud's search** is the enhanced JQL search, which pages by token and reports **no
  total**. With `--limit N` it returns at most N, `isLast` says whether that was all, and
  the cursor (with `--limit`) resumes it. `maxResults` in `data` is how many issues came
  back. `--start-at` doesn't exist there, since the API has no offsets. `--fields` takes
  field ids or registered names; the default is summary, status, priority, assignee,
  issuetype, project, created, updated, labels, reporter and every registered custom field.
  `user search` is always one page; a full page hands out a cursor, which may lead to an
  empty one.
- **`--updated-since <iso>`** on `issue search` adds `updated >= "<instant>"` to the JQL,
  before any `ORDER BY`, with your JQL in parentheses. The instant is an ISO 8601
  date (`2026-10-01`, read as midnight UTC) or a date and time with a zone
  (`2026-10-01T09:30:00Z`). JQL has no time zones, so toil reads your profile's
  zone from `/rest/api/2/myself` (`/rest/api/3/myself` on Cloud) and writes the instant
  in it, rounded down to the minute; an issue near the boundary can come back twice, never
  not at all. If Jira names no zone it knows, toil writes UTC and warns with
  `JIRA_TIME_ZONE` (`JIRA_CLOUD_TIME_ZONE` on Cloud). On its own, `--updated-since` is the
  whole query.
- **`--changelog`** on `issue search` returns each issue with its change history inline
  (`changelog: { startAt, maxResults, total, histories }`), so reading the history of many
  issues is one search instead of one `issue history` call per issue. It is Jira's own
  changelog, in the order Jira sends it (Cloud: newest first, at most 20 entries;
  `jira issue history` reads the whole history, oldest first). It sends `expand=changelog`
  (`"expand": ["changelog"]` in the Data Center POST body, `"expand": "changelog"` in
  Cloud's). A `JIRA_CHANGELOG_TRUNCATED` warning (`JIRA_CLOUD_CHANGELOG_TRUNCATED` on Cloud)
  names issues that may be cut short, how many of the issues: `total` is more than the
  entries sent, the entries fill the page, or Jira sent no `total` or `maxResults`; toil
  leaves the data as Jira sent it, and `issue history <key>` reads the whole history of one.
  Without the flag nothing changes.
- **`issue history`** returns the history entries Jira records for an issue, each
  with `id`, `author`, `created` and `items` (`field`, `fieldtype`, `from`,
  `fromString`, `to`, `toString`, and `fieldId` on Cloud). Data Center sends the history
  with the issue (`expand=changelog`), all at once, and `--limit` / `--cursor` page it. If
  Jira reports more entries than it sent, a `JIRA_CHANGELOG_TRUNCATED` warning says so.
  Cloud reads `/rest/api/3/issue/{key}/changelog`, oldest first, with `author` an
  `accountId`.
- **Several issues.** Give `issue get` several keys (up to 100) and it returns
  `{ issues, errors }`: the issues in the order you asked, and each key that couldn't
  be read as `{ key, code, message }` (`NOT_FOUND`, or `HTTP` for another refusal),
  with a `JIRA_BULK_PARTIAL` warning (`JIRA_CLOUD_BULK_PARTIAL` on Cloud). A rejected
  token or a network failure fails the whole call. Data Center has no bulk endpoint,
  so toil sends one request per key, five at a time. Cloud reads them in one
  `POST /rest/api/3/issue/bulkfetch`, with never more than one error per key: Jira
  leaves out a key it can't find or won't show, returns a moved issue under its new
  key, and names an issue it couldn't fetch only by id. A key asked for by id that Jira
  couldn't fetch is `HTTP` with Jira's message. A key with no answer is `NOT_FOUND`
  when everything else Jira sent is accounted for; otherwise it's `UNMATCHED`, with a
  message naming the issues returned under other keys and the ids Jira couldn't fetch,
  since the answer doesn't say which is which. Issues returned under another key still
  come back, after the others. One key returns the issue itself. Over MCP, `key` takes a
  string or a list.

`issue create` takes its project from `--project`, then `project` in `--input-file`, then
the connection's `project`, and `meta.context.inputs.project` says which: `input` for
the flag or the file, `connection` for the setting (`TOIL_JIRA_PROJECT` and
`defaults.jira.project` both report `connection`, not `default`). The `--project` on `issue fields`,
`board list` and `sprint list` never falls back to the connection.
`--time-spent` takes Jira durations (`1d`, `2h 30m`); `--started` takes Jira's datetime
format (`2024-01-15T09:00:00.000+0000`) and defaults to now on Data Center. Cloud requires it.

## Any endpoint: `jira api` (Data Center)

When no command above covers an endpoint, `jira api` calls it directly. It sends
the connection's own credential, the same way every other `jira` command does,
to a path under the connection's `baseUrl`. It is Data Center only: on a Cloud
connection it fails with `UNSUPPORTED` before anything is sent.

```bash
toil jira api GET /rest/api/2/myself
toil jira api GET /rest/api/2/issue/ABC-123/remotelink
toil jira api GET /rest/agile/1.0/board/12/backlog --query fields=summary --query maxResults=20
toil jira api POST /rest/api/2/version --body-file version.json --allow-write
toil jira api PUT /rest/api/2/issue/ABC-123/watchers --body-file user.json --content-type application/json --allow-write
```

- **The path** is relative to `baseUrl` (a context path such as `/jira` is kept),
  with or without a leading `/` (in Git Bash on Windows, leave it off: the shell
  rewrites `/rest/...` into a file path, which is refused). A full URL, a scheme, `//host`, a leading
  backslash or a `.` / `..` segment is refused with `INVALID_INPUT` before anything
  is sent, so the token never leaves the connection's host.
- **The method decides the gate.** `GET` and `HEAD` are reads. `POST`, `PUT`,
  `PATCH` and `DELETE` are writes: they need `writes: true` on the connection
  **and** `--allow-write`. `DELETE` works only on the CLI: over MCP, `jira_api`
  refuses it with `INVALID_INPUT`.
- **`--query key=value`** adds a query parameter; repeat it for more, or to repeat
  a key. **`--body-file <path>`** sends that file (inside the workspace, or `-` for
  stdin) as the body, as `application/json` unless `--content-type` says
  otherwise.
- **Output:** a JSON body is `data`, parsed. A text body (`text/*`, XML, or no content
  type) is `data` as text. Any other body is binary: `data` is its bytes as base64,
  with an `API_BINARY` warning (use `issue download` to save an attachment).
  Text and binary are capped at 1 MB, with an `API_TRUNCATED` warning when the body
  was longer. An empty body (a `204`,
  a `HEAD`) is `null`. `meta.response` is `{ status, contentType }`. Errors use the
  usual codes (`AUTH`, `NOT_FOUND`, `HTTP`, `NETWORK`) with Jira's own message. A
  body labelled JSON that doesn't parse comes back as text, with an `API_NOT_JSON`
  warning.
- **Over MCP** it's the `jira_api` tool, with `method`, `path`, `query` (an array of
  `key=value` strings), `bodyFile`, `contentType` and `allowWrite`.

Prefer a wrapped command when one exists: it knows the endpoint's paging, custom
fields and quirks, and `jira api` doesn't.

## Large fields via --input-file

`issue create` and `issue update` take `--input-file <path>` (`-` reads stdin on the
CLI) describing the issue as `{ project, issueType, fields: { ... } }`.
`toil jira issue schema` returns its JSON Schema and an example (`--deployment cloud` for
Cloud's, whose descriptions may be ADF and whose people are accountIds). Any string value in
`fields` may be `@path/to/file` to read it from a file. Flags override matching keys from the
file, and each override is reported in `meta.warnings` (`JIRA_CLOUD_INPUT_OVERRIDDEN` on
Cloud).

```bash
toil jira issue schema --example-only > envelope.json   # the example is in .data
toil jira issue schema --deployment cloud --example-only > cloud-envelope.json
toil jira issue create --input-file issue.json --priority Low --allow-write
```

Over MCP, `-` is refused because stdin carries the protocol; pass a file path.
Relative paths resolve against the directory toil runs in.

## Custom fields

`--field Name=value` (repeatable), `--fields-file` and `--input-file` accept a raw field
id (`customfield_10032`) or a standard field name (`fixVersions`) with no setup.
`Name=@file.json` reads the value from a file: JSON when it parses, text otherwise, which
also avoids shell quoting trouble in PowerShell.

To use a **friendly name** in flags, JQL and output, register the field on the
connection:

```json
"customFields": [{ "id": "customfield_10016", "name": "Story Points", "type": "number" }]
```

`type` shapes a `--field` value: `string`, `number`, `date`, `datetime`, `select`
(`{value}`), `multi-select`, `option-id` (`{id}`), `cascading-select` (`parent` or
`parent:child` ids), `user` (`{name}` on Data Center, `{accountId}` on Cloud), `multi-user`
(Cloud only: comma-separated accountIds, `[{accountId}]`), `labels`, `url`, `textarea` (on
Cloud, plain text sent as ADF, since a multi-line text field takes ADF there). Omit it to send
the raw string; a value in `--fields-file` or `--input-file` is sent untouched, so a
multi-line text field there needs ADF on Cloud. `toil jira issue fields --discover` lists
Jira's fields with a `suggestedType`; add `--project ABC` to see each select field's
`allowedValues`. A select field that only accepts option ids needs `"type": "option-id"`.
**Sprint is not a custom field**: use `issue set-sprint` after the issue exists; on Cloud the sprints themselves are made and run with `sprint create`, `start` and `complete`.

**Finding custom fields.** `toil jira field discover --project ABC` reads the most recently
updated issue of each issue type (at most 12 types, one search each, `--limit` fewer;
`--per-type` up to 3 issues of each) and reports, per issue type, the custom fields that
hold a value on it: id, name, schema, an example of at most 80 characters (a person shows
as `(a person)`, rich text as `(rich text)`), a suggested camelCase `alias`, and `owi`, the
Open Work Item field it likely is (`iteration` for Jira Software's Sprint, `estimate` for
Story Points or Story point estimate, `team`, `dueDate`) with `confidence` `high` or
`medium` and why. `--issue ABC-123 --issue ABC-456` reads those issues instead. An issue
type with no issue to read has `status: "no-sample"` and `fields: null`: that is unknown,
not "no custom fields" (`[]`). More types than `--limit` allows give a
`JIRA_DISCOVER_TRUNCATED` warning naming the ones left out. `commands` holds the
`toil projects field` lines for the high-confidence fields: the alias, then the OWI key
(`estimate`, `iteration`) pointed at the same id with `--replace`. It reads only and never
runs them: copy the ones you want, or tick them in Toil UI's **Find the fields**. Naming a
field in a toil project does not make `issue search` return it; that still takes the field
in the connection's `customFields`, or `--fields`.

A **toil project** can name fields too (`"jira": { "fields": { "storyPoints": "customfield_10016" } }`,
or `toil projects field <toil project> jira storyPoints customfield_10016`). Then
`issue create` and `issue update` take `--field storyPoints=5` in any folder the toil project
applies to. An alias takes the type the connection registers for that id. A name the
connection already uses keeps the connection's meaning.

## Moving from `jira-cloud`

Jira Cloud used to be its own area. It is `jira` with `"deployment": "cloud"` now, and the
old names are gone, not deprecated:

- **Config:** a version 1 or 2 file loads as it is: a connection with `"area": "jira-cloud"` is
  read as `"area": "jira", "deployment": "cloud"`, and `defaults.jira-cloud` folds into
  `defaults.jira` with care, because `defaults.jira` reaches every Jira connection. The
  connection default folds as is. A Cloud default for another key (`project`) moves to
  `defaults.jira` only when no Data Center connection would inherit it, and is otherwise
  written onto the Cloud connections. In the other direction, when a file has both moved
  Cloud connections and Data Center ones, each shared key `defaults.jira` already had
  (`project`, `issueType`, `priority`, `customFields`) is written onto the Data Center
  connections and leaves `defaults.jira`, so it doesn't start reaching Cloud. Any command
  that saves a connection writes the file back as version 3 (so does the welcome menu's game
  save). Keychain entries are untouched. A version 3 file that still says
  `"area": "jira-cloud"` is folded too, with a `CONFIG_RENAMED_AREA` warning naming the new form.
- **`CONFIG_DEFAULT_KEPT`:** when both areas named a default connection, `jira`'s stays the
  default and the warning names the Cloud one that was set aside. `toil connections migrate`
  saves the file as version 3 and clears the warning.
- **Toil UI and older toil:** a version 3 file is refused by toil 0.1.0-beta.2, so toil UI's pin
  moves to the toil release that has this change.
- **Commands and tools:** the `jira-cloud` command path is `jira`, the `jira_cloud_*` tools are
  `jira_*`, and `--areas jira-cloud` is `--areas jira`. The old forms fail with
  `INVALID_INPUT` naming the new one.
- **Env vars:** `TOIL_JIRA_CLOUD_*` is refused with `CONFIG_INVALID`; use `TOIL_JIRA_*` with
  `TOIL_JIRA_DEPLOYMENT=cloud`, or `TOIL_CONN_<NAME>_*` with `TOIL_CONN_<NAME>_DEPLOYMENT=cloud`.
  `TOIL_CONN_<NAME>_AREA=jira-cloud` is refused the same way, with `TOIL_CONN_<NAME>_AREA=jira`
  and `TOIL_CONN_<NAME>_DEPLOYMENT=cloud` as the fix. An empty `TOIL_JIRA_CLOUD_*` is skipped
  unless `TOIL_STRICT_ENV=true`, which refuses it too (see `core.md`, **Configuration**).
- **Old `TOIL_JIRA_*` values on a Cloud default:** `TOIL_JIRA_*` reaches jira's default
  connection. When that connection is Cloud (a migrated `jira-cloud` one, or `deployment`
  set in `defaults.jira`) and `TOIL_JIRA_DEPLOYMENT` isn't set, the call fails with
  `CONFIG_INVALID` naming the variables, so Data Center values and a token never land on a
  Cloud site by accident. Set `TOIL_JIRA_DEPLOYMENT=cloud` if the values are Cloud ones, or
  define a separate Data Center connection with `TOIL_CONN_<NAME>_*`. `TOIL_CONN_<NAME>_*`
  is never affected.
- **Toil projects:** a `jira-cloud` section is read as `jira` (also under an environment and in a
  person's `ids`), with a `TOIL_PROJECT_RENAMED_AREA` warning to rename it (`toil projects check`
  reports it). With both, `jira` wins. A toil project has one `jira` section, so it picks one Jira
  connection: a body of work that uses both a Data Center and a Cloud Jira takes two toil projects.

## Ticket the work

Before starting work no ticket covers, rank your open issues against it:

```bash
toil jira issue search --jql "assignee = currentUser() AND statusCategory != Done" --fields summary,description,status,issuetype,labels,parent | toil util owi map | toil util owi similar --query "Card payments time out at checkout"
```

Then ask the person, as `core.md`, **Ticket the work**, says: attach the work to a
match (nothing is written), create a sub-task under it, or create a new ticket. A
sub-task is
`toil jira issue create --type Sub-task --parent PAY-12 --summary "<text>" --allow-write`
(the project may name the type differently, `Subtask` on Cloud); a new ticket takes the project and type
from the toil project and the connection. Both are writes, made only on the person's yes.

## Notes

- `issue create` doesn't check for duplicates. After a timeout, search for the summary
  before retrying: the issue may already exist.
- `issue update` with nothing to change still sends an empty update and reports
  `{ updated }` on Data Center; on Cloud it is `INVALID_INPUT` and nothing is sent.
- `issue download` never replaces a file. If one of the same name is already in the target directory, it fails with `INVALID_INPUT`; delete the file or pass a different `--dir`.
- `issue download` saves a name Windows would read as another file under one it won't: a device name such as `CON` or `nul.txt` gets a leading `_`, a `:` and what follows it is dropped, as are trailing dots and spaces, and the characters Windows forbids become `_`. `filename` is still the name Jira gave; `saved` is where the file went. The same holds on every platform.
- `issue download` only ever sends the token to `baseUrl`'s host. If Jira names
  another host for the file, toil fetches the same path from `baseUrl` and warns. On Cloud it
  asks for the bytes with `GET /rest/api/3/attachment/content/<id>?redirect=false`, so the
  request never leaves your site; `issue attach` uploads as multipart with
  `X-Atlassian-Token: no-check`.
- `sprint start` refuses a sprint that isn't `future` and one with no end date (Jira
  needs both dates); `sprint complete` refuses one that isn't `active`. `complete` with
  `--move-open-to` lists the issues whose status category isn't Done, moves them (50 a
  call) to the sprint or backlog, then closes the sprint, so a failed close leaves them
  already moved. Without it the open issues stay attached to the closed sprint: Jira moves nothing when the API completes one (checked on Cloud). Jira may refuse a second
  active sprint on one board, and that message is the command's error. None of these
  deletes anything, so they are all on MCP.
- `sprint list --project` on Cloud reads scrum and team-managed (`simple`) boards and skips
  kanban ones. A team-managed board whose project hasn't turned sprints on answers 400;
  it's skipped with a `JIRA_CLOUD_NO_SPRINTS` warning naming it. Any other failure is
  the command's error.
- `issue transition` and `issue link` treat an all-digits value as an id and anything
  else as a name (case-insensitive), looked up first, on Cloud.
- Issue keys and ids are sent as one URL path segment each, encoded, so a `/` or `?` in
  one can't change the endpoint called. A project key from `--project`, the
  connection's `project` setting, a toil project or `--input-file` that holds `/`, `\`, `?`,
  `#`, `%` or a control character is refused with `INVALID_INPUT`.
- A 429 is retried after the delay Jira asks for, as in every area.

## Checking a toil project

`check-toil-project` checks the call's toil project: each project key it names (`project`, `projects`) exists, and each field alias in `fields` names a field id Jira has. It's `toil jira check-toil-project` (`--toil-project <name|file>`, or the toil project the folder resolves to), and it returns `{ toil project, connection, env, ok, checked, checks, unchecked }`, one check per value with its key path. The CLI exits 1 when one is missing. A failure other than not-found (a bad token, an unreachable host) fails the command. Read only.
