---
area: artifactory
description: Repositories, artifact metadata and properties, AQL search, builds, and dependency versions and licenses on JFrog Artifactory
---

# JFrog Artifactory (`artifactory`)

Repositories, artifact metadata and properties, AQL search, Build Integration, and
newer versions and licenses for a dependency inventory, on **JFrog Artifactory**,
through its classic REST API (`api/...`). `artifact set-properties` is the one command that
writes. Verification level: `unit`.

**Supported versions:** The oldest JFrog Artifactory version toil supports hasn't been established. toil
calls the classic REST API (`api/...`) and AQL with an access or identity token sent
as a Bearer header. No release has been verified yet.

## Credential

An Artifactory **access token** or **identity token**: in Artifactory, your profile →
Edit Profile → Generate an Identity Token. toil sends it as
`Authorization: Bearer <token>`. There is no username, password or browser login, and
no CI fallback variable.

## Configuration

| Key | Env var | Required | Meaning |
|-----|---------|----------|---------|
| `baseUrl` | `TOIL_ARTIFACTORY_BASE_URL` | yes | Artifactory root, keeping any context path, e.g. `https://artifactory.imagile.dev/artifactory` |
| `token` | `TOIL_ARTIFACTORY_TOKEN` | yes | Access or identity token |
| `npmRepo` | `TOIL_ARTIFACTORY_NPM_REPO` | no | npm repository key for `package outdated` and `package license-check` |
| `nugetRepo` | `TOIL_ARTIFACTORY_NUGET_REPO` | no | NuGet repository key for `package outdated` and `package license-check` |
| `mavenRepo` | `TOIL_ARTIFACTORY_MAVEN_REPO` | no | Maven repository key for `package outdated` |
| `writes` | `TOIL_ARTIFACTORY_WRITES` | no | `true` or `1` lets `artifact set-properties` run (with `--allow-write`) |

Environment variables (CI, or a one-off shell):

```bash
export TOIL_ARTIFACTORY_BASE_URL=https://artifactory.imagile.dev/artifactory
export TOIL_ARTIFACTORY_TOKEN=<your access token>
export TOIL_ARTIFACTORY_NPM_REPO=npm-remote
```

Or `~/.toil/config.json`:

```json
{
  "version": 2,
  "connections": {
    "corp-artifactory": { "area": "artifactory", "baseUrl": "https://artifactory.imagile.dev/artifactory", "npmRepo": "npm-remote", "nugetRepo": "nuget-remote", "mavenRepo": "maven-remote" }
  },
  "defaults": { "artifactory": { "connection": "corp-artifactory" } }
}
```

The token never goes in this file; a plaintext one there is refused with
`CONFIG_INVALID`. Run `toil connections add corp-artifactory --area artifactory` (or
`toil connections login corp-artifactory`) to keep it in the OS credential store, or
set `TOIL_ARTIFACTORY_TOKEN`.

## Commands

- `ping`: Check Artifactory connectivity and authentication. `data` is Artifactory's
  text answer, normally `OK`.
- `repo list`: List repositories (`--type local|virtual|remote|federated`,
  `--package-type npm|maven|nuget|docker|pypi|...`).
- `artifact get <repo> <path>`: Get metadata for an artifact or folder (checksums,
  size, timestamps).
- `artifact properties <repo> <path>`: Read custom properties on an artifact.
- `artifact set-properties <repo> <path> key=value...`: Set custom properties on an artifact. A
  write: needs `writes: true` on the connection and `--allow-write`. Without
  `--recursive` no `recursive` parameter is sent, so on a folder Artifactory's own
  default applies. Values are sent as typed: a comma makes several values, and a `;`
  starts another property. `data` is `{ repo, path, properties }` as asked for.
- `artifact search`: Search artifacts using AQL, newest first. Needs at least one of `--repo`,
  `--name` or `--path` (`*` and `?` wildcards); `--after` / `--before` filter on the
  creation date (ISO 8601); `--limit` defaults to 100 (0 also means 100);
  `--properties` asks for properties too. `data` is `{ results, range }`.
- `build list`: List builds registered in Artifactory Build Integration, each with a
  `name` derived from its `uri`, and a `hint` when there are none. `--timeout <s>`
  (default 60) is the request's timeout; the command itself allows up to 600 s.
- `build runs <name>`: List all run numbers for a build.
- `build get <name> <number>`: Get build info (artifacts, dependencies, VCS revision)
  for a specific run.
- `package outdated` (also `toil deps outdated`): Check for newer versions available in
  Artifactory, for the direct production dependencies of an inventory.
  `--ecosystem npm|nuget|maven|all` (default `all`); `--major`, `--minor` or `--patch`
  keep only bumps of at least that size. Ecosystems with no repository key set are
  listed in `uncheckedEcosystems`.
- `package license-check` (also `toil deps license-check`): Report licenses for the direct
  dependencies of an inventory (`--ecosystem`, `--include-dev`). Maven licenses are
  always `null`; a NuGet package with only a license URL reports `See licenseUrl`.

`package outdated` and `package license-check` read the inventory that `toil deps scan` writes, from
`--input-file <path>` or, when that's left out on the CLI, from stdin; over MCP, pass `inputFile`.
They first ping Artifactory and stop if it doesn't answer or rejects the token, then
make one request per package, one at a time, so they're allowed up to 600 s. A lookup
that fails for any reason (a wrong repository key included) counts as no answer: the
package is left out of `outdated`, or gets `license: null`.

```bash
toil artifactory artifact search --repo libs-release-local --name 'api-*.jar' --limit 10
toil artifactory artifact set-properties libs-release-local dev/imagile/api/1.4.0/api-1.4.0.jar qa.status=passed --allow-write
toil deps scan | toil artifactory package outdated --ecosystem npm --minor
toil artifactory package license-check --input-file inventory.json --include-dev
```
