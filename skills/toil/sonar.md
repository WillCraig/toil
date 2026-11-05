---
area: sonar
description: Quality gate status, issues, security hotspots, measures and projects on SonarQube Server
---

# SonarQube Server (`sonar`)

Quality gate status, issues, security hotspots, measures and projects on
**SonarQube Server**, through its Web API (`/api/...`). Every command reads; none
changes anything. Verification level: `unit`.

**Supported versions:** The oldest SonarQube Server version toil supports hasn't been established. toil
calls the unversioned Web API with a user token sent as a Bearer header. No release
has been verified yet.

## Credential

A SonarQube **user token**: in SonarQube, My Account → Security → Generate Tokens.
toil sends it as `Authorization: Bearer <token>`. There is no username, password or
browser login.

## Configuration

| Key | Env var | Required | Meaning |
|-----|---------|----------|---------|
| `baseUrl` | `TOIL_SONAR_BASE_URL` | yes | SonarQube server root, e.g. `https://sonar.imagile.dev` (keep any context path) |
| `token` | `TOIL_SONAR_TOKEN`, then `SONAR_TOKEN` | yes | User token |
| `project` | `TOIL_SONAR_PROJECT` | no | Default project key for `quality-gate get`, `issue list`, `measure list` and `hotspot list` |

**CI fallback:** when `TOIL_SONAR_TOKEN` isn't set, the default connection takes its
token from `SONAR_TOKEN`, the variable SonarSource's own scanner reads. It sits
directly below `TOIL_SONAR_TOKEN` and above the config file. There's no fallback for
the base URL.

Environment variables (CI, or a one-off shell):

```bash
export TOIL_SONAR_BASE_URL=https://sonar.imagile.dev
export TOIL_SONAR_TOKEN=<your user token>
```

Or `~/.toil/config.json`, with `project` usually set once under `defaults.sonar`:

```json
{
  "version": 2,
  "connections": {
    "corp-sonar": { "area": "sonar", "baseUrl": "https://sonar.imagile.dev" }
  },
  "defaults": { "sonar": { "connection": "corp-sonar", "project": "imagile-api" } }
}
```

The token never goes in this file; a plaintext one there is refused with
`CONFIG_INVALID`. Run `toil connections add corp-sonar --area sonar` (or
`toil connections login corp-sonar` for an existing connection) to keep it in the OS
credential store, or set `TOIL_SONAR_TOKEN`.

## Commands

The project comes from `--project <key>`, else the connection's `project` (usually
`defaults.sonar.project`). With neither, the command fails with "No project
specified".

- `quality-gate get`: Get quality gate status for a project (`--branch`).
- `issue list`: Search/list issues for a project. Filters `--severities`, `--types` and
  `--statuses` take comma lists; `--resolved` sends `true` only for the exact string
  `true`, anything else as `false`.
- `measure list`: Get key metrics for a project. `--metrics` defaults to coverage,
  duplicated lines density, bugs, vulnerabilities, code smells, the three ratings
  and ncloc.
- `project list`: Search/list projects (`--query`). SonarQube's `api/projects/search`
  needs the Administer System permission, so other tokens may get `AUTH`.
- `hotspot list`: List security hotspots for a project (`--status`, `--resolution`).
- `check-toil-project`: Check that every project key the call's toil project names (`project`,
  `projectKeys`, `projects`) exists, through `api/components/show`. Returns `{ toil project,
  connection, env, ok, checked, checks, unchecked }`, and the CLI exits 1 when one is missing.

`issue list`, `project list` and `hotspot list` page with `--page` (default 1) and `--page-size`
(default 100), passed to the server as given; `data` is then SonarQube's own page.
`--all` ignores both and fetches every page, 500 at a time, until the total is
reached or a page comes back empty; `data` is then one flat list of items. SonarQube refuses `issue list` past the
10,000th result, so `issue list --all` on a larger result fails; narrow the filters.
`--all` also stops with an error after 1,000 pages (500,000 items), and like every
command it's subject to toil's time limit (`TOIL_TIMEOUT_MS`, 120 s by default), so a
very large `project list` or `hotspot list --all` can end in `TIMEOUT`.

Over MCP the same commands are tools named after the path, with spaces and hyphens
as underscores (`sonar_issue_list`, `sonar_quality_gate_get`), taking camelCase
fields named after the flags (`project`, `pageSize`).

```bash
toil sonar quality-gate get --project imagile-api
toil sonar issue list --project imagile-api --severities BLOCKER,CRITICAL --all
toil sonar measure list --metrics coverage,bugs --branch main
```
