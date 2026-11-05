---
name: integrations
description: Rules for toil's enterprise-tool integrations (Jira, Confluence, Bitbucket, SonarQube and every other service area). Use when adding, changing or reviewing an integration or one of its commands, judging whether a requested service can be supported (its authentication), recording or raising a verification level, adding a vendor's Cloud deployment (one area, a `deployment` on the connection), reviewing an integration's site documentation page, or touching anything covered by the command contract (docs/command-contract.json, docs/command-contract.md, docs/divergences/, `toil config import`, command paths, flags, env var and config key names). Not needed for databases or the MCP server alone.
---

# Integrations

## Authentication Bar

An enterprise integration authenticates with a long-lived credential the user
generates once in the vendor's UI and gives to toil through `toil connections add` (the
OS credential store) or an env var, never a config file. toil gets from
it to an authenticated request with no interactive step: a header, or a plain-HTTP
exchange for a short-lived token that toil caches in memory and never writes to disk.

Out of scope regardless of usefulness: interactive OAuth, SSO/SAML/OIDC at use time,
username + password, app registrations for client credentials, cloud IAM chains, mTLS,
and anything that shells out to another CLI for a token. If that is a tool's only auth,
decline and name the blocking mechanism.

No hardcoded vendor base URLs; every host is user-supplied.

## Adding an Enterprise Integration

Confirm the Authentication Bar first. Then, in one change: `src/areas/<area>/` with
its `defineArea` (connection schema, secrets, CI fallbacks), its commands and its
`supported` export, a `test/fixtures/<area>.fixture.ts`, `config init`/`check`/`test`
entries (once the `config` commands exist), `skills/toil/<area>.md`, its board entry
`site/src/data/integrations/<area>.json`, and `docs/divergences/<area>.json` if it
diverges. Every one of those files is the area's own; no integration edits a shared list.
`test/skills.test.ts` fails when a registered area has no skill file, the file has no
frontmatter, or it misses a command, a connection key's env var or the supported
versions.

### Building an area, step by step

1. **Read the brief**, `docs/briefs/<area>.md`: auth, paging, special HTTP needs,
   context inputs, the suspected-bug issue and the supported version. Then read the
   reference material the area's issue points at, which the brief summarizes and
   which wins where they disagree.
2. **Stub it**: `node scripts/stub-area.mjs <area>` writes `src/areas/<area>/` with
   a `defineArea` with a `request` hook to fill in, one `area.command()` per
   contract command (exact path, arguments and flags, each `run` throwing until built), plus the fixture and skill file. It never
   overwrites, and it leaves out commands a divergence removes. Group-level flags
   become the area's context inputs in `area.ts`, with a TODO for where each value
   comes from (a connection setting, the git remote, or selecting the connection).
   An area with no contract entry (a variant that is still its own area, with no contract) is stubbed
   from command names given after it, `node scripts/stub-area.mjs <area> "item get"
   "item list"`, each with no flags yet, or with none named, one `example` command.
