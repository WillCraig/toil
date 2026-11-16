---
area: sonatypeiq
description: Applications, organizations, policies and policy evaluations on Sonatype IQ Server
---

# Sonatype IQ Server (`sonatypeiq`)

Applications, organizations and policies on **Sonatype IQ Server**, read through its
REST API (`/api/v2/...`), and a policy evaluation of a dependency inventory against
one application. Nothing here changes anything in IQ Server. Verification level:
`unit`.

**Supported versions:** The oldest Sonatype IQ Server version toil supports hasn't been established. toil
calls only `/api/v2` endpoints, with a user token pair sent as HTTP Basic. No release
has been verified yet.

## Credential

An IQ Server **user token**: in IQ Server, open your profile and choose User Token,
then create one. It has two halves, a user code and a passcode. toil sends them as
`Authorization: Basic base64(userCode:passcode)`. It is not your login password, and
there is no browser login.

## Configuration

| Key | Env var | Required | Meaning |
|-----|---------|----------|---------|
| `baseUrl` | `TOIL_SONATYPEIQ_BASE_URL` | yes | Sonatype IQ Server root, e.g. `https://iq.imagile.dev` (keep any context path) |
| `userCode` | `TOIL_SONATYPEIQ_USER_CODE` | yes | User token code |
| `passcode` | `TOIL_SONATYPEIQ_PASSCODE` | yes | User token passcode (a secret) |

There's no CI fallback variable.

Environment variables (CI, or a one-off shell):

```bash
export TOIL_SONATYPEIQ_BASE_URL=https://iq.imagile.dev
export TOIL_SONATYPEIQ_USER_CODE=<your user code>
export TOIL_SONATYPEIQ_PASSCODE=<your passcode>
```

Or `~/.toil/config.json`:

```json
{
  "version": 2,
  "connections": {
    "corp-iq": { "area": "sonatypeiq", "baseUrl": "https://iq.imagile.dev", "userCode": "abc12345" }
  },
  "defaults": { "sonatypeiq": { "connection": "corp-iq" } }
}
```

The passcode never goes in this file; a plaintext one there is refused with
`CONFIG_INVALID`. Run `toil connections add corp-iq --area sonatypeiq` (or
`toil connections login corp-iq` for an existing connection) to keep it in the OS
credential store, or set `TOIL_SONATYPEIQ_PASSCODE`.

## Commands

The four read commands return IQ Server's answer unchanged as `data`.

- `application list`: List all applications in Sonatype IQ Server
  (`--organization-id <id>`, sent as an `organizationId` query parameter, which IQ
  may ignore).
- `application get <public-id>`: Get an application by its public ID. `data`
  is the filtered list, `{ applications: [...] }`; an unknown ID gives an empty
  list, not an error.
- `organization list`: List all organizations in Sonatype IQ Server.
- `policy list`: List all policies (`--organization-id <id>` asks
  `/api/v2/policies/organization/<id>`).
- `evaluate --application-id <id>` (also `toil deps frisk --source
  sonatypeiq`): Evaluate a dependency inventory against an application's policies.
  `--application-id` is the application's public ID. `data` is `{ tier, source, sourcesQueried,
  sourceErrors, scanned, vulnerable, packages }`, each package with its
  `vulnerabilities`.

`evaluate` reads the inventory that `toil deps scan` writes, from `--input-file <path>` or,
when that's left out on the CLI, from piped stdin (with nothing piped in on a terminal it
refuses at once rather than wait); over MCP, pass `inputFile`. Use `deps scan
--include-transitive` to evaluate transitive dependencies too. `--ecosystem
npm|nuget|maven|all` (default `all`), `--direct-only` and `--include-dev` filter the
inventory first. `toil deps frisk --source sonatypeiq` takes the same flags and runs
this command.

It looks up the application's internal ID by public ID (if the lookup fails or finds
nothing, the public ID is used as it is), then posts the packages as package URLs,
128 at a time. If IQ answers that the evaluation is queued, toil polls the
`resultsUrl` up to 10 times, waiting 2 s longer each time, and fails if it's still
queued. A `resultsUrl` on another host is fetched from the connection's host
instead, with a `SONATYPEIQ_RESULTS_HOST` warning. Only `SECURITY` policy violations
count, with threat level 9 or more as `CRITICAL`, 7 `HIGH`, 4 `MEDIUM` and above 0
`LOW`. The command is allowed up to 600 s.

`meta.warnings` says `SONATYPEIQ_NO_COMPONENTS` when IQ's answer had no
`components` list to read findings from, and `SONATYPEIQ_UNMATCHED_RESULT` for a
result that matches no package sent. Either means the result may undercount.

Over MCP the same commands are tools named after the path, with spaces as
underscores (`sonatypeiq_application_list`, `sonatypeiq_evaluate`),
taking camelCase fields (`publicId`, `applicationId`, `organizationId`, `from`).

```bash
toil sonatypeiq application list
toil sonatypeiq application get imagile-api
toil deps scan --include-transitive | toil sonatypeiq evaluate --application-id imagile-api
toil sonatypeiq evaluate --application-id imagile-api --input-file inventory.json --ecosystem npm
```
