---
description: What every toil command shares, in detail - the envelope and errors, the contract version, --select, big results (--summary-file and --output-format toon), toil wait, paging and progress, writes and their exceptions, global flags, files and the workspace, configuration, the raw API passthrough, toil projects, the audit log, using toil from a program (@imagile-dev/toil/api), sending feedback, certificates and proxies
---

# Using toil

`SKILL.md` has the rules every call needs. This page has the detail behind them, for
when a call needs more than a command's own flags.

For an AI term you meet here or in Toil UI (token, context window, harness, MCP),
Context Overflow's glossary has a page each: <https://kolatts.github.io/context-overflow/glossary>.

The jira and ado commands, whichever deployment a connection is, are `toil <area> <resource> <action>
[ids...]`: ids are positional, everything else is a flag, and `toil <area> <resource>
--help` lists what a resource can do (`toil jira issue --help`).

## The envelope and errors

Every command prints one JSON envelope on stdout: `{ ok, data, error, meta }`.
Check `ok`; on failure, `error.code` says what kind of failure it was and `error.fix`
says what to do about it. New codes may appear in any release, so treat a code you
don't know as a generic failure. `meta.warnings` lists anything worth knowing that
isn't a failure, such as a truncated result. `meta.context` says which connection a
call used and how it was chosen, and where any project, repo or environment it
resolved came from. `meta.lint`, on the `db` commands that run SQL you wrote, names
the engine whose dialect toil checked it against and the rules that ran (`db.md`,
**Pre-flight lint**). `--pretty` formats the output for people.

`meta.contractVersion` (also in `toil version`) is the version of toil's command
contract: its commands, flags, `data` fields, envelope and error codes. It goes up only
with a breaking change, so a script or program built against one version works with
every toil that reports it.

## Paging

Paged results put the next page's cursor in `meta.page.nextCursor` (null on the last
page) and the page size in `meta.page.limit`. Pass the cursor back with the
command's own paging flag, which its reference names.

## Moving work items by intent

`jira issue transition` and `ado work-item transition` take `--to <intent>` (`to` over MCP): `start`,
`review`, `done`, `reopen`, or a status name. toil resolves it against the moves that
one item offers right now, by its own workflow, because a workflow belongs to the issue
or work item type: a Story may go through In Review while a Task goes straight to Done.
In order, the first that gives exactly one move wins:

1. **The toil project's pin** for the item's type: `"transitions": { "Story": { "review":
   "Peer Review" } }` in the area's section (**Toil projects**, below).
2. **An exact name**: a transition or status called what you passed, ignoring case.
3. **The intent's status category**: Jira's To Do, In Progress and Done categories
   serve `reopen`, `start` and `done`, and Jira files review under In Progress, so a
   status there whose name says review (In Review, Code Review) serves `review`; Azure DevOps'
   Proposed, InProgress, Resolved and Completed serve `reopen`, `start`, `review` and
   `done`. When several moves share the category, a name that starts a word with the
   intent (`Submit for Review`) picks one.
4. **A name that says it**: the one move whose name or target status starts a word with
   the intent.