3. **Build each command**: request, paging, errors and `data` exactly as
   recorded, through `ctx.fetch` and core's helpers. Set `writes`
   from what the command does to the service; the stub only guessed from the verb.
   - **Paging** goes through `paginate`. A `p`/`ps`/`total` API (SonarQube) is
     the `page` style with a `total` callback: it stops once the items read reach
     the total or a page is empty, never on a short page. The result's `total` is
     the last one the server reported, an empty page's included, so a command
     asked for zero items (`jira issue search --limit 0`) still returns the count.
   - **The 1,000-page bound** (`MAX_PAGES`) isn't in the contract,
     which records none: list it in the area's `docs/divergences/<area>.json` (principle 4)
     for every area that pages, and pass `what` so the error names the list.
   - **A context value read from a file** (Jira's `project` in `--input-file`)
     goes through `ctx.supply('project', value, 'file')`. It ranks below the
     call's own flag and above the toil project, git and the connection, returns the
     value to use, and `meta.context` reports source `file`. Keep the input
     `optional` in the command's `context` when the file may supply it, since a
     required one is checked before `run`.
4. **Fixture**: canned responses for every request the examples send, as routes on
   method, `path` and `query`. Local state goes in `setup`/`teardown`; a non-HTTP
   area names what to `trace`.
5. **CI fallback**: where the service's own tooling reads a well-known variable
   (`SONAR_TOKEN`), declare it in `defineArea({ fallbacks })` and name it in the
   skill file; `test/skills.test.ts` fails if the file doesn't. Don't write a
   precedence test for it: `test/fallbacks.test.ts` checks every declared
   fallback against the real config loader (below `TOIL_<AREA>_<KEY>`, above the
   file, default connection only), and the not-configured errors name it beside
   the `TOIL_` variable on their own. A fallback that is canonical for only one
   deployment (Bitbucket Pipelines' are Cloud's) adds `defineArea({ fallbackWhen })`:
   a function of the default connection's effective settings
   (`(effective) => effective.deployment === 'cloud'`) that decides whether the
   area's fallbacks apply; test it with a connection of each deployment, as
   `src/core/config-v3-bitbucket.test.ts` does.
6. **Supported version**: export `supported` from `index.ts`, set the same value in
   the board entry, and state it in the skill file. An error that means the server
   is too old uses `serverTooOld()` from `src/core/supported.ts`, so its message says so and names
   the minimum.
7. **Contract**: `test/contract.test.ts` checks paths, flags and output field names.
   Anything a principle makes you change goes in `docs/divergences/<area>.json`. A
   contract command toil drops altogether (`git credentials`) is an entry with
   `"removed": true` listing its paths: the test then accepts their absence and fails
   if one is still registered, and the stub generator leaves them out. A group flag
   (`bitbucket --project`) satisfies a contract leaf flag of the same spelling, so
   moving a target flag to the group needs no divergence.
8. **Docs**: `npx vitest run -u` writes `site/src/data/commands/<area>.json` and
   `site/src/data/settings/<area>.json`; add the
   board entry, `site/src/data/integrations/<area>.json` (its `group` is its category on
   `/connect/`), at `status` `unit`; review
   the docs page, which is the area's skill file rendered (nothing to write in
   `site/`), and take its screenshots with
   `node scripts/shoot.mjs connect/<area>/` (the `site` skill).
9. **Suspected bugs** go in the area's issue, never fixed in the integration (below).
10. **Delete the brief**, `docs/briefs/<area>.md`, in the same PR. Briefs are the only
   docs that point at reference material outside this repository; shipped docs,
   code and skills never do, so a brief goes once its area is built.

`src/areas/jira/` is the reference integration. Follow its shape:

- `area.ts` (the `defineArea`, with its `request` hook: the base URL, auth headers,
  service name and auth fix for a connection), `client.ts` (every request, sent with
  `apiRequest` from `src/core/api.ts`, which builds it from the hook), and command
  files grouped by subject, each exporting a list that `index.ts` spreads.
- HTTP helpers live in core, so an area never writes its own: a token exchange with
  a cache (the hook's `token`, sent only to the connection's origin or a
  `vendorDomain` named in the area's code), redirects that never leave the
  connection's host (`redirect: 'follow-without-auth'` for a signed download URL,
  with every header dropped), `repointUrl` for a URL the server hands back,
  `as: 'text' | 'ndjson' | 'bytes'`, `apiResponse` for headers, `accept` for a
  non-OK status that's an answer, `multipart` and raw uploads, `apiGraphql`, `paginate`
  (`src/core/paginate.ts`), `poll` (`src/core/poll.ts`), a per-request `timeoutMs`
  and a command's `timeLimitMs` above the 120 s default.
- A command that needs no connection at all (`jira issue schema`) is `area.command({
  kind: 'area-local', ... })`; it works with no config.
- Files through `ctx.files`, never `node:fs`. Numbers, booleans, enums, JSON objects
  and repeatable flags come from the schema (`z.number()`, `z.boolean()`,
  `z.object()`, `z.array()`); don't parse argv by hand. Where the contract records a
  number read with `parseInt`, keep the field a `z.union([z.number(), z.string()])` so it
  stays text, and keep the `parseInt`.
