---
area: dynatrace
description: Monitored entities, services, Kubernetes workloads, problems and distributed traces from Dynatrace
---

# Dynatrace (`dynatrace`)

Monitored entities, services, Kubernetes workloads and problems from the Dynatrace
**Environment API v2**, and distributed-trace spans from **Grail**. Every command
reads; none changes anything. Verification level: `unit`.

**Supported versions:** The oldest Dynatrace version toil supports hasn't been established. The
classic commands call Environment API v2 (`/api/v2`) on SaaS and Managed; `trace get`
needs the platform Grail query API (`/platform/storage/query/v1`), so a deployment
without the platform can't run it. No release has been verified yet.

## Credential

Two hosts, two tokens, and each token goes only to its own host:

- **Access token**, for every command except `trace get`. In Dynatrace: Access tokens →
  Generate new token, with the `entities.read` and `problems.read` scopes. toil sends
  it to `baseUrl` as `Authorization: Api-Token <token>`.
- **Platform token**, for `trace get` only, with the `storage:spans:read` and
  `storage:buckets:read` scopes. toil sends it to `platformUrl` as
  `Authorization: Bearer <token>`.

There is no username, password or browser login, and no CI fallback variable.

## Configuration

| Key | Env var | Required | Meaning |
|-----|---------|----------|---------|
| `baseUrl` | `TOIL_DYNATRACE_BASE_URL` | for all but `trace get` | Classic environment URL, like `https://<environment-id>.live.dynatrace.com`. On Managed, keep the `/e/<environment-id>` path |
| `apiToken` | `TOIL_DYNATRACE_API_TOKEN` | for all but `trace get` | Access token, sent as `Api-Token` |
| `platformUrl` | `TOIL_DYNATRACE_PLATFORM_URL` | for `trace get` | Platform URL, like `https://<environment-id>.apps.dynatrace.com` |
| `platformToken` | `TOIL_DYNATRACE_PLATFORM_TOKEN` | for `trace get` | Platform token, sent as `Bearer` |
| `env` | `TOIL_DYNATRACE_ENV` | no | The environment name `--env` selects this connection by, when it differs from the connection's name |

A command that needs a missing key fails with `NOT_CONFIGURED` naming it
("Dynatrace baseUrl not configured.").

Environment variables (CI, or a one-off shell):

```bash
export TOIL_DYNATRACE_BASE_URL=https://dynatrace.imagile.dev
export TOIL_DYNATRACE_API_TOKEN=<your access token>
export TOIL_DYNATRACE_PLATFORM_URL=https://dynatrace-platform.imagile.dev
export TOIL_DYNATRACE_PLATFORM_TOKEN=<your platform token>
```

## Environments

Each Dynatrace environment is one connection. `--env <name>` picks the connection
named `<name>`, or the one whose `env` setting is `<name>`; an environment toil
doesn't know is an `INVALID_INPUT` that lists the ones it has. Without `--env`, the
area's default connection is used: the one named in `defaults.dynatrace.connection`,
else the one named `dynatrace`, else the only one. Keys every environment shares
(often `platformUrl`) can go once under `defaults.dynatrace`; a connection's own
value wins over them.

```json
{
  "version": 2,
  "connections": {
    "prod": { "area": "dynatrace", "baseUrl": "https://dynatrace.imagile.dev" },
    "staging": { "area": "dynatrace", "baseUrl": "https://dynatrace.imagile.dev/e/abc12345-0000-0000-0000-000000000000" }
  },
  "defaults": { "dynatrace": { "connection": "prod" } }
}
```

The tokens never go in this file; a plaintext one there is refused with
`CONFIG_INVALID`. Run `toil connections add prod --area dynatrace` (or
`toil connections login prod` for an existing connection) to keep them in the OS
credential store, or set the env vars. `TOIL_DYNATRACE_*` variables configure the
default connection only; for another one use `TOIL_CONN_<NAME>_<KEY>`
(`TOIL_CONN_STAGING_API_TOKEN`).

```bash
toil dynatrace --env staging problem list
```

## Commands

- `entity list`: List monitored entities using an entity selector. `--selector`
  is required; `--from`, `--to` and `--fields` are passed through.
- `entity get <id>`: Get a monitored entity by ID (`--from`, `--to`, `--fields`). `data` is Dynatrace's entity as it came.
- `service list`: List monitored services: `entity list` with `type("SERVICE")`
  (`--from`, `--to`). `data` is `{ totalCount, services }`.
- `workload list`: List monitored Kubernetes workloads: `entity list` with
  `type("CLOUD_APPLICATION")` (`--from`, `--to`). `data` is `{ totalCount, workloads }`.
- `problem list`: List problems. `--from` defaults to `now-2h` and `--to` to `now`;
  `--problem-selector` and `--entity-selector` filter. `data` is
  `{ totalCount, problems }`.
- `problem get <id>`: Get a problem by ID (`--fields`). `data` is Dynatrace's
  problem as it came. A problem id often starts with `-`; on the CLI, put `--`
  before it so it isn't read as a flag (`problem get -- -1234567890123456789_1700000000000V2`).
- `trace get <id>`: Get distributed-trace spans from Grail (the id is 16 to 32
  hexadecimal characters). It runs `fetch spans | filter trace.id == "<id>" | sort start_time asc`
  and waits up to 60 seconds for Grail, polling at most once a second; past that it
  fails with `TIMEOUT`. `data` is the query's `result` (`records`, `types`,
  `metadata`). The query sends no timeframe and no record limit, so Grail's
  defaults apply: an old trace or a very large one may come back empty or cut short.

The lists fetch every page, 500 at a time, until Dynatrace stops returning a
`nextPageKey`; `totalCount` is the number of items collected. They stop with an
error after 1,000 pages, and like every command they're subject to toil's time limit
(`TOIL_TIMEOUT_MS`, 120 s by default).

Dynatrace's own error text isn't shown yet: an error is the status line, such as
`HTTP 400 Bad Request`, with toil's fix.

```bash
toil dynatrace entity list --selector 'type("HOST"),tag("team:payments")'
toil dynatrace problem list --from now-1d --problem-selector 'status("open")'
toil dynatrace trace get 4bf92f3577b34da6a3ce929d0e0e4736
```

## Checking a toil project

`check-toil-project` checks the call's toil project for the call's environment (`--env`, else the toil project's own): each entity id it names (`entity`, `entities`) exists, through `/api/v2/entities/{id}`. It's `toil dynatrace check-toil-project` (`--toil-project <name|file>`, or the toil project the folder resolves to), and it returns `{ toil project, connection, env, ok, checked, checks, unchecked }`, one check per value with its key path. The CLI exits 1 when one is missing. A failure other than not-found (a bad token, an unreachable host) fails the command. Read only.
