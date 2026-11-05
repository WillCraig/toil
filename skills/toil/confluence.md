---
area: confluence
description: Pages, spaces, CQL search, comments, labels and attachments on Confluence Data Center and Confluence Cloud
---

# Confluence (`confluence`)

Pages, spaces, CQL search, comments, labels and attachments on **Confluence Data Center /
Server** (the Server REST API under `/rest/api`) and **Confluence Cloud**
(`https://<your-site>.atlassian.net`, REST API v2, with v1 where v2 has no endpoint). One
command tree and one set of MCP tools serve both; each call goes to the deployment of the
connection it resolves. Verification level: `unit` for both. Data Center's behavior is the
one the command contract records; Cloud was built from Atlassian's API documentation and has
never run against a live site.

**Supported versions:** Confluence Data Center 7.9 or later (Server REST API). toil authenticates to Data Center with a personal access token, which Confluence Data Center added in 7.9. No release has been verified yet. Confluence Cloud (a connection with `deployment` cloud) is always current: toil calls REST API v2 (`/wiki/api/v2`) and, where v2 has no endpoint, v1 (`/wiki/rest/api`: CQL search, adding and removing labels, attachment uploads), with an Atlassian account email and API token sent as Basic auth. Nothing has been run against a live Cloud site yet.

## Data Center and Cloud

A connection says which one it is with `deployment`: `server` for Data Center (the
default) or `cloud`. The two keep separate API code and each returns **its own API's
shape**, unchanged; `meta.context.connection.deployment` says which one ran. What differs:

| | Data Center | Cloud |
|---|---|---|
| Credential | personal access token, `Authorization: Bearer` | account `email` + API token, Basic auth |
| Page ids, spaces | numeric content ids; a space key goes straight into the request | page ids in text; attachment ids start `att`; a space key is looked up to the numeric id v2 wants (one more request) |
| Bodies out | the page as the Server API returns it, `--expand` picks fields | `body.storage` always, plus `bodyText` beside it (plain text); no `--expand` on `page get` |
| Markdown in | `--markdown` converts it to storage format on your machine | none: write storage XHTML, or wiki markup with `--representation wiki` |
| Paging `page list` | `--limit`, `--offset` (a position) | `--limit`, `--cursor` (an opaque token from `meta.page.nextCursor`) |
| Paging `page search` | `--limit`, `--offset` | `--limit`, `--cursor` |
| Paging `space list` | `--limit` | `--limit`, `--cursor` |
| `page history` | the history object | every version (`number`, `createdAt`, `authorId`, `message`, `minorEdit`) |
| `page update` with no body | sends none | sends the current body back unchanged (v2 requires one) |
| Comments | top-level comments | footer comments only, top level, plus `bodyText` |
| Only here | `check-toil-project` | |

A call the connection's deployment can't serve fails **before any request** with
`UNSUPPORTED`, saying which deployment and what to do: `--expand` on `page get`,
`--markdown` on `page create` or `page update`, `--offset` or `--cursor` on the other
deployment, or `check-toil-project` on a Cloud connection. The error names the connections you
have that can run it. Paging stays two flags because they are two ideas: an offset is where
to start counting, a cursor is a token only the server can read.

## Credential

**Data Center:** a Confluence **personal access token**: in Confluence, your profile picture →
Settings → Personal Access Tokens → Create token. toil sends it as `Authorization: Bearer
<token>`. There is no username, password or browser login.

**Cloud:** an **Atlassian account API token** plus that account's **email address**. Create
the token at https://id.atlassian.com/manage-profile/security/api-tokens (Atlassian
account → Security → API tokens → Create API token). toil sends
`Authorization: Basic base64(<email>:<apiToken>)`, as Atlassian documents for scripts. There
is no password, OAuth app or browser login. The token acts with the account's own
permissions, so a read sees what that account can see.

**The Jira token works too.** When the default Confluence connection has no token of its own
in env (`TOIL_CONFLUENCE_API_TOKEN`), it uses `TOIL_JIRA_API_TOKEN`, the default Jira
connection's env value, but only when both connections are the same deployment: a Data
Center Jira's token is never lent to the Atlassian cloud, nor a Cloud Jira's to a server.
Any Confluence connection can instead borrow a Jira connection's token, env or stored, by
naming it: `"apiTokenFrom": "corp-jira"`. `meta.context.shared` says when the token came
from Jira, never the value. Only the token is borrowed: on Cloud `email` is always this
connection's own, and must be the address the token belongs to.

## Configuration