- **Where a command acts** (`--project`, `--repo`, `--owner`, `--instance`, `--env`)
  is a context input in `defineArea({ context })`, never an ordinary flag, so core
  resolves it from the call, the toil project, the git remote and the connection in one
  order. A toil project section supplies it by the input's name, so a context input is
  also what makes a key usable from a toil project. The contract's group-level flags (`bitbucket --project --repo`, `github
  --owner --repo`, `ado --collection --organization --project --repo`, `jenkins
  --instance`, `openshift --env --instance`, `dynatrace --env`) are `group` inputs,
  with the contract's spelling in `flags`; a per-command one (`jira --project`) is a
  `command` input the command lists in its `context`, marked `required` where the
  contract records a failure without it, unless the command has its own fallback (a project in
  `--input-file`); then keep it optional and fill that step with `ctx.supply` (step 3).
  A flag that names a target but doesn't fall back to a setting stays an ordinary
  option (Jira's `issue fields`, `board list`, `sprint list`); a context input always
  falls back. Give it a `setting` when the connection can hold a
  default, `git` when the remote names it, and `selectsConnection` when the contract
  records it picking an instance or environment. Read it from `ctx.context`. When the
  contract records its own wording for a missing one ("No project specified. Use
  --project or set defaults.sonar.project in config."), keep it with the input's
  `missing: { message, fix? }`; the fix defaults to core's, which names the flag,
  the setting and its env var.
- **Another area's credential** (Kibana on Elasticsearch's key) is `defineArea({
  shares: { area, keys } })`. It declares which keys a connection may pair, nothing
  more: the user pairs one with `<key>From` (`"apiKeyFrom": "es-prod"`), and the
  area's default connection alone also takes the other area's default env value, as
  the env chain the contract records does, unless the area's `shares.fallbackWhen` refuses
  the other connection (a pair shares a credential only between like deployments:
  Confluence takes Jira's token only from a Jira of the same deployment). An explicit
  `<key>From` is the user's call and isn't asked. Document the `<key>From` setting in the area's skill file.
  `ctx.resolved.shared` says whether the key came from the other area, for an auth
  error that names which key was sent.
- **`--env` means which environment**, and it's the same input the toil project supplies.
  Name it `env`, give it `selectsConnection` (or an enum schema), and never add a
  second environment flag.
- **A path the contract records in another group** (`deps outdated`, served by
  `artifactory package outdated`) is an `aliases` entry on the command that serves it; the
  contract test checks the contract's row against it.
- **A path in the area that a core command answers** (`jenkins instance list`, which
  lists the area's connections) is `defineArea({ coreAliases: { 'instance list':
  'connections list' } })`. Core registers it as an alias of `connections list
  --area jenkins`, with no `--area` flag of its own, so the area's code never sees the
  config. The target must be a core command that takes an `area` input. MCP has the
  core tool, with its `area` field. The area's group flags (`openshift --env`)
  are refused on it by name, in the path the user typed.
- **An error code the area needs** (`JENKINS_BUILD_FAILED`) goes into core's
  `ErrorCode` list in `src/core/errors.ts`, with a one-line comment, the way
  `DATABASE` and `GIT_NOT_FOUND` did. Codes are an open set to callers, not to the
  type: the list keeps a misspelt code a type error, so there's no cast and no
  escape hatch. Prefer an existing code when one fits.
- **A success the contract records with a non-zero exit** (`jenkins pipeline run --wait` on a
  failed build) calls `ctx.setExitCode(1)` and returns its data. The envelope stays
  `ok: true` with the same `data`; the CLI exits 1; MCP returns the same envelope and
  doesn't mark it as an error. Never turn such a success into an error envelope.
- **A command an agent must never call** (a delete) sets `mcp: false`. It keeps its
  connection, context, write gate and time limit on the CLI, is never an MCP tool,
  and its docs page marks it CLI only. The parity suite runs its examples and write
  gate on the CLI.
- **Raw API passthrough** (`<area> api`): an HTTP area adds
  `apiCommand(area, { service, examplePath, examples })` from
  `src/core/passthrough.ts` to its `commands`. Give it a read example, one with a
  `query`, and a write with `bodyFile`, `contentType` and `allowWrite: true`; the
  fixture answers each, and the parity suite proves the write gate. Copy the **Any
  endpoint** section of `skills/toil/jira.md` into the area's skill file, with its
  own paths. Don't add one to an area that isn't HTTP (`db`, `git`).
- **A command the contract records answering with the service unconfigured** (`git current-pr`
  answering that Bitbucket isn't set up) sets `connectionOptional: true`. When the
  area has no connection and the call names none, `run` gets `ctx.connection`
  undefined and no context inputs, and answers itself; any other connection problem
  still fails as usual. Only for a read with no required context input. One whose
  own input can stand in for the connection (`db lint --engine postgres`) adds
  `connectionlessWhen(input)`: when it's true, core resolves no connection, reads
  no secret and consults no toil project.
- **The working repository** (root, current branch, remote URLs) is `ctx.repo()`,
  read from `.git` in pure JS; it spawns nothing and needs no git. Use `ctx.git` only
  for a command that is git.
- **A git remote parser** gets the call's resolved connection as its second
  argument, so it accepts only a remote on the connection's own host
  (`connection.baseUrl`). An input that `selectsConnection` is read before there is a
  connection, and gets `undefined`.
- **Reading stdin** (`ctx.files.readText('-')`, or an inventory read with no
  `--from`) needs nothing more: on an interactive terminal core refuses at once with
  `INVALID_INPUT` ("Nothing was piped in"), and over MCP `-` refuses too. Never wait
  on a terminal.
- **A required key whose value is the same for everyone** (Figma's `baseUrl`,
  `https://api.figma.com`) gets `defineArea({ examples: { baseUrl: '…' } })`. The
  not-configured and missing-key fixes then say `Set TOIL_FIGMA_BASE_URL (e.g.
  https://api.figma.com)`. It's text for a person, never a default: toil still has
  no hardcoded host.
