# Dossiers

Tracking: [#16](https://github.com/imagile-dev/toil/issues/16). Builds on named
connections, [#51](https://github.com/imagile-dev/toil/issues/51) (core in #59).

**What's built:**
- reading dossiers from all three places, with validation on every read
- choosing the one that applies: by name, by file, from `TOIL_DOSSIER`, or from the folder
- host selectors, environments and the write rule
- `meta.context.dossier`
- `toil dossiers list | show | check | context`, which read
- `toil dossiers init | add-repo | link | env | field | person | wip-limit | describe | export | import | unlink | remove`, which
  build and share (`src/core/dossier.ts`, `src/dossiers/`)
- `toil dossiers onboard`, which sets a reader up for a repository's dossier (#333,
  `src/dossiers/onboard.ts`)
- `toil dossiers brief`, which briefs a dossier by code from Open Work Item records the
  caller passes, and `toil dossiers analyze set | show | prompt`, its Analyze settings
  and the prompt an agent runs, also served by `toil mcp` as the prompt `analyze`
  (#494, `src/dossiers/brief.ts`, `src/core/brief/`)
- field aliases on Jira's `--field` (Data Center and Cloud)
- `toil repos scan` (`src/repos/`)
- `toil <area> check-dossier` for every area a dossier describes: `jira`,
  `confluence`, `sonar`, `ado`, `bitbucket`, `github`, `openshift` and `dynatrace`
  (`src/core/check-dossier.ts`)

The commands are `toil dossiers`, plural, like `toil connections`.

A **dossier** is everything toil needs to work on one body of work, whether that's
one service or fifty microservices: its repositories, issue-tracker keys and field
names, boards, documentation spaces, quality-gate keys, and the runtime resources of
each environment. Users build one once, usually with an agent doing the discovery,
and toil works out which dossier applies from the folder they're in. A dossier can be
kept privately or checked into a repository for a whole team to share.

## Three kinds of configuration

| | Holds | Where | Who edits it |
|---|---|---|---|
| **Connections** (#51) | One instance of a service: area, host, credential, `writes` | `~/.toil/config.json` | The user, via `toil connections`. Never an agent over MCP. |
| **Dossiers** | Repos, keys, field names, boards, environments. Selects connections; never holds a secret or turns on writes. | `~/.toil/dossiers/`, or `.toil/dossiers/` in a repository | The user or an agent, via `toil dossiers` |
| **Env vars** | Any connection setting, including whole connections, for CI | The process environment | The pipeline |

**Why a dossier may live in a repository when config may not.** There is no
repository-level config file (#13): a file in a repository could switch on writes or
send credentials to a host of its choosing. A dossier can do neither. It holds no
secret and no `writes`, and it only *selects among connections the reader already
has*; it can never create one or send anything to a host. So a checked-in dossier is
project knowledge, reviewable like any other file, and it can't change where
credentials go.

## Connections

The connection model, including where secrets live, is specified in #51 and
implemented in #59. What dossiers rely on:

```jsonc
// ~/.toil/config.json
{
  "version": 3,
  "connections": {
    "corp-jira":  { "area": "jira",       "baseUrl": "https://jira.imagile.dev" },
    "imagile-cloud": { "area": "jira",    "deployment": "cloud", "baseUrl": "https://jira-cloud.imagile.dev", "email": "you@example.com", "writes": true },
    "ocp-prod":   { "area": "openshift",  "baseUrl": "https://api.ocp.imagile.dev:6443" }
  },
  "defaults": { "jira": { "connection": "corp-jira" } }
}
```

- An area can have any number of connections. `defaults.<area>.connection` picks one
  when nothing else does; other keys under `defaults.<area>` are shared by every
  connection to that area, **except `writes`, which is never read from `defaults`**.
- `writes` is per connection, so writes can be on for a sandbox and off for
  production. It is the control that matters: since #59 every area command takes a
  `connection` input, so whoever runs a command can already choose any connection.
  The dossier rules below stop a dossier from *silently* redirecting a write; they
  aren't what keeps production safe. Per-connection `writes` is.
- **Version 1 still loads**, as one connection per area named after the area and set
  as its default.

### Connections from env vars alone

CI has no config file, so env vars can define a connection from scratch:

```
TOIL_CONN_OCP_PROD_AREA=openshift
TOIL_CONN_OCP_PROD_BASE_URL=https://api.ocp.imagile.dev:6443
TOIL_CONN_OCP_PROD_TOKEN=...
```

- **`TOIL_CONN_<NAME>_AREA` creates the connection.** Other `TOIL_CONN_<NAME>_*`
  variables set its keys, overriding config for a connection that also exists there.
- **Names can't be ambiguous.** A connection name is lowercase letters, digits and
  single hyphens (`corp-jira`, never `corp_jira`), so its env form (`CORP_JIRA`) maps
  back to exactly one name. A variable is matched to the longest known connection name
  first, then its remainder must be a key the connection's area declares. A remainder
  that isn't a declared key is a `CONFIG_UNKNOWN_KEY` warning, never a guess. When two
  names could both claim a variable (`corp` with a key `jiraBaseUrl`, and `corp-jira`),
  `toil config check` reports it.
- **Writes:** `TOIL_CONN_<NAME>_WRITES` is per connection. `TOIL_<AREA>_WRITES` applies
  only to the area's default connection.

## A dossier

```jsonc
// ~/.toil/dossiers/payments.json, or .toil/dossiers/payments.json in a repository
{
  "name": "payments",
  "description": "Payments platform",
  "repos": [
    { "name": "payments-api", "path": "C:/Code/payments-api", "remotes": ["https://bitbucket.imagile.dev/scm/pay/payments-api.git"] },
    { "name": "ledger-svc", "remotes": ["https://bitbucket.imagile.dev/scm/pay/ledger-svc.git"] }
  ],
  "jira": {
    "host": "jira.imagile.dev",
    "projects": ["PAY", "LEDG"],
    "fields": { "acceptanceCriteria": "customfield_10234", "storyPoints": "customfield_10002" }
  },
  "ado": { "connection": "corp-ado", "project": "Payments", "boards": ["Payments Team"], "areaPath": "Payments\\API" },
  "confluence": { "host": "confluence.imagile.dev", "spaces": ["PAY"] },
  "sonar": { "host": "sonar.imagile.dev", "projectKeys": { "payments-api": "pay-payments-api" } },
  "environments": {
    "test": { "openshift": { "host": "api.ocp-nonprod.imagile.dev", "namespace": "payments-test" } },
    "prod": {
      "openshift": { "host": "api.ocp.imagile.dev", "namespace": "payments-prod", "deployments": ["payments-api", "ledger-svc"] },
      "dynatrace": { "host": "dynatrace.imagile.dev", "entities": ["SERVICE-abc12345"] }
    }
  }
}
```

- **An area's section needs nothing from the area.** Its keys are:
  - `connection` or `host`, which select the connection (below), never both;
  - `fields`, the field aliases (below);
  - `transitions`, the pinned transitions (below);
  - the area's own context inputs by name (`project`, `owner`, `namespace`), each
    either a value or an object of repo name to value (`"project": { "payments-api":
    "PAY", "ledger-svc": "LEDG" }`), the value for the repo the folder matched. When
    the folder matches none of the dossier's repos, a per-repo value is not read
    from git or the connection either: a command that needs it fails with `INVALID_INPUT` naming the
    dossier's repos (run from one of them, pass `--cwd`, pass the flag, or give the
    key a plain value), and one that doesn't gets nothing for it, with a
    `DOSSIER_REPO_UNMATCHED` warning that says why. A value you pass always wins,
    and so does choosing a target yourself: pass another of the section's per-repo
    inputs (`--repo`) and the rest resolve as usual, with the same warning saying
    which source each one came from instead. A folder that matches a repo the
    map doesn't name resolves as usual too;
  - anything else (`projects`, `boards`, `deployments`) is reference data, kept as
    written for people and agents to read with `toil dossiers show`, and never applied
    to a call. A value listed twice in it is still reported.

  A dossier is validated section by section, so an unknown area's section is kept but
  reported (`DOSSIER_UNKNOWN_SECTION`), never dropped.

  A `jira-cloud` section is read as `jira`, a `confluence-cloud` one as `confluence`, a
  `bitbucket-cloud` one as `bitbucket` and an `ado-cloud` one as `ado` (those areas are now `jira`, `confluence`,
  `bitbucket` and `ado`, with `deployment` on the connection, #495). So is such an entry under
  `environments.<env>` and in a person's `ids`. Each is reported as `DOSSIER_RENAMED_AREA`
  by key path, saying to rename it; where the dossier already has the new entry, that one is
  used and the warning says the old one is ignored. **A dossier has one section per product
  (`jira`, `confluence`, `bitbucket`, `ado`), so each picks one connection**: a body of work that uses
  both a Data Center and a Cloud Jira, Confluence or Bitbucket, or both Azure DevOps Server and
  Services, takes two dossiers. A
  `bitbucket` section can hold `project` and `repo` (Data Center) or `workspace` and `repo`
  (Cloud); the other deployment's input is ignored for a connection that doesn't take it.
- **`env`** names the environment the dossier works in by default; it must be a key of
  `environments`.
- **`people`** (#292) lists the team, agents included: `{ "name": "Pat Example",
  "kind": "human", "email": "you@example.com", "ids": { "jira": "pat", "github":
  "pat-ex", "ado": "you@example.com" } }`. `kind` is `human` (the default) or `agent`;
  `ids` maps an area to the account it knows the person by. Names and identities are
  unique (an identity compares without case), and a value shaped like a token is
  refused by key path, never echoed: an identity is a name, not a credential.
  `wipLimit`, a whole number above 0, is how many items one person may have in
  progress at once. toil reads `wipLimit` only in `toil dossiers brief`, for its load
  lens, and reads `people` not at all; Toil UI's People view reads both.
- **`analyze`** holds how Analyze briefs the dossier (#494): `goal`, `audience`
  (`lead`, `engineer` or `stakeholder`), `lenses` (each `{ id, on, threshold }`, in the
  order to apply them; any not listed follow in the standard order), and `watchFor`
  and `leaveOut`, words for the agent, up to 1000 characters each and never shaped
  like a credential. Absent, the standard applies. A focus from a dossier the reader
  hasn't adopted still applies, labelled with where it came from (the maintainer's
  decision on #494).
- **Remotes are only for matching.** toil never contacts a remote URL. Before storing,
  comparing or printing one, toil strips any userinfo
  (`https://user:<token>@host/...` becomes `https://host/...`), so a token embedded in
  `.git/config` never reaches a dossier or an envelope. A dossier that still contains
  a remote with userinfo, hand-edited or imported, gets a `DOSSIER_REMOTE_USERINFO`
  warning on every read and fails `dossiers check`. A login name with no password
  (`git@host:path`, `ssh://git@host/...`) isn't a credential and stays.

### Selecting a connection

Each area section says which of the reader's connections it means, in one of two ways:

- **`connection`: a name.** Right for a private dossier: `"connection": "corp-ado"`.
- **`host`: a selector.** Right for a shared one, because teammates name their
  connections differently. `"host": "jira.imagile.dev"` picks the reader's `jira`
  connection whose `baseUrl` has that host (compared case-insensitively, scheme and
  port ignored unless the selector gives a port).
- **Neither:** the area's default connection.

A host in a dossier is **only a selector**. toil never sends a request to it, never
creates a connection from it, and never uses it as a `baseUrl`. When no connection
matches, the call fails with `NOT_CONFIGURED`, naming the host and the command to add
a connection for it. When several match, it fails with `INVALID_INPUT`, listing them
and saying to pick one with `connection`. A selector never falls back to the default
connection, because a silent fallback could point the dossier somewhere the author
didn't mean. A connection matches on its `baseUrl`'s host, or on a `host` setting for
an area that has one instead (a database). An area whose API lives on another host
names it (`defineArea({ siteApis })`): `host: github.com` also matches a GitHub
connection on `api.github.com`, and sharing that connection records `github.com`. `meta.context.connection` then carries the
`host` that matched.

A `connection` that names no connection you have fails the call too, as an unknown
`--connection` does; `dossiers check` reports it as `DOSSIER_UNKNOWN_CONNECTION`.

### Field aliases

`fields` maps friendly names to the service's field ids, so field ids never leak into
prompts. The names are used through **one fixed input**, never through generated flags:

- The commands that take custom fields already have one: Jira's
  `--field Name=value` (Data Center and Cloud) (`field` over MCP), repeatable. An alias works there wherever
  the dossier applies (`--field storyPoints=5`), so the schema is the same whichever
  dossier resolves. MCP tool schemas stay fixed, and the CLI and MCP stay identical.
  Core hands the area the aliases (`ctx.dossierFields()`) only when the call names a
  field, so a call without one never consults the dossier for them.
- An alias takes the type the connection registers for that field id (a number for
  story points). A name the connection's `customFields` already uses keeps the
  connection's meaning, and output keeps the connection's names.
- Aliases live in their own namespace, so `--field project=...` can never collide with
  `--project`. An alias is a camelCase identifier; anything else fails `dossiers check`.
- An unknown name gets the area's own unknown-field error, the same as without a dossier.
- The Open Work Item keys (`estimate`, `estimateUnit`, `priority`, `type`, `team`,
  `dueDate`, `iteration`, and GitHub's `estimateLabel` and `iterationDays`) point OWI
  mapping at the team's own fields (`docs/owi/spec.md`, Pointing a field at your own).
  Toil UI passes them to `mapOwi` for the section's area; nothing else reads them.
  Like every value in `fields` they are text, so a number is quoted:
  `"iterationDays": "14"`. An unquoted `14` fails `dossiers check`.
- A code host's section (`github`, `bitbucket`, `ado`)
  may keep `authorKinds`, reference data mapping an author's id to
  `HUMAN`, `AGENT` or `BOT` (`"authorKinds": { "release-bot": "BOT" }`). Toil UI
  passes it to `mapOwi` as the override that wins over every other signal when it
  says who wrote a pull request (`docs/owi/spec.md`, Who wrote it); nothing else
  reads it.
- A work item area's section (`jira`, `ado`, `github`)
  may name `fields.acceptanceCriteria`, the field that holds acceptance criteria
  (also a `--field` alias like any other), and keep `readiness`, reference data
  `{ "minWords": 25, "templates": ["## What\n## Why"] }`. Toil UI's readiness gate
  (#307) reads both (`ui/README.md`, Readiness and the Command Center); nothing else
  reads them.

### Pinned transitions

`transitions` says, per work item type, which transition or status an intent means
for this body of work, where the item's own workflow doesn't settle it:

```json
"jira": { "transitions": { "Story": { "review": "Peer Review" } } },
"ado": { "transitions": { "Product Backlog Item": { "reopen": "New" } } }
```

- `--to <intent>` on `issue transition` (jira) and `work-item transition`
  (ado) reads it first, for the item's own type (compared ignoring case),
  and only for the four intents: `start`, `review`, `done`, `reopen`. The rest of the
  resolution is in `skills/toil/core.md`, **Moving work items by intent**.
- A pin is the author's word, so it never falls through to a guess: a pin naming no
  transition or status the item offers is `INVALID_INPUT`, naming the key path.
- An environment's section pins over the area's own, type by type and intent by
  intent.
- Anything but an object of type to intent to a non-empty name, or a key that isn't
  one of the four intents, is `DOSSIER_INVALID` with its key path.
- Core hands an area the pins (`ctx.dossierTransitions()`) only when the call gives
  an intent, so a call with an exact `--transition` or `--state` never consults the
  dossier for them.

## Where dossiers live

toil reads dossiers from three kinds of place, and every listing says which one a
dossier came from (`source`: `user`, `repo`, `listed`, or `file` for one passed by
path):

1. **Your own**, in `~/.toil/dossiers/<name>.json`. A dossier is known by its `name`,
   which is lowercase letters, digits and single hyphens, like a connection's.
2. **Checked into the repository you're in**, in `.toil/dossiers/*.json` at its git
   root. A service's repo can carry its own dossier.
3. **Folders you list**, for a team that shares dossiers for many services from one
   repository: clone it once and list its folder. Only folders you list are read;
   toil never searches for them.
   - In config, a top-level `"dossierPaths": ["C:/Code/team-dossiers/.toil/dossiers"]`
     in a version 2 or later file, each path absolute. It's a reserved top-level key, so it's
     never read as an area; a version 1 file ignores it with a warning.
   - From env, `TOIL_DOSSIER_PATHS`, separated by the platform's path delimiter (`;`
     on Windows, `:` elsewhere). It replaces the config's list, as env always wins.
     Every `TOIL_DOSSIER*` name is reserved, so no area can ever claim it.

A checked-in dossier applies only when you're in its repository, or when its folder
is listed.

**Which dossier applies is never a guess.**
- **Same name in two places:** your own wins, then a listed folder, then the
  repository you're in. So you can override a teammate's copy without editing it.
- **Different dossiers that both match** (two files in one repository, or your own
  `payments` and the repo's `payments-team`), with no explicit `dossier`: the call
  fails with `INVALID_INPUT` listing the candidates and saying to pass `dossier`.
  The answer never depends on hidden state such as which was used last.

## Validation on every read

A dossier is checked **every time toil reads it**, not only by `dossiers check`, and
problems show up where they'll be seen. That means a warning in `meta.warnings` on
whatever command read it, and the same list from `dossiers check`. A dossier with a
problem still loads where it safely can. A broken one doesn't, and the error says
which file and which key.

**A key added twice is always reported:**
- **Twice in the file.** `JSON.parse` keeps the last of two identical keys and drops
  the first without a word. toil reads dossiers with a parser that sees duplicates,
  and reports `DOSSIER_DUPLICATE_KEY` with the key path (`jira.fields.storyPoints`).
- **Twice in a list:** the same repo name, remote, project, field id, board or
  deployment. Remotes are compared after normalising.
- **Twice across files:** the same dossier name in two places (see **Where dossiers
  live**) is a warning naming both files, even when precedence settles which one
  wins. A call warns about the dossier it used; `dossiers list` shows every
  collision (`shadowedBy`), and `dossiers check` reports it for the one checked.

A file that won't load (not JSON, a wrong type, a bad name, a key named
`__proto__`, `constructor` or `prototype` anywhere in it, or more than 1 MiB, which
isn't read at all: `docs/bounds.md`, `dossiers.size`) is skipped with a
`DOSSIER_INVALID` warning when toil is looking for one that applies, and is
`CONFIG_INVALID` when a call names it. Those three key names belong to how
JavaScript objects work, so no section, environment, field or repo may use one. Either way the message gives the file, the key
path and, for bad JSON, the line and column, never the content.

**The commands never add a duplicate.** `dossiers add-repo`, `field`, `link` and `env`
refuse a key that's already there with `INVALID_INPUT`, naming the existing entry.
Changing it is an explicit replace (`--replace`), never a silent second copy.

## Resolving context

For each command, toil works out the dossier, the repo and the environment from one
resolver, **fed identically by both front doors**:

1. **Explicit input:** `dossier` (`--dossier` on the CLI, or `TOIL_DOSSIER`), a name
   or a path to a dossier file, so a pipeline can use a checked-in dossier with no
   home folder. Anything that isn't a valid name is a path. A path must end in
   `.json` and be in a dossier folder or inside the workspace (`dossiers.read` in
   `docs/bounds.md`). The environment is not a separate flag: it's the `env` context input
   of each area that has environments (`--env`), and the dossier's environment
   supplies that same input when the call leaves it out (see below).
2. **Otherwise a folder, `cwd`.** `cwd` is an input on every command that resolves
   context, on both front doors (`--cwd <dir>` on the CLI, `cwd` over MCP). The name
   says what it stands in for, and it can't clash with a command's own path input
   (a folder for `repos scan`). Left out, it's the workspace (`--workspace`,
   `TOIL_WORKSPACE`, then the CLI's working directory, or the client's MCP root if
   the client reports exactly one), which is the folder the git step already read.
   A relative `cwd` resolves against the CLI's working directory, or the workspace
   under MCP. A stdio server starts wherever its client launched it, so its
   own working directory means nothing. With neither, there is no folder, and step 4
   applies. `cwd` only chooses context; which files a command may read or write is
   the workspace's business (`docs/bounds.md`), and `cwd` never widens it.
3. **From that folder,** toil finds the git root and matches a repo by `path`, then by
   `remotes` against the folder's origin, so a fresh clone anywhere still resolves. A
   dossier checked into that repository is a candidate too (see **Where dossiers
   live**). A `cwd` the call names also moves the git step and the repository a
   command reads (`ctx.repo()`) to that folder.
4. **Otherwise** there is no dossier, and commands need their keys as inputs, exactly
   as without dossiers.

Explicit inputs always beat dossier defaults. Inside a command, the dossier is step 2
of core's context resolver (`resolveCall` in `src/core/call-context.ts`), through its
`DossierLookup` seam: for each context input an area declares, and for `connection`,
the order is the call's own value, then the dossier, then the git remote where the
area reads one, then the connection's setting, then the area's default. The one
exception: a per-repo dossier value that no repo of the dossier matched is not passed
on to git or the connection (see the section's inputs, above).

**One `--env`.** "Which environment" is one input everywhere: an explicit `--env`
wins, otherwise the dossier's environment fills it through the resolver, and an
environment the area doesn't know is an `INVALID_INPUT` listing the ones it has.
`--help` says so (`--env <name>`: the environment; defaults to your dossier's
environment, then the connection's). The dossier's `env` fills `--env` for each area
its environment lists (`environments.<env>.<area>`); an area the environment doesn't
mention gets no `--env` from it. The environment also decides which sections apply:
`environments.<env>.<area>` first, then the area's own section, where `<env>` is the
call's `--env` when the area has one, else the dossier's `env`. So `toil openshift
--env prod ...` takes the prod namespace and the prod binding even when the dossier's
default is `test`. `toil dossiers show` prints the result per area: connection and
why, writes on or off, environment and inputs.

**Writes ask once.** A connection the dossier chose (or the git remote, through a
selecting input) is a suggestion: reads follow it, but a write on it is
`WRITE_DISABLED` until the user adopts that binding. A dossier in your own folder is
adopted: its bindings are yours. A checked-in, listed or loose one isn't, and `toil
dossiers import` adopts it by copying it into your folder.

**Writes take their target only from dossiers you've adopted.** Where in the service
a write lands is as much a choice as which connection: a write whose target context
inputs (github `owner` and `repo`, a Jira or ADO `project`, a Bitbucket `project` and
`repo`, any context input that doesn't select a connection) came from a dossier you
haven't adopted is `WRITE_DISABLED` before the write is sent, even on your own default
connection. Only an input the write actually uses counts: the check is made when the
command reads it, so an Azure DevOps work-item update isn't refused over the
dossier's `project`, which that write never names. The fix names `toil dossiers import <name>` (the CLI only; over MCP and
the API it says to ask the user to adopt the dossier) and the flags to pass the
target yourself. An input you pass, or one from the connection, the git remote or the
default, is yours already. Reads are unchanged, and so are a dossier's field aliases
and transition pins (#302), which still apply from any dossier.

`meta.context` in the envelope reports what was resolved and from where: `{ dossier,
connection, inputs, shared }`. The connection and each context input are `{ value,
source }` (source `input`, `file`, `dossier`, `git`, `connection` or `default`, with
`via` when an input selected the connection and `host` when a dossier's host selector
did; the connection also carries `deployment` for an area whose variants are keyed on it,
such as Jira), and `shared` any setting taken from another area's connection. `dossier`, when
one applied, is:

```jsonc
{
  "name": "payments",
  "source": "user",            // user, listed, repo, or file (one named by path)
  "file": "C:/Users/you/.toil/dossiers/payments.json",
  "by": "folder",              // input (--dossier), env (TOIL_DOSSIER), or folder
  "match": "remote",           // path, remote, or checked-in
  "repo": "payments-api",      // the dossier's repo the folder is
  "folder": { "path": "C:/Code/payments-api", "from": "cwd" } // from: input, flag, env, cwd, mcp-root
}
```

Dossiers are read on every call, so an edit made while `toil mcp` is running applies
from the next call; the tool list never depends on dossier content.

### The filesystem the server sees

Every file location is an explicit input on both front doors: `cwd`, a dossier
file, an import source. (`--repo` is a context input naming a repository in a
service, not a folder.) That keeps the CLI and MCP 1:1. The defaults are the
only difference, and `meta.context` will name them once `cwd` arrives with this plan. The server can only use paths on its
own filesystem, so:

- MCP roots arrive as `file://` URIs and are converted with Node's own URL handling,
  never by string slicing.
- A path that doesn't exist on the server's side is an `INVALID_INPUT` that says so.
  It isn't a silent "no dossier". That's what an agent in a sandbox, a container, or
  WSL talking to a Windows server will see, and it can then pass `dossier` by name.
- The planned MCP gateway (#4) shares no filesystem with its clients. There, path
  inputs are refused with that explanation, and dossiers are selected by name.

### Reading git without git

*No Executables*: toil never runs `git` to find a root or a remote. It parses the
files directly:

- `.git` may be a directory, or a **file** containing `gitdir: <path>` (worktrees and
  submodules). For worktrees, `commondir` points at the shared config.
- `config` is read with `[include] path` and `[includeIf "gitdir:..."]` honoured.
  Other `includeIf` conditions are skipped and reported in `meta.warnings`.
- Remotes are normalised before comparison: userinfo stripped, scp-style
  `git@host:path` read as `ssh://host/path`, host lowercased, a trailing `.git` and
  `/` dropped, and the scheme and port ignored, so the SSH and HTTPS remotes of one
  repo match.

## Commands

- **Building a dossier** (all served over MCP, all local writes, none needs
  `--allow-write`; each returns the change it made, and `changed: false` when there
  was nothing to change):
  - `toil dossiers init <name> [--description <text>]` creates `~/.toil/dossiers/<name>.json`.
    `--shared [--repo <root>]` creates `<root>/.toil/dossiers/<name>.json` instead, in
    the folder's own repository unless `--repo` names one.
  - `toil dossiers add-repo <dossier> <folder|remote> [--name <repo>]` adds a repo. A
    folder records its git root as the path, plus its origin with any credential
    stripped. A remote URL records just the remote.
  - `toil dossiers link <dossier> <area> [--connection <name> | --host <host> | --unbind]
    [--set key=value ...] [--add key=value ...] [--for-repo <repo>]` changes an area's
    section. `--set` sets one of the area's context inputs, or reference data, and
    `--for-repo` makes the value that one repo's. `--add` appends to a reference list.
    A context input's value is checked against the area's own rule first.
    `--set env=` is refused: the environment is the dossier's `env` (set with
    `dossiers env ... --default`) or the call's `--env`, never a section's.
    `--connection` on a dossier others read (checked in, listed, or a loose file)
    records that connection's host instead: on a terminal after a y/n that may keep
    the name, anywhere else with a `DOSSIER_HOST_RECORDED` warning.
  - `toil dossiers env <dossier> <env> <area> [--default] ...` does the same for
    `environments.<env>.<area>`. `--default` makes it the dossier's `env`.
  - `toil dossiers field <dossier> <area> <alias> <field-id>` names a field.
  - `toil dossiers person <dossier> <name> [--id area=identity ...] [--kind human|agent]
    [--email <address>]` adds someone to the dossier's `people`, or more identities to
    someone already there: the user name, login or email each area knows them by. A
    value shaped like a token is refused, as is an identity already another person's.
    `--remove` takes the person out, or with `--id` only those identities; it's a
    delete, so it runs on the CLI only (refused over MCP and the API).
  - `toil dossiers wip-limit <dossier> <limit>` sets how many items one person may have
    in progress at once, which Toil UI's People view and `toil dossiers brief` count
    against. `--clear` removes it, on the CLI only.
  - `toil dossiers analyze set <dossier> [--goal <text>] [--audience <who>] [--order
    <ids>] [--on <id>] [--off <id>] [--threshold <id=n>] [--watch-for <text>]
    [--leave-out <text>]` tunes how Analyze briefs it. A value already set needs
    `--replace`; `--clear <setting>` and `--reset` are deletes, on the CLI only.
  - `toil dossiers describe <dossier> [--name <new name>] [--description <text>]`
    renames one of your own dossiers or replaces its description, or both. A rename
    writes `~/.toil/dossiers/<new name>.json` with everything the dossier held, checked
    first, then deletes the old file, so a refusal leaves it where it was. A name you
    already have is refused, and so is a dossier that isn't in your own folder, with the
    `toil dossiers import` fix. It needs no `--replace`: replacing is all it does.
  - `toil dossiers unlink <dossier> --area <area> [--env <env>]` removes a section, an
    area's own or one environment's, including one for an area toil doesn't have. An
    environment left with no areas goes too, and stops being the default. CLI only, like
    `remove`.
  - `toil dossiers remove <name>` deletes one of your own dossiers. It runs on the CLI
    only, since a delete is never an MCP tool.

  Each refuses a value already there, naming it, unless `--replace`. The file is
  checked with the reader that will load it before anything is written. Remotes are
  read with any credential stripped, so every write leaves the file without one; the
  result names each remote it cleaned (`credentialsRemoved`, and a
  `DOSSIER_REMOTE_USERINFO` warning). Re-adding a repo by a remote it already lists
  (`add-repo <dossier> <remote> --name <repo>`) adds nothing, needs no `--replace`, and
  is the way to clean one on its own.
- **Reading and checking** (built; all served over MCP, all local reads):
  - `toil dossiers list [--cwd <dir>]` lists every dossier toil can see, with its
    `source`, the file that shadows it when two share a name, and broken files with
    what's wrong.
  - `toil dossiers show [<name|file>] [--cwd <dir>]` prints one (by default the one
    the folder resolves to) and, per area it covers, the connection a call would use
    and why, whether writes are on for it, the environment and the inputs it supplies.
  - `toil dossiers check [<name|file>] [--cwd <dir>]` checks **locally only**:
    - the schema, keys given twice, unknown sections and aliases
    - every `connection` exists and every `host` selects exactly one connection
    - remotes are free of userinfo
    - which bindings in a dossier that isn't your own land on a connection with
      writes on (a warning: a write through them needs `import`)
    - a `connection` name in a dossier that isn't your own (`DOSSIER_CONNECTION_SHARED`,
      a warning naming the `host` to use instead)

    It contacts no service. `data.ok` is false, and the CLI exits 1, when there's an
    error; a dossier too broken to load is reported the same way.
  - `toil dossiers context [--cwd <dir>]` shows what a folder resolves to: its
    repository and origin (credentials stripped), the dossier and why, and every
    candidate when more than one matches.
- **Checking against the services** is one area at a time, because a command talks to
  one service. `toil <area> check-dossier [--dossier <name|file>]` looks every value
  the call's dossier gives that area up on the service, using and reporting the
  connection it resolved. An agent or a script composes them:
  - `jira`: projects (`project`, `projects`) and field ids
  - `confluence`: spaces (`space`, `spaces`)
  - `sonar`: project keys (`project`, `projectKeys`, `projects`)
  - `ado`: team projects in their collection, and repos in their project. The
    collection is the section's, else the call's; none at all is `INVALID_INPUT`.
  - `bitbucket`: projects, and repos in their project
  - `github`: owners, and repos under their owner
  - `openshift`: namespaces (as projects the token can see), and `deployments` in
    their namespace. With several namespaces (one per repo), a deployment passes
    when any of them has it, and its check's `note` says where it was looked for,
    since a `deployments` list doesn't say which repo each belongs to.
  - `dynatrace`: entity ids (`entity`, `entities`)

  A repo and its project (or owner) pair up per repo: `"project": { "api": "PAY" }`
  with `"repo": { "api": "payments-api" }` checks `PAY/payments-api`. Only the area's
  own section and the call's environment's (`--env`, else the dossier's `env`) are
  checked, because another environment's section may select another connection:
  check it with a call in that environment. Values are read as a call reads them: a
  key the environment's section sets shadows the area's own, and keys pair across
  the two. A value that can't be looked up (a repo with no project or owner, a
  deployment with no namespace, an ado project with no collection) is listed under
  `unchecked`, with a `DOSSIER_UNCHECKED` warning, and makes `ok` false.

  Each returns `{ dossier, connection, env, ok, checked, checks, unchecked }`, one check per value with
  its key path. The CLI exits 1 when one is missing. A failure that isn't "not found"
  (a bad token, an unreachable host) fails the command. An area adds one with
  `src/core/check-dossier.ts` and `ctx.dossierView()`.
- **Onboarding to a repository that has a dossier:** `toil dossiers onboard
  [<name|file>] [--cwd <dir>] [--plan] [--pin <area>=<connection>]`, CLI only (and the
  API with a `person`), never MCP. Per section that picks a connection, it reports
  `matched` (your connection by `host`, `connection` or default), `missing`, or
  `ambiguous`. On a terminal it offers to add a missing one through `connections add`'s
  own flow, offering a base URL on the host (the area's `siteApis` say github.com's is
  `https://api.github.com`) and refusing one on any other host before saving; and asks
  which ambiguous one to pin, writing it into your own copy in `~/.toil/dossiers/`
  (`--pin` takes an area, or one section's key path such as `environments.prod.github`).
  It ends with `dossiers check` and one `connections test` read per connection, and
  the CLI exits 1 unless every area resolved and read. With no terminal, or `--plan`,
  it adds nothing and each area carries a `fix` and a `suggest`.
- **Sharing through a repository:**
  - `toil dossiers export <name> --repo <dir>` writes `.toil/dossiers/<name>.json`
    into that working tree. It's written for sharing: a `connection` name is replaced
    by a `host` selector taken from that connection's `baseUrl`, and `path` entries,
    which are machine-specific, are dropped. toil writes the file and stops; it never
    stages or commits. Committing is the agent's or user's own git workflow.
  - `toil dossiers export <name> --file <path>` writes a single file, for any other kind
    of sharing.
  - `toil dossiers import <file|dir> [--name <new>]` copies a dossier into your own
    folder, so you can adapt it. That's adoption: your copy wins wherever the original
    applied, and writes may then follow its bindings. An import never creates
    connections; any connection or host it can't resolve is listed under `toSetUp`.
    Everything is checked before anything is written, and a name you already have
    needs `--replace`.
- **Where export may write.** Exports are bounded, because over MCP an agent chooses
  the path (`dossiers.write` and `dossiers.replace` in `docs/bounds.md`):
  - `--repo` must be a git root, found the way **Reading git without git** finds one.
  - `--file` must end in `.json`, and may not be inside `~/.toil/` unless it's under
    `~/.toil/dossiers/`, so an export can never replace the config. It must also be
    inside the workspace or a dossier folder, as every other file a command writes is.
  - Neither overwrites a file that isn't already a valid dossier. Replacing an
    existing dossier needs `--replace`.
- **What import reveals.** An import that fails reports schema problems only, by key
  path, and never echoes the file's content. Pointing it at `config.json` can't read
  connections back out.
- **Discovery** is read-only and runs through ordinary commands, not dossier magic.
  `toil repos scan [<folder>] [--depth <n>]` lists the local git repos under a folder
  inside the workspace, each with its root, branch and remotes (credentials stripped),
  read from `.git` with no git installed. It walks 3 levels by default, never follows
  links, and doesn't go into a repository or into folders like `node_modules`. The
  rest is the areas' own reads: `toil jira issue fields --project PAY`, `toil jira
  board list --project PAY`, `toil confluence space list`, `toil sonar project list --query payments`,
  `toil openshift cluster list`.

## Agents and the write gate

The intended setup is a conversation. The agent runs discovery, proposes a dossier,
the user confirms, and the agent applies it with the `dossiers` commands, including
exporting it into a repository for the team.

- **Agents may** read and write dossiers, in your folder and in a repository working
  tree. They are non-secret and every edit goes through the same validated commands.
  Writing a dossier is a local write, so it doesn't need `--allow-write`, which
  governs changes to remote systems.
- **Agents never** create or change connections, credentials or `writes`
  (*principle 2*). No tool for those exists over MCP.
- **A dossier never silently points a write somewhere new.** A write takes its
  connection and its target (owner, repo, project) only from a dossier you've adopted
  (**Writes ask once**, above); `execute()` enforces that on every call. Over MCP, the dossier
  commands refuse any change that would make a section select a connection with
  `writes: true` when it didn't before:
  - setting `connection` or `host` to one that selects such a connection
  - changing or clearing a binding when the result is a writes-enabled connection,
    including a fall-back to the area's default
  - importing or exporting a dossier with such a binding

  A change is judged by the call's own resolver (`dossierConnection` in
  `src/core/call-context.ts`): what a call with no input of its own would choose,
  through `connection`, `host` and every input that selects a connection. So making
  an environment the dossier's default is refused when that environment selects a
  writes-enabled connection, just as a `connection` would be.

  Binding a dossier to a writes-enabled connection is done on the CLI, by a human.
  **Checked-in and listed-folder dossiers** follow the same rule when they're read: a
  section whose `connection` or `host` lands on a writes-enabled connection is
  reported by `dossiers check`, and a write through it fails until the user adopts the
  dossier with `toil dossiers import`. Then the binding is theirs.
- **Only an explicit binding counts.** A section with no `connection` or `host`, or no
  section at all, selected nothing: the call uses your own default connection, which
  was always yours to set, and a checked-in dossier doesn't change that. An explicit
  `connection` input on the call also goes through, since you chose it. So the error
  for a blocked write offers both fixes: pass `--connection`, or `dossiers import`.

**When write tools are registered:** an area's write tools are listed over MCP when
**any** of that area's connections has `writes: true`. Listing grants nothing: every
call still resolves its one connection, and the gate is checked against that
connection (`writes: true` on it, plus `allowWrite` on the call). A write that
resolves to a read-only connection fails with `WRITE_DISABLED`, naming the connection.
Turning writes on for a connection is a human decision about that connection
wherever it's used, including dossiers already bound to it.

## Security notes

- **A dossier can't introduce a host to talk to or a credential.** Importing one from a
  teammate, checking one into a repo, or an agent editing one can't redirect where
  secrets go. Hosts in a dossier are selectors among the reader's own connections, and
  remotes are only compared. toil contacts neither.
- **Repository dossiers are read only from the repository you're in and from folders you
  list.** toil never scans the disk for them.
- **File permissions:** dossier files in `~/.toil/` are written with user-only
  permissions, as is the config. Files in a repository take the repository's.
- **Paths** are stored as given and compared after normalising case and separators on
  Windows (*principle 8*).
- **People are names, not credentials.** A `people` identity shaped like a token is
  refused. An email in a dossier is personal data: an exported or checked-in dossier
  carries it, so leave `email` out of one you share beyond the team.

## Settled questions

1. **A dossier that names a connection the user doesn't have** is a hard error, the
   same one an unknown `--connection` gets, and `dossiers check` reports it. Falling
   back would be the silent guess a host selector is also forbidden.