| Key | Env var | Required | Meaning |
|-----|---------|----------|---------|
| `baseUrl` | `TOIL_CONFLUENCE_BASE_URL` | yes | Data Center: server root, e.g. `https://confluence.imagile.dev` (keep any context path, e.g. `https://confluence.imagile.dev/confluence`). Cloud: site root without `/wiki`, `https://<your-site>.atlassian.net` |
| `deployment` | `TOIL_CONFLUENCE_DEPLOYMENT` | no | `server` (Data Center, the default) or `cloud` |
| `email` | `TOIL_CONFLUENCE_EMAIL` | Cloud | Email address of the Atlassian account the token belongs to |
| `apiToken` | `TOIL_CONFLUENCE_API_TOKEN` | yes, unless borrowed from Jira | Personal access token (Data Center) or Atlassian account API token (Cloud) |
| `apiTokenFrom` | `TOIL_CONFLUENCE_API_TOKEN_FROM` | no | A Jira connection whose token this connection uses |
| `writes` | `TOIL_CONFLUENCE_WRITES` | no | `true` lets write commands run (with `--allow-write`) |

toil adds `/wiki/api/v2` and `/wiki/rest/api` itself on Cloud, so `baseUrl` is the site root. A
Cloud `baseUrl` ending in `/wiki` (as the browser shows it) is refused with `CONFIG_INVALID`
before anything is sent: drop the `/wiki`. There is no CI fallback variable. The examples use
the placeholder `https://confluence-cloud.imagile.dev`, which never resolves; your own site
is `https://<your-site>.atlassian.net`.

Environment variables (CI, or a one-off shell), Data Center:

```bash
export TOIL_CONFLUENCE_BASE_URL=https://confluence.imagile.dev
export TOIL_CONFLUENCE_API_TOKEN=<your personal access token>
```

Cloud:

```bash
export TOIL_CONFLUENCE_DEPLOYMENT=cloud
export TOIL_CONFLUENCE_BASE_URL=https://confluence-cloud.imagile.dev
export TOIL_CONFLUENCE_EMAIL=you@example.com
export TOIL_CONFLUENCE_API_TOKEN=<your API token>
```

Or `~/.toil/config.json`, one connection of each:

```json
{
  "version": 3,
  "connections": {
    "corp-wiki": { "area": "confluence", "baseUrl": "https://confluence.imagile.dev", "apiTokenFrom": "corp-jira" },
    "imagile-wiki": { "area": "confluence", "deployment": "cloud", "baseUrl": "https://confluence-cloud.imagile.dev", "email": "you@example.com", "writes": true }
  },
  "defaults": { "confluence": { "connection": "corp-wiki" } }
}
```

The token never goes in this file; a plaintext one there is refused with
`CONFIG_INVALID`. Run `toil connections add imagile-wiki --area confluence` (or
`toil connections login imagile-wiki`) to keep it in the OS credential store, or set
`TOIL_CONFLUENCE_API_TOKEN`. Env vars always win over the file.

## Commands

Every command also takes `--connection <name>`. Write commands (marked ✎) need
`writes: true` on the connection **and** `--allow-write`; over MCP `allowWrite: true`
stands in for the flag. `page delete` and `attachment delete` run on the CLI only; they are
not MCP tools.

Ids, space keys and labels go into URL paths encoded, each as one segment, so a `/`,
`\`, `?`, `#` or `%` in one is part of the name (label `a/b` is sent as `a%2Fb`). One
that is a `.` or `..` segment, bare or between slashes (`../space/DOCS`), is refused
with `INVALID_INPUT` before anything is sent. On Cloud an id containing `/`, `\`, `?` or `#`
is refused the same way.