- **A plain-text error body** (LogScale's query errors) needs nothing: `apiRequest`
  puts its trimmed text after the status (`HTTP 400: <text>`), capped and with URLs
  redacted. A JSON body is still parsed for its message.
- **A negated flag** (`--no-with-replies`) maps to its field (`withReplies`) with a
  `.default(true)` schema, since commander sets it true unless the flag is given;
  the parity suite sends `--no-<flag>` for `false`.
- **Engines or variants** whose connections need different keys use `variants`, not a
  hand-built `superRefine`. A password (a database) goes in `secrets` as `{ password:
  'password' }`; a token is the default.
- Fix text names env vars with `area.envName(key)`, never a hard-coded
  `TOIL_<AREA>_…`.
- A read sent as POST (a search) sets `queryByPost: true` and stays `writes: false`.
  A token exchange is not such a POST: the parity suite leaves core's exchange out
  of the read-only check on its own, so don't mark a read `queryByPost` for it.
- An area that drops its cached token itself builds the key with
  `tokenKey(tokenScope(area, ctx.connection), exchange)` from `src/core/token.ts`,
  never by copying the format.
- **An API on another host than the one people know** (GitHub's api.github.com for
  github.com) is `defineArea({ siteApis: { 'github.com': 'https://api.github.com' } })`.
  A toil project's `host: github.com` then selects a connection on the API host, sharing a
  toil project records `github.com`, and `toil projects onboard` offers that base URL. Only a
  selector and a suggestion: toil never contacts it on its own.
- **Not-configured wording of the area's own** ("OSS Index needs an account…") is
  `defineArea({ notConfigured: { message, fix? } })`; the fix defaults to core's.
- **A key the area no longer accepts** (checkmarx's `clientId`) is `defineArea({
  removed: { clientId: '<what to do instead>' } })`: a `CONFIG_REMOVED_KEY` warning
  in the area's words, and the value is dropped.
- **A contract path whose flag value picks the command** (`deps frisk --source <x>`) is
  a row in `ROUTED_ALIASES` in `src/registry.ts`, never an area's own alias. A
  route whose command isn't on `main` yet is skipped; the contract test checks
  the row once every route is registered.
- **An inventory from `deps scan`** (`--from <file>` or stdin) is read with
  `readInventory` from `src/core/inventory.ts`, never parsed in the area.
- **A wait that grows by a fixed step** (`2 s × attempt`) is `poll` with
  `backoff: 'linear'`.
- **A 429 the contract records as returned at once** is `apiRequest(..., {
  retryRateLimit: false })`, with `accept: [429]` if it's an answer.
- **A request path never takes a `.` or `..` segment**: core refuses one with
  `INVALID_INPUT` before sending (`requests.path` in `docs/bounds.md`), so an
  area needn't check ids for it.
- **A `connectionOptional` command** also runs with `ctx.connection` undefined
  when the default connection exists but only lacks a key (a missing `pat`), with
  a `CONFIG_INCOMPLETE` warning; a key set to something wrong still fails.
- **A fixture whose examples read the repository** (`pr current`) sets `repo`
  (root, branch, remotes) in `defineFixture`, and `ctx.repo()` returns it on both
  front doors.
- **Two selecting inputs** (`--env prod --instance east`) pick the one connection
  matching both when each alone matches several.
- `jenkins instance remove`-style paths are `coreAliases` onto `connections
  remove`, which takes `--area`.
- Every connection key keeps the name the contract records, so its env var does too
  (`apiToken` is `TOIL_JIRA_API_TOKEN`).
- Unit tests assert exact requests through `execute()` and `testContext()`; the
  fixture's canned responses say which shapes came from recorded responses and
  which were invented from the vendor's docs.
- After registering, run `npx vitest run -u` once to write the site's command list.

An area's toil project section (`docs/projects.md`) needs nothing from the area: its keys
are the area's context inputs, plus `connection` or `host` to select a connection
(never anything else) and `fields`. Any other key is kept as reference data. A
read-only `toil <area> check-toil-project` checks the section against the service. Build
one with `src/core/check-toil-project.ts`: `toilProjectToCheck(ctx, area)`, `viewValues` for the
keys to look up, `checkEach` with a lookup that returns false only on `NOT_FOUND`, and
`toilProjectCheckResult`. Give the area's fixture a `toilProject` holding only reference
keys, so the other examples don't pick it up (`jira`, `sonar` and `confluence` are the
examples). A command that takes custom fields by name merges `ctx.toilProjectFields()`
into its name map, and asks for them only when the call names a field (Jira's
`withAliases`).

**Every change to an integration reviews its site documentation in the same PR.**
That covers a new integration, a new or changed command, a changed credential or
config key, and a raised verification level. Each integration has its own page,
`/connect/<area>/`, and its tile on the site's Connect page links to it:
- **A new integration** adds its page and its board tile with the deep link.
- **A changed integration** reads its page against the change and updates whatever
  is now wrong: setup, credentials, config keys, commands, the verification level.
- **"How it works"** stays high-level. Update it only when a change alters the big
  picture, such as configuration precedence or how credentials are stored.

The PR says which pages it reviewed. A change with no documentation impact says so
explicitly rather than skipping the check.

### Verification Levels

*Principle 4.* Every integration and database provider records how far it has been
verified: its board entry's `status`, its provider's `verification`, and its skill
file. There are three levels, `unit`, `live` and `stable`. What each one means is
written once, in `site/src/data/levels.json`, which the site renders on the board and
every integration page and `test/site-commands.test.ts` checks the values against;
change the wording there, never in a copy.

| Level | How it is raised |
|-------|------------------|
| `unit` | The minimum to merge: logic tested with stubbed `fetch` (or a stubbed git, for a local area), skill doc written |
| `live` | A PR saying what was run, against what kind of real instance, and that the common commands worked there |
| `stable` | A PR saying how long it has been in routine use against real instances, with no command or output change pending |

Never raise a level on the strength of the unit suite. A database provider whose
tests run against the real engine in CI's service containers (`npm run
test:integration`) is `live`.

A command talks to one service. Do not build an aggregate command that fans out to
several sources; give each source its own area and let them compose through stdin or
`--from <file>` (see the dependency-analysis section of `docs/integrations.md`). A
group that holds only aliases onto other areas' commands (`deps outdated`) is a
compatibility path, never a place for a command that calls more than one of them.

### Open Work Items

*Principles 3 and 4.* A work-item integration is any area that reads or writes
issues, work items or tickets: today `jira` and `ado` (each Data Center or Server and Cloud or Services) and `github`, then
any tracker after it. Adding or changing one means inspecting
the Open Work Item mapping (`docs/owi/spec.md`) **in the same PR**:

- Check the mapper still covers the area's output: a new or changed field, status,
  link type, history entry or list shape the area now returns.
- Update what the change makes stale: the area's entry in `OWI_SOURCES`
  (`src/core/owi/types.ts`, the one place work-item areas are marked; an area
  sending an existing shape is one line there), its mapper in `src/core/owi/`, the
  spec and `docs/owi/schema.json` (additive only, as the spec says), and the sprint
  fixture in `test/fixtures/owi/` when the change shows up in it.
- Run `toil util owi map` on the new or changed fixtures and say in the PR what it
  returned: `verified.passed`, and anything in `unmapped` or `skipped`.

`test/owi.test.ts` enforces the mark: an area with issue- or work-item-shaped
commands (`issue get`, `issue search`, `issue history`, `work-item get`)
that isn't in `OWI_SOURCES` fails CI, and so does a marked area without a fixture or
whose mapped examples don't validate against the schema. An area that is on its way
sits in that test's `PENDING` list, by its issue, and switches on once it registers.

### Deployment Variants

*Principle 10.* **A product that ships Data Center/Server and Cloud is one area, one
command tree and one set of MCP tools** (`jira`, `confluence` and `bitbucket`, with
`ado` following, #495). Someone who has learned `toil jira` has learned both. The
deployments still differ in their APIs, so the code stays apart and the surface is shared:

- **The connection says which.** A connection has `"deployment"`: `"server"` (the
  default, Data Center/Server) or `"cloud"`, declared once with `defineArea({ variants:
  { by: 'deployment', ... } })`, which also names the keys only one needs (Cloud's
  `email`). Env vars follow the area (`TOIL_JIRA_DEPLOYMENT=cloud`, or
  `TOIL_CONN_<NAME>_DEPLOYMENT=cloud`). One area's `request` hook branches on it for the
  credential, as does its `probe`.
- **Separate API code per deployment.** Each deployment is a folder under the area
  (`src/areas/jira/server/`, `src/areas/jira/cloud/`; `confluence` is built the same way) of ordinary `area.command()`s that
  are never registered themselves. They share only generic helpers. The area's `index.ts`
  folds them with `area.byDeployment({ server: [...], cloud: [...] })`
  (`src/core/deployments.ts`): one command per path, whose `run` calls the implementation
  for the resolved connection's deployment. A conflict between two deployments' versions
  of a command fails when the registry is built, and the area's `overrides.ts` says how
  each is worded once.
- **The surface is the union, and a gap is refused.** The shared tree holds every command and
  flag that either deployment has. A call the connection's deployment can't serve fails
  with `UNSUPPORTED` before any request, naming the deployment and the connections that can.
  Flags for one idea share one name, and their help says what each deployment takes
  (`--assignee`: a username on Data Center, an accountId on Cloud). The paths and flags
  the contract records for Data Center are unchanged. Where the two page differently,
  keep both flags and refuse each on the other deployment: `confluence page list` takes
  `--offset` on Data Center (a position) and `--cursor` on Cloud (an opaque token), which
  are not one idea.
- **An input only one deployment takes** (Bitbucket's `--project` is Data Center's,
  `--ws` is Cloud's) is declared once in the area's `context` with `deployments: [...]`.
  The other deployments refuse it with `UNSUPPORTED` and don't need it, and a deployment's
  own `missing` wording can differ (`missing` may be a function of the connection). A command
  that lists the input itself takes it on any deployment (Cloud's `repo create --project`), but there core resolves it from the call or the toil project alone, never from the connection's setting, defaults, env, git or the area default, which are the other deployment's (a write's target comes only from what belongs to its deployment).
- **Each returns its own API's shape.** Don't reshape `data` to make the two look alike;
  `meta.context.connection.deployment` says which ran, and OWI is the normalised view.
- **The fixture runs both.** The area's fixture names a connection per deployment
  (`deployments: { server: 'jira', cloud: 'jira-cloud' }`), and the parity suite runs
  every example against a connection of its own deployment, plus the refusals.
- **Docs, skill and site are one page per product**, with a section on what differs. A
  verification level is recorded for the product; say in the PR when the deployments are at
  different levels.
- **Retiring an old area name** (`jira-cloud`, `confluence-cloud`, `bitbucket-cloud`, `ado-cloud`) goes in `src/core/renamed-areas.ts`, which makes
  every old form (env vars, `--areas`, a typed path, a toil project section, a config file) fail or
  warn with the new one. The config fold in `migrateConfig()` runs for every version and is
  idempotent, so a file written before the area was folded folds too, whatever its version.
- When the variants differ only in host (GitHub.com and GitHub Enterprise Server),
  they stay one area with a configurable `baseUrl` and no `deployment`.

Every pair is folded: no `-cloud` area remains, and a vendor's next
deployment pair is built the same way, as one area with a `deployment` field.

## Command Shape

*Principle 10.* Every integration command is `toil <area> <resource> <action>
[ids...] [--flags]`, and the MCP tool name follows the path (`jira_issue_get`).

- **The resource is the thing you'd hold an id for**: `issue`, `work-item`, `pr`,
  `pipeline`, `run`, `repo`, `project`, `board`, `sprint`, `user`, `collection`.
  Everything you can do to one lives under it, so `toil <area> <resource> --help`
  and the menu's Services module list it all in one place.
- **The action is a verb** (`get`, `list`, `search`, `create`, `update`, `history`,
  `assign`, `transition`, `link`, `comment`, `merge`, `approve`, `download`), **or,
  for a read of a sub-collection, its plural noun** (`comments`, `transitions`,
  `attachments`, `files`, `reviewers`, `builds`, `threads`, `fields`, `types`).
- **A service-level command stays two words**: one that acts on the connection or the
  service as a whole rather than on one resource (`whoami`, `connection-data`, `api`,
  `check-toil-project`, `status`, `ping`, `db query`, `alation search`), and an inventory
  command that is an area's one job (`osv vulns`, `ossindex vulns`, `sonatypeiq
  evaluate`). `sonatypeiq evaluate` keeps `--application-id` as a flag, a named
  exception: `deps frisk`'s routed alias can pass flags only.
- **Positional arguments are the path to the thing and nothing else**: the
  resource's id first, then a sub-item's id (an attachment, a thread, a comment).
  Values, including the other end of a link, a state, a sprint or a person, are
  flags.
- **One idea, one flag, everywhere**: `--limit` / `--cursor` to page (never
  `--max-results` or `--top` for the same thing), `--assignee`, `--target`, `--type`,
  `--body`, `--file` to upload, `--dir` to download into, `--input-file` for a JSON
  document, `--field Name=value`, `--updated-since`. A new input field is named after
  its flag, and a positional id's field after the argument (`key` for a Jira issue,
  `id` for most others, `name` or `commit` where that's what identifies it). Where an
  idea needs two flags (`--top` beside `--limit`), `AGENT_DECISIONS.md` says why.
  Page-number paging is `--page` and `--page-size`, and an offset is `--offset`.
  **Named exceptions**, the vendor's own terms where the idea isn't quite ours:
  GitHub's `--head` / `--base` on `pr create` (Git's refs, where ADO and Bitbucket
  say `--source` / `--target`), ADO's `--creator`, and `--all`, which means
  "every page" in sonar and sde and "include the rest" elsewhere.
- **An id that starts with `-`** goes after `--` on the CLI, and the error for one
  given without it says so (`dashLedFix` in `src/program.ts`).
- **Reshaping an area changes the command layer only**: paths, arguments, flags,
  field names and the text that names them. Client code, requests, results, errors
  and `data` stay as the contract records them. The old paths and flags are dropped,
  never aliased, and the contract's entries for the area are rewritten to the new
  surface in the same change (CLAUDE.md, **The command contract**). From the first
  beta on, a reshape is also a breaking change under principle 7: a `feat!:` with a
  migration footer, keeping the old path with a deprecation warning for at least one
  beta where practical.
- **Every integration area follows it** (#290, #297), and a new area follows it from
  the start. A later reshape carries the old-to-new table of every path and flag in
  its PR (CLAUDE.md, **The command contract**). `git` (local git's own verbs) and `util`
  (local utilities) keep their shapes.

## Compatibility

This is a requirement, not a principle. People build skills, scripts and pipelines on
toil's commands, so every integration implements the command surface the contract
records (`docs/command-contract.json`, described in `docs/command-contract.md`), and
anything it does differently is a listed divergence.

- **The recorded behavior is the specification.** For each command that's the
  contract plus the area's brief, issue, docs and tests; each integration's issue
  points at the reference material for its area. toil's unit suite has never met a
  real server, so it can't overrule them.
  - **Implement, don't reinvent.** Keep the recorded requests, payloads, response
    shaping and edge-case handling.
  - **Write it in toil's style and flow:** one `area.command` per command,
    `ctx.fetch`, `ToilError` with a fix, examples for the parity suite, and HTTP
    mocked with `fakeFetch`. Comments use the deadpan voice in CLAUDE.md's Code
    Comments section.
  - **Keep the recorded bugs too, until a live instance proves them** (*principles 4
    and 7*; **The command contract** in CLAUDE.md). The recorded behavior, meaning
    requests, success or failure, the error and `data`, is the specification while
    toil has no live instance, because the unit suite can't tell a bug from a server
    quirk the recorded behavior accounts for. Validation, defaults, paging, id-or-name
    detection and encoding stay exactly as recorded.
  - **Record each suspected bug** in the area's one `suspected-bug` issue (template:
    title `Suspected bugs to verify: <name> (`<area>`)`, label `suspected-bug`),
    appending to it if it exists: where, what, why, confidence, the observable change
    if fixed, and a live check. The test that covers it pins the recorded behavior and
    says so.
  - **The only changes allowed** are a change another principle or the Output
    Contract requires, such as a credential reaching a host the user didn't configure
    (flagged `**Security:**` in the issue) or a path an agent passes reaching toil's
    own credentials, made at once and listed as a divergence in
    `docs/divergences/<area>.json` naming the principle; and additive output the contract
    allows, such as `meta.warnings`.
  - **The first live run checks every item.** A confirmed bug is fixed as a declared
    change; a refuted one is closed.
  - A verification level recorded anywhere outside toil is context, not a level here.
    A new integration still starts at `unit`.
  - A Cloud deployment isn't in the contract: the contract records the self-hosted
    behavior at each path, and what only Cloud has (a command, a flag) is additive. The Cloud
    side is built against the vendor's documented API, and the PR says what it was run against.
- **The command surface is recorded** in `docs/command-contract.json`: every command
  path, its arguments and its flags, and the field names of each command's `data`,
  kept by hand. Briefs and issues may point at reference material outside this
  repository, because building an integration needs it; shipped docs, code and skills
  never do.
- **Every integration command in the contract exists in toil at the same path**,
  with the same positional arguments, the same long and short flags, and the same
  accepted values. For an area reshaped to the command shape, the contract records
  toil's new surface (**Command Shape**, above), so the same check holds it there. Output uses the same envelope with the same `data` field names.
  The global flags (`--pretty`, `--verbose`, `--debug`, `--config`,
  `--output-file`) are recorded too.
- **Env vars and config keys keep the names the contract records**:
  `TOIL_JIRA_BASE_URL`, and `jira.baseUrl`.
- **toil may add** commands, flags and output fields freely. It may drop or change a
  contract command only where a principle requires it. Each such divergence is listed
  in `docs/divergences/<area>.json` with what to use instead (the format is in
  `docs/command-contract.md`). One example: `deps frisk`
  splits into per-source commands under *principle 3*.
- **A test enforces this.** `test/contract.test.ts` diffs every registered area's
  command paths, aliases, positional arguments and flag spellings against the
  contract, runs every example in the area's fixture and checks the `data` has the
  recorded command's required field names, and fails on any divergence no file in
  `docs/divergences/` allows. Optional fields and output the contract types as
  `any` can't be checked that way: compare those by hand with the area's brief and
  issue, and keep the recorded names even where they're awkward (jira's
  `fields --discover` keeps the contract's `toilType` beside `suggestedType`).
- **Config is built, not copied.** `toil config import` reads a global config file
  in the shape the contract records, once, writes toil's config, and moves every
  secret into the OS credential store (see the `secrets` skill). It never modifies or
  deletes the file it reads, and it leaves repository config files of that shape
  alone.
