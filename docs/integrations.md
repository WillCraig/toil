# Integrations

The enterprise services toil covers. Each one is its own command area
(`toil <area> <verb>`) and must clear the Authentication Bar in the `integrations` skill
(`.claude/skills/integrations/SKILL.md`). Every one starts at verification level
`unit` (see the same skill).

## Where each integration is recorded

Each integration has one file, `site/src/data/integrations/<area>.json`: its service,
what it covers, its credential and where to make it, its status (its verification
level), and the oldest server version it supports. The site's
[Connect page](https://imagile-dev.github.io/toil/connect/) is built from
those files, beside the database engines (`site/src/data/databases.json`, which
`test/site-commands.test.ts` writes from the providers, and each engine's sign-in in
`site/src/data/db-sign-in.json`), and each integration's page, `/connect/<area>/`, is its
`skills/toil/<area>.md`, rendered, with that file's facts beside it, so there is no
table here to keep in step. One file per area means an integration changes only its own row.

| Key | Meaning |
|-----|---------|
| `area`, `name` | The command area and the service's own name |
| `group`, `order` | Which category on Connect it sits in (`trackers`, `source`, `cicd`, `testing`, `security`, `observability`, `docs`), and where |
| `covers` | What the area reads and writes, in a line |
| `credential`, `credentialWhere`, `credentialNote` | The credential, the menu path to create it (only when certain), and a note such as a CI fallback (`GITHUB_TOKEN`, `SONAR_TOKEN`) or a shared key (Kibana uses the Elasticsearch key) |
| `status` | Its verification level: `unit`, `live` or `stable`, with the meanings in `site/src/data/levels.json`. A file is added with the area's code, at `unit` |
| `host`, `keys` | SaaS only: the vendor's API host for examples; the credential env keys when there's more than one token |
| `local` | `true` for an area with no server (git): its page describes no credential, configuration or connection |
| `supported` | `{ product, minimum, api, note }`: the oldest version it supports, `minimum: null` when not established. Once the area ships, its `src/areas/<area>/index.ts` exports the same value as `supported`, its skill file states it, and `test/skills.test.ts` keeps the three equal. |

## Dependency analysis: one source per command

No command fans out to several vulnerability sources on the caller's behalf. Each
source has its own command, and they compose through one local inventory. The `deps`
commands keep the shape listed in [command-contract.md](command-contract.md).

| Command | Source | Covers | Network |
|---------|--------|--------|---------|
| `toil util deps scan` (also `toil deps scan`) | Local manifests | Package inventory for npm, Maven and NuGet | None |
| `toil util deps diff` (also `toil deps diff`) | Local manifests | Packages added, removed or changed between two refs | None |
| `toil osv vulns` | OSV.dev | Known vulnerabilities for an inventory | Public API, no credential |
| `toil ossindex vulns` | Sonatype OSS Index | Known vulnerabilities for an inventory | Public API, account username and token |
| `toil sonatypeiq evaluate` | Sonatype IQ Server | Policy evaluation of an inventory against an application | User token pair |
| `toil deps frisk --source <one>` | Whichever source you name: `osv` (the default), `sonatype` or `sonatypeiq` | Alias for the matching command above; `--source all` is dropped | As above |
| `toil deps outdated` | JFrog Artifactory | Newer versions available in your mirrors | Access token |
| `toil deps license-check` | JFrog Artifactory | License metadata for an inventory | Access token |

Each source command reads an inventory from `--input-file <path>` or stdin, so
`toil deps scan | toil osv vulns` works. None of them scans a repository itself:
`toil deps scan` makes the inventory, and the source commands only read one. They
share core's reader (`src/core/inventory.ts`), so each accepts the same shapes: the
scan's whole envelope, its `data`, or a bare list of packages. Reachability checks
belong to each source's `config test`, not to a separate connectivity command.

## Local utilities

The `util` group holds commands with no connection, no credential and no network (`skills/toil/util.md`). They aren't integrations, so they're not on the board; the site documents them at `/docs/utilities/`. The inventory commands above are in it too.

| Command | Covers |
|---------|--------|
| `toil util jwt decode` (also `toil jwt decode`) | Decode a JWT's header and claims without verifying |
| `toil util secrets scan` | Find credential-shaped strings in a file, a folder, stdin or the staged diff before they're committed or posted |
| `toil util report` | Summarise a JUnit, TRX, SARIF, lcov or Cobertura report, checked against its own totals |
| `toil util cert` | Decode certificates (PEM or DER) and check a chain's order, signatures, validity and host |
| `toil util log` | Triage a large log into grouped errors and warnings, with line numbers and stack traces |
| `toil util openapi list`, `show`, `example` | List an OpenAPI or Swagger document's operations, lay one out for `<area> api`, and build a minimal valid body, each checked against the official schema |
| `toil util c4 render`, `mermaid`, `d2` | Draw one view of a C4 model (JSON) as SVG laid out by toil, checked for overlaps and arrows behind boxes, or write it as Mermaid or D2 text |
| `toil doctor` | Config, credential and reachability report across every configured area |
| `toil config` | `init`, `set`, `check`, `test`, keychain references |
| `toil skills` | Install the user-facing skill for an agent |

## Order

Areas are built in vertical slices: databases first, then
dependency analysis (it exercises the composition pattern), then work tracking, then
the rest roughly in order of daily use.