| Command | Arguments and flags | Returns |
|---------|-------|---------|
| `page get` | `<id>`, `--expand` (Data Center) | The page. Data Center: default expand `body.storage,version,space,ancestors`. Cloud: the storage body plus `bodyText` |
| `page find` | `--space --title` | The page with that exact title (Cloud adds `bodyText`), or `NOT_FOUND` |
| `page list` | `--space --limit`, `--offset` (Data Center), `--cursor` (Cloud) | Every page in the space (or `--limit` of them); Cloud returns no bodies |
| `page children` | `<id>` | Every child page; Cloud lists folders, whiteboards, databases and embeds too, each with its `type` |
| `page history` | `<id>` | Data Center: the history metadata. Cloud: every version |
| `page search` | `--cql --limit --expand`, `--offset` (Data Center), `--cursor` (Cloud) | Confluence's search result, one page (25 by default) |
| `page create` ✎ | `--space --title --body or --body-file --parent-id --representation`, `--markdown` (Data Center) | The created page (Cloud adds `bodyText`) |
| `page update` ✎ | `<id> --title --body or --body-file --status --representation`, `--markdown` (Data Center) | The updated page (Cloud adds `bodyText`) |
| `page delete` ✎ | `<id>` | `{ deleted }` |
| `page comments` | `<id>` | Top-level comments, with storage bodies (Cloud: footer comments, plus `bodyText`) |
| `page comment` ✎ | `<id> --body --representation` | The comment (Cloud adds `bodyText`) |
| `page labels` | `<id>` | Every label |
| `page label` ✎ | `<id> --labels a,b` | The labels Confluence reports |
| `page unlabel` ✎ | `<id> --label` | `{ removed, from }` |
| `space list` | `--type --limit`, `--cursor` (Cloud) | Every space (or `--limit` of them) |
| `space get` | `<key>` | The space, with its plain-text description |
| `page attachments` | `<id>` | Every attachment on the page |
| `page attach` ✎ | `<id> --file --comment` | The attachments created |
| `attachment download` | `<attachment-id> --dir` | `{ saved, filename, size }`; saves to `.toil/` by default |
| `attachment delete` ✎ | `<attachment-id>` | `{ deleted }`; the attachment goes to the trash |
| `check-toil-project` (Data Center) | `--toil-project <name\|file>` (or the folder's toil project) | `{ toil project, connection, env, ok, checked, checks, unchecked }`: each space the toil project names (`space`, `spaces`), found or not; exit 1 when one is missing |

Over MCP the same commands are tools named after the path, with spaces and hyphens
as underscores (`confluence_page_get`, `confluence_attachment_download`), taking
camelCase fields named after the arguments and flags (`id`, `bodyFile`, `parentId`).

## Examples

```bash
toil confluence page get 12345
toil confluence page find --space DOCS --title "Release notes"
toil confluence page search --cql 'space=DOCS AND type=page AND text~"runbook"' --limit 10
toil confluence page list --space DOCS --limit 50
toil confluence page create --space DOCS --title "Runbook" --body-file runbook.html --parent-id 12345 --allow-write
toil confluence page update 12345 --body-file runbook.html --allow-write
toil confluence page label 12345 --labels runbook,ops --allow-write
toil confluence page attach 12345 --file diagram.png --allow-write
toil confluence attachment download 98765 --dir downloads
```

On a Cloud connection (`--connection imagile-wiki`, or when it is the default), attachment
ids carry an `att` prefix and lists page by cursor:

```bash
toil confluence page list --space DOCS --limit 50 --connection imagile-wiki
toil confluence page search --cql 'space=DOCS AND type=page' --limit 10 --connection imagile-wiki
toil confluence attachment download att98765 --dir downloads --connection imagile-wiki
```

## Body format

Bodies are Confluence **storage format** (XHTML), both ways.

- **Data Center:** `--representation wiki` sends the value under `body.storage` with
  `representation: "wiki"`. `--markdown` converts Markdown to storage format on your
  machine first, with the converter `toil util md --to storage` runs, so the body sent is
  well-formed XHTML; anything storage format can't hold comes back as an `MD_LOSSY`
  warning in `meta.warnings`, and the page is still written. When Confluence rejects a body,
  the error adds the offending line of an XML parse error, and known storage-format
  mistakes behind an HTTP 500 (`<ac:parameter name=…>`, a macro with no `ac:macro-id`).
- **Cloud:** every page and comment is read with `body-format=storage`, so `body.storage.value`
  is the XHTML. Beside it, `bodyText` is a plain-text rendering: tags dropped, blocks on their
  own lines, list items as `- `, table cells joined with ` | `, code macro text kept, macro
  parameters dropped. It's for reading, not for writing back. In (`--body`, `--body-file`)
  is storage-format XHTML, or wiki markup with `--representation wiki`, which Confluence
  converts to storage. Atlassian Document Format isn't offered, and `--markdown` isn't offered
  on Cloud yet: convert with `toil util md --to storage` and pass the result with `--body-file`.
- `--body-file -` reads the body from stdin on the CLI. Over MCP, `-` is refused because
  stdin carries the protocol; pass a file path. Files resolve inside the workspace.

## Paging

**Data Center** lists page through everything, 25 at a time: `page list` and `space list`
without `--limit`, and the other lists always. `--limit` caps the total and `--offset`
(`page list`, `page search`) says where to start. A `--limit` that isn't a positive whole
number (`abc`, `0`) usually returns an empty list, with a `CONFLUENCE_LIMIT_INVALID` warning.
`page search` returns one page, as Confluence returns it: raise `--limit` or advance
`--offset` for more.

**Cloud** lists page by cursor. Without `--limit`, `page list` and `space list` read every
page of results. With `--limit N` they return at most N, and `meta.page.nextCursor` resumes:
pass it back as `--cursor` with `--limit`. Every other list (`page children`, `page history`,
`page comments`, `page labels`, `page attachments`) is read in full. Paging stops after 1,000
requests with an error naming the list. `page search` returns one page, as Confluence returns
it (`results`, `size`, `totalSize`, `_links`), 25 results unless `--limit` says otherwise.
When there are more, `meta.page.nextCursor` is the cursor from its `_links.next`: pass it as
`--cursor` (with the same `--cql`) for the next page.

## Notes

- `page update` reads the current version and sends the next one, keeping the title unless
  `--title` is given. Data Center sends no body when none is given. Cloud requires a body on
  every update, so with no `--body` or `--body-file` the current storage body is sent back
  unchanged (a rename). Cloud's `--status draft` sends version 1, as Atlassian documents for a
  change to draft, and deletes any draft the page already has. `--representation` without a
  body is `INVALID_INPUT` on Cloud.
- Cloud `page create` without `--parent-id` puts the page under the space's homepage, as the
  API does.
- Cloud `page children` uses v2's direct children, which lists folders, whiteboards, databases
  and embeds beside child pages; each result's `type` says which.
- Cloud `page comments` reads footer comments only, top level only: no replies and no inline
  comments. `page comment` adds a footer comment.
- Cloud `page label` and `page unlabel` use v1, since v2 can't write labels. Labels are added
  with the `global` prefix. `page unlabel` sends the label as a query parameter, so any label
  can be removed.
- `attachment download` never replaces a file: one of the same name in the target directory
  fails with `INVALID_INPUT`. The file name is the attachment title's last path segment, made
  safe to save on any platform: a device name such as `CON` gets a leading `_`, a `:` and what
  follows it is dropped, as are trailing dots and spaces, and the characters Windows forbids
  become `_`. The token only ever goes to `baseUrl`'s host: a Data Center download link naming
  another host is fetched from `baseUrl` instead, with a `CONFLUENCE_ATTACHMENT_HOST` warning
  (`CONFLUENCE_CLOUD_ATTACHMENT_HOST` on Cloud). On Cloud the attachment is read first, then
  its `downloadLink` is fetched under `baseUrl/wiki` with the credential. Confluence answers
  with a redirect to a signed URL on Atlassian's media host; toil follows it with **every
  header dropped**, so the credential stays on your site.
- `page attach` always creates a new attachment; a file name already on the page isn't added
  as a new version. On Cloud it uses v1 multipart with `X-Atlassian-Token: nocheck`, and the
  file name is the path's last segment, with `/` or `\` splitting it on every platform.
- `page delete` and `attachment delete` move the item to the trash; neither purges.
- A 429 is retried after the delay Confluence asks for, as in every area.

## Moving from `confluence-cloud`

Confluence Cloud used to be its own area. It is `confluence` with `"deployment": "cloud"`
now, and the old names are gone, not deprecated:

- **Config:** a connection with `"area": "confluence-cloud"` is read as `"area": "confluence",
  "deployment": "cloud"`, and `defaults.confluence-cloud` folds into `defaults.confluence`,
  with the same care as Jira's (a default for another key is written onto the Cloud
  connections when a Data Center connection would otherwise inherit it, and the other way
  round). The fold runs for every config version, so a version 3 file that still says
  `confluence-cloud` is folded too, with a `CONFIG_RENAMED_AREA` warning naming the new
  form. Any command that saves a connection writes the file back with the new form. Keychain
  entries are untouched. When both areas named a default connection, `confluence`'s stays the
  default and `CONFIG_DEFAULT_KEPT` names the Cloud one that was set aside.