It never guesses. No match, more than one, or an item already where the intent leads is
`INVALID_INPUT`, and the fix lists every move the item offers, by name, target status,
category and id. On success `meta.transition` says what was resolved: `{ intent,
transition, toStatus, resolvedBy }`, `resolvedBy` being `toil-project`, `status`,
`category` or `name`. Resolving only reads (Jira: the issue with its transitions; Azure
DevOps: the item and its type's states), after the write gate, which is unchanged:
writes on for the connection and `--allow-write`. `--transition` (Jira) and `--state`
(Azure DevOps) still name the move exactly; give one or `--to`, not both.

```bash
toil jira issue transition PAY-12 --to review --allow-write
toil ado work-item transition 42 --to done --allow-write
```

## Ticket the work

Before you start work that no ticket covers (a prompt or a branch that names no
issue key), find the open ticket it belongs to and ask the person what to do with
it. Never decide on your own, and never start the work untracked without asking.

1. **List the person's open items** in the toil project's trackers (`toil projects show`
   names them): theirs and not done, through each tracker's own search, mapped
   with `toil util owi map`. Each tracker's page gives its search under **Ticket the
   work**.
2. **Rank them against the work**, by the prompt or the branch name:
   `toil util owi similar --query "<text>"`. Each match has a `score` and a `why`,
   the shared words that drove it.
3. **Ask the person**, showing the top matches (up to three) with their `why`,
   which of three to do:
   - **Attach** the work to a match. Nothing is written: use its key in the branch
     name and in every commit message.
   - **Create a sub-task** under it.
   - **Create a new ticket**, letting the toil project and the connection fill the
     project and the issue type.

   With no match (an `OWI_SIMILAR_NO_MATCH` warning), say there is no likely
   ticket and suggest creating one. Don't lower `--threshold` to find something.
4. **A sub-task or a new ticket is a write.** Show the exact command first, and run
   it only on the person's yes to that one item, with writes on for the connection
   and `--allow-write` (**Writes**, below).

```bash
toil jira issue search --jql "assignee = currentUser() AND statusCategory != Done" --fields summary,description,status,issuetype,labels,parent | toil util owi map | toil util owi similar --query "Card payments time out at checkout"
```

Over MCP, pass the `util_owi_map` envelope to `util_owi_similar` as `text`, with
`query`.

## Progress

While a command runs, toil says what it's doing: each page a listing reads, and each
rate-limited (429) request it waits to retry. On the command line these go to stderr,
one plain `[toil] …` line each: a retry and how long toil waits always, piped or not,
and pages only when stderr is a terminal. stdout still holds only the envelope. Over MCP they're progress notifications, sent when the
client's call asks for progress. A program using toil's API gets them, and every
request too, through `onProgress` (**Using toil from a program**). They never change
the envelope.

## Selecting fields

To get back only the fields you need, pass `--select <expression>` (`select` over
MCP), a [JMESPath](https://jmespath.org/specification.html) expression applied to
`data`, for example `--select "issues[].{key: key, status: fields.status.name}"`.
`meta`, including `meta.page`, is left as it is. A bad expression is `INVALID_INPUT`
before the command runs, with its position in `error.fix`; one that selects nothing
gives `data: null` and a `SELECT_EMPTY` warning. An expression may build at most 16 MiB
of JSON plus four times the size of the data, so one that multiplies the data (`[@,@]`
piped into itself) is `INVALID_INPUT` too; select fewer fields or elements. The same
holds for `toil wait --until`.

## Big results

A search or listing can return far more than you need to read. Two flags on every
command (fields over MCP) keep it out of your context.

**`--summary-file <file>`** (`summaryFile`) writes the whole of `data`, as JSON, to
that file in the workspace (it must not exist yet; toil never overwrites), and puts a
summary in `data` instead. Use it for any read that may return more than a page. Fixed
rules pick the summary, the first that matches:

| Result | `data` holds |
|--------|--------------|
| No list in it, 20 fields or fewer, and an estimated 1,500 tokens or fewer | The whole result |
| 50 rows or fewer, and an estimated 1,500 tokens or fewer | The whole result |
| No list, or rows that don't share 80% of their fields | `keys`, `lengths` (of each list, object and long text) and one `sample`, its long text cut short (a bare text keeps its first 2,000 characters) |
| 500 rows or fewer | `fields` (what's beside the list), the first 20 `rows`, `stats` and `file` |
| More than 500 rows | `fields`, the column `schema`, 10 `rows` spread from first to last, `stats` and `file`, with a `SUMMARY_LARGE` warning |

The rows are the result itself when it's a list, else the list in it with the most
cells, its rows times their width (`issues` in `{ total, issues }`, `findings.results`
a level down, or `rows` beside a `db` query's `columns`). Size doesn't count, so one
long text can't make a one-row list the table, and a list of objects that names the
columns of a sibling's list rows, or is exactly `{ name, type }` columns beside an
empty list (a `db` query's `columns`), is never the table. Nested rows
are compared by their dot paths (`fields.status.name`). `stats` has, for each column
(the first 25), `nulls`, `distinct`, and `min` and `max` for numbers and dates (null
otherwise). Every summary is held to the 1,500-token budget: texts longer than 200
characters are cut short (ending in `…`), then rows are dropped from the end (a last
row still too wide has its texts cut to 40 characters, and goes only if that doesn't
fit), fields
beside the rows are dropped from the end, and an outline's sample, lengths and keys
are cut in that order. `meta.summary` says which rule applied (`rule`),
how many rows the full result has (`rows`), where they are (`table`), the `file`,
the token estimates (`tokens`, JSON characters / 3.5: an estimate, never a count),
the column count, and anything the budget trimmed. After a `SUMMARY_LARGE` warning,
work over the file rather than reading it in: a narrower query, `--select`, or a tool
that reads JSON. The file is written even when the whole result fits, so it's always
there; a read-only API call refuses `summaryFile`, since it writes a file.

**`--output-format toon`** (`outputFormat: "toon"`) writes `data` as
[TOON](https://github.com/toon-format/spec) text: a list of uniform rows becomes one
header (`rows[20]{key,status}:`) and one comma-separated line per row, so field names
are paid for once rather than on every row. Only `data` changes: `ok`, `error` and
`meta` stay JSON, and `meta.format` is `"toon"`. It pays off for tables; deeply
nested data with few repeated rows can come out longer than JSON. `--output-format
json` is the default, and output without either flag is exactly what it always was.
Both flags go together, the summary first:

```bash
toil util deps scan --include-transitive --summary-file deps.json --output-format toon
```

## Waiting for something to finish

To wait for a build, a scan or a deployment to finish, don't call a read in a loop:
`toil wait --until "<expression>" -- <read command>` runs it again every `--interval`
(default 15s, at least 5s) until the JMESPath expression over its `data` is true (not
null, false or empty), for example
`toil wait --until "result != null" -- jenkins run get my-job 42` or
`toil wait --until "projectStatus.status != 'NONE'" --timeout 10m -- sonar quality-gate get --project my-app`.
Over MCP it's the `wait` tool, with `tool` (the read's tool name), `input` (that tool's
input) and the same `until`, `interval` and `timeout`. It returns the read's last
envelope plus `meta.wait` (`until`, `attempts`, `elapsedMs`). `NETWORK` errors and
`HTTP` 5xx or 429 answers are retried with backoff; any other error ends the wait with
that error. Past `--timeout` (at least 5s; default 30m, or `TOIL_TIMEOUT_MS`, cut to the maximum
with a `WAIT_TIMEOUT_CAPPED` warning when it is longer; at most the
`"wait": { "maxTimeout" }` in config, default 1h) it's `TIMEOUT`, with the last `data`
in `error.details.data`. Only reads can be waited on: a write is `INVALID_INPUT`.
`--select` before `wait` applies to the final `data`; a `--select` after `--` belongs
to the read, so `--until` sees what it selected. Other global flags go before `wait`,
`--summary-file` and `--output-format` included, and shape the final `data`.

## Writes

Reads are always allowed. A command that changes something, in a service, a database
or a file on this machine outside toil's own config, needs both `writes: true` on the
connection it uses, set by a person in their config or with a
`TOIL_CONN_<NAME>_WRITES` / `TOIL_<AREA>_WRITES` env var, and `--allow-write` on the
call (`allowWrite: true` over MCP). Without either it fails with `WRITE_DISABLED`,
naming what's missing. Over MCP a write tool isn't listed until writes are on, and
deletes are never tools. A command that is CLI only and has no connection yet
(`toil skills marketplace add`) needs `--allow-write` alone.

### Exceptions

Exactly four writes don't follow that rule. Each is the maintainer's choice, made
deliberately, and is listed here with how to avoid it.

| Write | What it writes, and when | Why | To avoid it |
|-------|--------------------------|-----|-------------|
| **`toil skill install`** | With `--allow-write` alone (CLI only, no connection): the toil skill, into one agent's skills folder as `toil/`, recorded as `bundled`. | Its contents are fixed: the files embedded in toil, no third-party code. It replaces only a `toil/` folder it recorded as `bundled` and refuses any other. | Don't run it. |
| **The toil skill keeping itself current** | With no `--allow-write`: a `toil/` skill folder recorded as `bundled`, and nothing else in a skills folder (never a marketplace or hand-made skill). Rewritten by any command that loads config, on the CLI or over MCP, when that command changed the config file (a connection added, changed or removed) or when the copy was written by another toil version. Said in `meta.warnings` as `SKILL_REWRITTEN`. | So an installed skill never describes connections you no longer have, or a toil you no longer run, with no update command to forget. The contents are fixed; the description holds only area and engine names checked against toil's own list, never a host or a credential; and a rewrite that fails is a `SKILL_REWRITE_FAILED` warning, never a failed command. | Don't install the skill with `toil skill install` (copy `skills/toil` yourself, or use the Claude Code plugin marketplace), or delete the installed `toil/` folder. A call with `--config <file>` never rewrites it. |
| **`toil feedback`** | With no connection and no `--allow-write`: one bug report or feature request, sent to Imagile LLC, which files it as a public GitHub issue. Only with `--consent` on the call, or `yes` typed at a terminal after it shows the report. CLI only. | Feedback has no connection to hold a standing opt-in, so the approval of each report is the opt-in. It sends only what you typed, plus toil's version and commit, and is the one request toil makes to a host you didn't configure (**Feedback**, below). | Don't run it, or run it without `--consent`: it then sends nothing and shows what it would send. |
| **The welcome menu's game save** | With no `--allow-write`: the game's progress, under the `"game"` key of `~/.toil/config.json`, every other key kept as it was. Only while you play Two Weeks' Notice in the menu bare `toil` opens. | It's a game a person plays at a terminal, and its save touches nothing but its own key. The save is sealed against tampering, not kept secret. | Don't play it. There is no setting to turn the save off. |

## The raw API passthrough

For an endpoint no command covers, an HTTP area has `toil <area> api <METHOD> <path>`
(`<area>_api` over MCP), which sends the connection's own credential to a path under
its base URL. GET and HEAD are reads; other methods are writes, and `DELETE` is CLI
only. The area's reference describes it where the area has one (`jira.md`).

## Files and the workspace

Files a command reads or writes (an `--input-file`, an upload, a download, a CSV
report) must be inside the workspace: `--workspace <dir>`, else `TOIL_WORKSPACE`,
else the working directory; under `toil mcp`, the client's root when it shares
exactly one. Relative paths resolve against it, a path outside is refused with
`INVALID_INPUT`, and nothing is ever overwritten. Under `toil mcp` with no single
root, a command that touches a file returns `NOT_CONFIGURED`: add `--workspace <dir>`
to the server's args. A person can let commands reach any path with
`"bounds": { "files": "unbounded" }` in their config, and every envelope then
carries a `BOUND_RELAXED` warning. A network path (`\\host\share\x`, `//host/share/x`)
or a Windows device path (`\\?\`, `\\.\`) is refused with `INVALID_INPUT` before
anything looks at it, relaxed or not, unless the workspace is itself a folder on that
share; copy the file into the workspace instead. Saved paths come back absolute, with forward
slashes. Commands that run git need git on PATH and say
`GIT_NOT_FOUND` without it; nothing else does.

## Configuration

Configuration comes from environment variables, which always win, or from
`~/.toil/config.json` (or the file passed with `--config`). A connection is one
instance of an area; `--connection <name>` picks one when there are several.
`toil connections list` names them (never a secret), with `definedIn`: `file` for one
in your config file, `env` for one made by env vars alone, which the connections
commands can't change. `toil connections test
<name>` checks one with a single authenticated read, failing with the `AUTH`,
`NETWORK` or config error a real command would. Setting up a connection, signing
in, turning writes on and choosing a default are for a person: a bare `toil` in a
terminal opens a menu for them. An agent may create a connection on the person's yes with
`toil connections add <name> --area <area> --set key=value` (repeatable, non-secret
settings only; a secret key is refused), which asks nothing and leaves writes off; the
person then enters the secret with `toil connections login <name>` or in Toil UI.
`setup.md` is that walkthrough. `toil connections migrate` saves the config file in the
current version, with retired areas folded into the areas that replaced them; it reports
what it wrote (names and keys, never a value) and writes nothing if the file is current.
It is CLI only, like the other commands that change the file.

### Importing database connections

`toil connections import --from <tool> [file]` brings the database connections a person
already has in another tool into toil as `db` connections, so nobody retypes hosts. It is a
**preview** unless `--save` is given: it writes nothing and returns, in `data`: `from` (the tool),
`file` (the file it read, `null` for `--url`), `fileSource` (`argument`, `default` or `url`), `saved`,
`configFile` (the config `--save` writes), `counts` (`connections`, `exists`, `skipped`), `connections`
(each with its `name`, `source` (the tool's own name for it), `group`, `engine`, non-secret
`settings`, `warnings`, `nextSteps` and, when an existing connection has the same engine, host, port
and database, `similarTo`), `exists` (names already taken, left alone, never overwritten, each with
its `name`, `source` and `reason`), `skipped` (what toil cannot hold, each with its `label` and
reason) and, on a preview, `saveWith` (the command that saves it, with the connection string's
password left out and `--config` when the call used another config file).
An agent runs the preview, shows the person the result and runs `--save` on their yes. The
passwords stay the person's: each connection's `nextSteps` names `toil connections login <name>`,
which they run in their own terminal and type at its hidden prompt, or they enter it in Toil UI's
Settings, Connections. Hand those over as `setup.md`, section 4, says; never ask for the password.

The formats were built from each tool's documentation and have not yet been checked against real
exports; a file that doesn't read says what to export instead.

**A secret is never imported.** A password found in a file or connection string is dropped and said
so in `warnings` (and in `meta.warnings` as `SECRET_NOT_IMPORTED`). toil never reads `.pgpass`,
DBeaver's `credentials-config.json` or SSMS's encrypted passwords. A file that is read but has
something worth knowing (more connections than it takes) adds `IMPORT_FILE_WARNING` to
`meta.warnings`. Each created connection lists `nextSteps`: the person runs
`toil connections login <name>` (a connection that signs in with Windows authentication, or SQLite,
has no password and only gets `toil connections test <name>`). `writes` stays off, and no default
connection is chosen.

| Tool | `--from` | Default file | Notes |
|------|----------|--------------|-------|
| DBeaver | `dbeaver` | `General/.dbeaver/data-sources.json` in its workspace | Folders become name prefixes; SSH tunnels and proxies are skipped; it has no user, so give one with `--user` (logins live in an encrypted file toil does not read) |
| SQL Server Management Studio | `ssms` | `RegSrvr.xml` in `%APPDATA%\Microsoft\SQL Server Management Studio` or its version folders (Windows) | Or a `.regsrvr` export (Registered Servers > Export); server groups become prefixes; named instances are skipped (toil needs a port) |
| Azure Data Studio | `azure-data-studio` | its user `settings.json` | `datasource.connections`; Microsoft Entra sign-in is skipped |
| VS Code SQL Server extension | `vscode-mssql` | VS Code's user `settings.json` | `mssql.connections` |
| pgAdmin | `pgadmin` | none: export one (Object > Import/Export Servers) | The default "Servers" group is not a prefix |
| PostgreSQL service file | `pg-service` | the file `PGSERVICEFILE` names, `~/.pg_service.conf`, `%APPDATA%\postgresql\.pg_service.conf` (Windows), `pg_service.conf` in `PGSYSCONFDIR`, `/etc/postgresql-common/pg_service.conf` and `/etc/pg_service.conf` (not Windows) | `.pgpass` is never read |
| MySQL Workbench | `mysql-workbench` | `connections.xml` in its data folder | SSH, socket and pipe connections are skipped |
| DataGrip and JetBrains IDEs | `datagrip` | `.idea/dataSources.xml` in the current folder | Reads the JDBC URL; it has no user, so give one with `--user` |
| Oracle | `tnsnames` | `TNS_ADMIN`, or `ORACLE_HOME/network/admin`, `tnsnames.ora` | A SID, not a service name, is skipped; it has no user, so give one with `--user` |
| One connection string | `url` | none | Given with `--url`: `postgres://`, `mysql://`, `jdbc:...`, an ADO.NET string or an absolute SQLite path |

The other options: `--prefix <text>` goes in front of every name; `--name <name>` names the one
connection of a `--url` import; `--user <name>` supplies a login for every connection the file gives
none; `--save` creates them. A path you name always wins over the default. With no file found, the
error names every place it looked and how to export one. The file is read from where the tool keeps
it, or where you named it, outside the workspace, but never from `~/.toil`, the `--config` file, a
network or device path, `/proc` or `/sys`; it is at most 4 MB and 1000 connections, and a parse
error never quotes the file. Each connection is checked against the real `db` schema before the preview shows it, so what
the preview lists is what `--save` accepts; one it would refuse is in `skipped` with the reason.
It is CLI only, like the other commands that change the file.

A CI job that wants an empty variable to be an error, not a skipped line, sets
`TOIL_STRICT_ENV=true`. Today it matters for one thing: an empty variable of an area that
no longer exists (`TOIL_JIRA_CLOUD_API_TOKEN=""`) is skipped by default, as an empty CI
fallback is, and refused with `CONFIG_INVALID` when it is on; a variable with a value is
refused either way. `TOIL_STRICT_ENV` is read only from the environment and maps onto no
area.

When `toil connections add` or `login` asks for a secret, the terminal shows one `•`
per character typed or pasted (Backspace removes one, Ctrl+U clears them), never the
characters, and after Enter says how many arrived: `Received 40 characters.` Before
anything is stored, the paste is checked. Spaces, tabs or newlines around it are
trimmed and the line says so (`Received 40 characters (removed a trailing
newline).`); a value in quotes, or starting with `Bearer ` or `token `, is asked
about (`This starts with "Bearer ". Store it without that? [Y/n]`), never changed
silently; a line break in the middle (or, for a token, a space) is refused, since
the paste most likely took two lines, and asked for again; and an empty answer
asks again where the secret is required, or says `Kept the existing secret.` where
`login` keeps the one stored. Toil UI's password fields run the same checks, in the
same words.

### Themes

The menu a bare `toil` opens, and Toil UI, follow one theme: `"theme"` in
`~/.toil/config.json`, which `toil theme set <name>` writes, with `TOIL_THEME` over it
and Crate when neither is set. `toil theme list` names the themes, marks the default
(`default`), and says which is in effect and where it came from (`env`, `file` or
`default`). A theme changes only the
menu's colours, its splash and a few of its headings, and Toil UI's look; no
envelope, `--help` text, error or MCP tool changes with it, so there's no reason for an
agent to set one unless a person asks.

## Global flags

Global flags go before or after the command: `--pretty`, `--verbose` (adds every
request to `meta.requests`, credentials redacted), `--debug` (traces on stderr),
`--config <file>`, `--output-file <file>` (the whole envelope to a file, CLI only),
`--workspace <dir>`, `--select <expression>`, `--summary-file <file>` and
`--output-format json|toon` (**Big results**). `--help` on any command lists its own
flags.

## Toil projects

`projects.md` explains what a toil project is, with an example file field by field; this
section is the short form.

A **toil project** holds what toil knows about one body of work: its repositories, and per
area the keys a call needs (`project`, `owner`, a namespace per environment), which
connection to use (by name, or by `host`), and reference data such as board lists.
It holds no secret and can't add a host or turn on writes. toil reads toil projects on
every area command from `~/.toil/projects/`, the folders in `projectPaths` (or
`TOIL_PROJECT_PATHS`), and `.toil/projects/` in the repository you're in, and uses
the one that applies: `--toil-project <name|file>` (`toilProject` over MCP, or
`TOIL_PROJECT`), else the one whose repo matches the folder by path or `origin`
remote. `--cwd <dir>` (`cwd` over MCP) looks from another folder. A value you pass
always beats the toil project's, and `meta.context.toilProject` says which toil project applied and
why. When two different toil projects match, the call fails with `INVALID_INPUT` until you
pick one. A write on a connection a toil project chose is `WRITE_DISABLED` unless the
toil project is in your own folder; pass `--connection` to choose it yourself. To see what
a call will use before making it: `toil projects context` (which toil project a folder
resolves to and why), `toil projects show [name]` (per area: the connection and why,
whether writes are on, the environment and the inputs), `toil projects list`, and
`toil projects check [name]`, which checks one locally and contacts no service.
`toil projects brief [name]` says what in the toil project's work needs a person, from
Open Work Item records you pass it, and `toil projects analyze prompt [name]` (the
MCP prompt `analyze`) is the prompt an agent runs to analyze it (`projects.md`,
**Brief** and **Analyze**).

In a repository that already has one checked in, `toil projects onboard` sets you
up: for each area it finds your connection on the toil project's host, offers to add one
you lack (asking for the token on the terminal), asks which to pin in your own copy
when several match, then runs `toil projects check` and one test read per connection. It
is CLI only; with no terminal, or `--plan`, it adds no connection and says what each
area needs.

To build one for a product: `toil repos scan` lists the git repositories under the
workspace. Then:
- `toil projects init <name>` creates the toil project; `--shared` creates it in the
  repository's `.toil/projects/` for the team, and a `--connection` linked into a
  shared toil project is recorded as that connection's `host`.
- `toil projects add-repo <name> <folder|remote>` adds each repository.
- `toil projects link <name> <area> --host <host> --set project=PAY [--for-repo <repo>]`
  says which connection an area uses and the keys it supplies.
- `toil projects env <name> <env> <area> --set namespace=...` adds an environment.
- `toil projects field <name> jira storyPoints customfield_10002` names a field, so
  `--field storyPoints=5` works.
- `toil <area> check-toil-project` checks a section against the service, for the call's
  environment (jira, confluence, sonar, ado, bitbucket, github, openshift,
  dynatrace).
- `toil projects export <name> --repo <root>` writes a shareable copy into a
  repository's `.toil/projects/`. It uses host selectors and no local paths, and toil
  never commits it.
- `toil projects unlink <name> --area <area> [--env <env>]` removes a section (CLI only).
- `toil projects import <file>` copies a teammate's into your own folder. A connection
  or host you lack is listed under `toSetUp`; toil never creates one.
- `toil projects migrate` (CLI only) moves `~/.toil/dossiers/*.json`, the folder earlier
  versions used, to `~/.toil/projects/` on the person's `yes` (or `--yes`), never
  overwriting a file. Earlier versions called a toil project a dossier; `projects.md`,
  **Moving from dossiers**, lists the old names, and `upgrading.md` converts a setup.

These are local writes and need no `--allow-write`. Each refuses a value that's already
set unless `--replace`. Over MCP they refuse to make a toil project select a connection
with writes on; the user does that on the command line, or under **Toil projects** in the
menu bare `toil` opens, which runs these same commands and asks them to type the
connection's name first.

## The audit log

toil keeps a local audit log of every command it runs, through the CLI, MCP and the
API: one JSON line per call in `~/.toil/audit/<yyyy-mm>.jsonl`, with the command, front
door (`via`: `cli`, `mcp` or `api`, plus `caller` when a program named itself), connection, whether it wrote, the outcome, the redacted input and each request's
method, URL and status. It never holds a secret, a header, a body or a row, and `db`
SQL is kept only as a SHA-256 hash. `toil audit list` reads it back, newest first,
with `--since <date>`, `--command <name|area>`, `--connection <name>` and
`--outcome <ok|failed|code>` and `--writes-only`; `toil audit path` says where it is and whether it's on. Six months are
kept by default (`"audit": { "keepMonths": 12 }` changes that), and only a person can
turn it off, with `"audit": { "enabled": false }` in `~/.toil/config.json`. A call
whose line couldn't be written still succeeds, with an `AUDIT_WRITE_FAILED` warning.

`toil audit stats` summarizes the same log, and reads nothing else. Over a window
(`--since`, `--until`; by default from midnight UTC 30 days ago to now) it returns
`totals` and one entry in `groups` per value of `--by command|area|connection|caller|via|outcome|day`
(repeat `--by` for a cross-tab; the default is `command`; `day` is the UTC date):
`calls`, `ok`, `failed`, the top three `errors` with each code's general `fix` (the log
keeps the code, never the call's own message), the nearest-rank `durationMs.median` and
`p95`, `writes` and `writeShare`, and `firstSeen` / `lastSeen`. Groups come most calls
first, or in date order when `day` comes first. `--area`, `--command`, `--caller` and
`--outcome` filter it, and `--unused` adds `unused`: every registered command, within
the area and command filters, with no matching call in the window, and whether MCP
serves it. It never groups by an input's value, so a hashed statement stays a hash.

```bash
toil audit stats --by command --unused --area jira
toil audit stats --by day --by via --since 2026-10-01 --until 2026-10-18
toil audit list --command "jira issue get" --outcome failed --limit 20
```

## Using toil from a program

A Node program can call toil in-process instead of running `toil` and parsing stdout.
`@imagile-dev/toil/api` is a supported entry point of the same package, with its own
types, and it adds no dependency: it is the same bundle as the CLI. Loading it runs nothing, even
when your own build bundles it in: only toil's bin starts the CLI. On a Node with a known
remote code execution (see `install.md`), every `execute()` still runs and puts an
`UNSUPPORTED_NODE` warning first in `meta.warnings`.

```js
import { contractVersion, execute, registry, version } from '@imagile-dev/toil/api';

if (contractVersion !== 2) throw new Error(`Needs toil's contract 2; toil ${version} has ${contractVersion}.`);
const envelope = await execute('jira issue search', { jql: 'project = PAY', limit: 50 }, {
  readOnly: true,
  caller: 'nightly-sync',
  onProgress: (event) => console.error(event.message),
});
```

- **`execute(command, input, options)`** runs one command and returns its envelope,
  exactly as the CLI prints it. `command` is the name `meta.command` reports
  (`jira issue search`); `input` is the command's MCP fields, checked strictly. It never
  throws: an unknown command or a bad option is an `INVALID_INPUT` envelope.
  Connections, env vars, the credential store, toil projects, the workspace (the program's
  working directory, else `workspace`), the write gate and the audit log all apply as
  they do on the CLI. It serves what MCP serves: commands that prompt or change
  connections, and deletes, stay on the CLI, except as `person` below allows.
- **`options`**: `readOnly` refuses, with `WRITE_DISABLED` and before anything is sent,
  any call that would change anything, whatever the config says: a write to a service,
  and a local one too (toil's config or toil projects, a download, a file named with
  `out`). A read-only call writes nothing but its audit line. `caller` names the program in the audit log (lowercase letters, digits,
  `.`, `_` and `-`, up to 64), and `actor`, in the same characters, who it called
  for (Toil UI names an agent assignment, `assignment-<id>`). `signal` cancels the call (`CANCELLED`). `onProgress`
  hears every request (redacted URL, status, time), page and retry. `config`,
  `workspace` and `verbose` match `--config`, `--workspace` and `--verbose`.
- **`person`** is for a program with its own interface for a person, such as Toil
  UI's settings pages. It is `{ ask(question) }`, and with it `execute()` also runs
  the connections commands a person runs on a terminal: `connections add`, `login`,
  `remove`, `writes` and `default`, `toil projects onboard`, and `feedback`
  (`registry.personCommands`). Each question arrives as `{ id, text, secret,
  fallback }`, and `ask` returns what the person typed. The `id` is one of `area`,
  `setting:<key>`, `secret:<key>`, `confirm` (`y` saves what they reviewed),
  `confirm-name` (the connection's name, typed to turn writes on), `unwrap:<key>`
  (the secret is in quotes or starts with `Bearer ` or `token `: `y` stores it
  without them, `n` as typed; call `checkSecret` first to know whether it will be
  asked), for `toil projects onboard` `create:<section>` (`y` adds the connection that
  section needs), `name:<section>` (its name) and `pin:<section>` (the matching
  connection their own copy uses), or `consent` (`yes` sends the feedback report and
  disclaimer the question shows, **Feedback**, above). A secret is checked as on a
  terminal (`checkSecret`, below), but asked once: a refused or empty required one is
  `INVALID_INPUT`, with the terminal's words. With `readOnly`, nothing is asked: `feedback`
  only previews. Return `undefined` for a question they weren't asked, and the
  command saves or sends nothing (`CANCELLED`). A secret goes from the answer to the OS
  credential store: it is never in the input, the envelope or the audit log. The
  program must ask a person and pass on their answers. Nothing about this lets an
  agent run these commands.
- **`registry`** lists every command `execute()` serves: its name, MCP tool name,
  whether it writes to a service (`writes`) or on this machine (`writesLocal`), and
  its input's JSON Schema. It also lists the areas, each with `connection`: the
  fields `connections add` asks for, in order, each with `secret`, `password`,
  `default` and `required`.
- **`version`** and **`contractVersion`** are what `toil version` reports. Check
  `contractVersion` before relying on anything else. `toil version` also reports
  `commit`, the 40-character hash of the commit the build came from (`null` when the
  build didn't record one), which is what a bug report from a terminal names.
- **`mapOwi(input, options)`** maps envelopes you already hold (one, an array, or
  JSON Lines text) to Open Work Items and pull requests to changes, the way `toil
  util owi map` does (`util.md`), synchronously and without the schema check:
  `{ items, changes, histories, skipped, warnings }`. `options.fields` is a toil project
  section's `fields` object (`{ estimate: 'customfield_10234', estimateUnit: 'points' }`),
  `command` names the command for bare `data`, `key` the item a keyless history
  belongs to, `keyPatterns` where work item keys in a pull request point
  (`['PAY-{n}=corp-jira']`), and `authorKinds` the author kinds set by hand
  (`{ 'release-bot': 'BOT' }`). A refused input throws, with a fix. **`owiVersion`** is the OWI version items carry,
  and **`owiSchema`** their JSON Schema; `execute('util owi map', { text })` maps
  and validates in one call.
- **`checkSecret(raw, rules)`** runs the paste checks `connections add` and
  `login` run on a secret, for a program whose person types one into its own field
  (Toil UI's settings): `rules` is `{ password, empty }`, `empty` being `required`,
  `keep` or `skip`. It returns `{ status: 'ok', value, length, removed, received,
  wrapper }` (`received` is the terminal's `Received 40 characters …` line, and
  `wrapper`, when set, has the `question`, `what`, the value `without` it and its
  `withoutLength`), `{ status: 'refused', message, fix, length }`, or `{ status:
  'empty', empty, message, fix }`. Nothing
  it returns holds part of the value but the value itself.
- **`findSimilar(records, request, options)`** finds likely duplicates among OWI
  records you already hold (mapOwi's `items`, or the text `util owi map` printed),
  scored the way `toil util owi similar` scores them (`util.md`), in-process:
  `{ query }` ranks them against some text, `{ item }` against one of them by OWI
  id, and `{ pairs: true }` lists likely duplicate pairs. `options` takes
  `fields`, `limit` and `threshold`. It returns `{ mode, method, count, matches,
  pairs, search }`, each match and pair with its `score` and `why`, the same for
  the same records every time. For a very large set, use
  `execute('util owi similar', …)`, which runs in a worker with a deadline.

What `@imagile-dev/toil/api` exports, and the types it names, follow the command
contract: they change only additively unless `contractVersion` goes up. Anything else
in the package is internal.

## Feedback

`toil feedback bug|feature` sends a bug report or a feature request to Imagile LLC,
where it becomes a public GitHub issue in `imagile-dev/toil`, and the reporter is
emailed when it's filed and when it closes. It is CLI only, never an MCP tool, and the
one request toil makes to a host you didn't configure. Every report carries this
disclaimer, version 1, and nothing is sent until the person sending it agrees to it:

> Your report is sent to Imagile LLC to improve toil, and it becomes a public GitHub
> issue in imagile-dev/toil. Your email address stays private: it is used only to tell
> you about your issue. Before you send, remove company data: internal URLs and
> hostnames, ticket keys, repository and project names, people's names, other
> identifiers and credentials. You are responsible for what you send.

```bash
toil feedback bug --title "jira issue search ignores --limit" --body "toil jira issue search --limit 5 returns 50 issues." --email you@example.com
```

| Flag | Meaning |
|------|---------|
| `--title <text>` | One line, up to 120 characters |
| `--body <text>` | The details, up to 4000 characters |
| `--email <address>` | The reporter's own address, kept private |
| `--input-file <file>` | JSON with any of `kind`, `title`, `body` and `email`, for long text; a flag beats the file, and `-` reads stdin |
| `--consent` | Send it. Without it nothing is sent |

Without `--consent`, the command sends nothing. On a terminal it shows the report and
the disclaimer and asks; anywhere else it returns `sent: false`, the exact `report`
it would send, the `disclaimer`, `consentVersion` and how to approve, with a
`FEEDBACK_NOT_SENT` warning. With `--consent` it sends that same report and returns
`sent: true` and the endpoint's message. The report is the kind, title, body and email
given, plus `version`, `commit` and `consent` (the disclaimer's version). toil never
adds config, connection names, hosts or tokens. A build that doesn't know its commit
previews but can't send (`UNSUPPORTED`); the form at
https://imagile-dev.github.io/toil/about/feedback/ works from any browser.

**An agent sending feedback for a user follows every step, in order, every time:**

1. **Only when the user asks.** Never offer to send a report on your own initiative,
   and never send one because a command failed.
2. **Scrub it.** Replace company data with neutral placeholders before the user sees
   the draft: internal URLs and hostnames (`jira.imagile.dev`), ticket keys
   (`PROJ-123`), repository, project and team names (`my-repo`), people's names
   (`a colleague`), email addresses other than the reporter's own, IDs, tokens,
   passwords and anything else credential-shaped. Keep toil's own command names,
   flags and error codes; they're what makes a report useful.
3. **Show it.** Run the command without `--consent` and show the user the full
   `data.report` it returned, and the `data.disclaimer`, word for word.
4. **Ask.** Get the user's explicit yes in chat to sending that exact report. A yes to
   an earlier draft, or to feedback in general, isn't one.
5. **Send it.** Only then run the same command again with `--consent`, unchanged. If
   the user asks for any change, make it, and go back to step 3.

Through `@imagile-dev/toil/api`, `feedback` runs only for a `person` (below), whose
`yes` to the `consent` question sends it; the `consent` field is refused there, and a
`readOnly` call only previews. `TOIL_FEEDBACK_URL` points the command at a local copy
of the feedback function for testing, and takes only a loopback address
(`http://127.0.0.1:7071`).

## Certificates and proxies

toil trusts the OS certificate store and Node's bundled CAs, and uses `HTTPS_PROXY` /
`HTTP_PROXY` / `NO_PROXY` when they're set. A `NETWORK` error about an untrusted
certificate means the CA is in neither; `NODE_EXTRA_CA_CERTS` adds it. A database
connection can also take one CA file of its own (`tlsCaFile`), and a name to verify the
certificate against when the server is reached by another one (`tlsServerName`); see
**Cloud and private CAs** in `db.md`.