- **Commands and tools:** the `confluence-cloud` command path is `confluence`, the
  `confluence_cloud_*` tools are `confluence_*`, and `--areas confluence-cloud` is `--areas
  confluence`. The old forms fail with `INVALID_INPUT` naming the new one.
- **Flags:** Cloud's `--cursor` and Data Center's `--offset` stay as they were, each refused
  on the other deployment with `UNSUPPORTED`.
- **Env vars:** `TOIL_CONFLUENCE_CLOUD_*` is refused with `CONFIG_INVALID`; use
  `TOIL_CONFLUENCE_*` with `TOIL_CONFLUENCE_DEPLOYMENT=cloud`, or `TOIL_CONN_<NAME>_*` with
  `TOIL_CONN_<NAME>_DEPLOYMENT=cloud`. `TOIL_CONN_<NAME>_AREA=confluence-cloud` is refused the
  same way. An empty `TOIL_CONFLUENCE_CLOUD_*` is skipped unless `TOIL_STRICT_ENV=true`.
- **Old `TOIL_CONFLUENCE_*` values on a Cloud default:** `TOIL_CONFLUENCE_*` reaches the
  default connection. When that connection is Cloud and `TOIL_CONFLUENCE_DEPLOYMENT` isn't set,
  the call fails with `CONFIG_INVALID` naming the variables, so Data Center values and a token
  never land on a Cloud site by accident.
- **Toil projects:** a `confluence-cloud` section is read as `confluence` (also under an
  environment and in a person's `ids`), with a `TOIL_PROJECT_RENAMED_AREA` warning to rename it.
  With both, `confluence` wins. A toil project has one `confluence` section, so it picks one
  Confluence connection.
