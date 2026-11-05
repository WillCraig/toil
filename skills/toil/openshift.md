---
area: openshift
description: Pod health, deployments, warning events, pod logs and CPU and memory usage on OpenShift and Kubernetes clusters
---

# OpenShift / Kubernetes (`openshift`)

Pod health, Deployments and DeploymentConfigs, warning events, pod logs, and CPU and
memory usage for one namespace, read from the cluster's API server over REST. Every
command reads; none changes anything. There's no kubeconfig and no other CLI
involved. Verification level: `unit`.

**Supported versions:** The oldest OpenShift / Kubernetes version toil supports hasn't been established.
`pod list`, `event list` and `pod logs` use core `v1`; `deployment list` uses `apps/v1`, or
`apps.openshift.io/v1` for DeploymentConfigs; `pod metrics` and `namespace usage` need
metrics-server (`metrics.k8s.io/v1beta1`). No release has been verified yet.

## Credential

A **Bearer token**, typically a service account token with read access to the
namespaces you'll ask about. The OpenShift web console's Copy login command shows a
token for your own user; for anything long-lived, create a service account token.
toil sends it as `Authorization: Bearer <token>` to the connection's `baseUrl` and
nowhere else.

## Configuration

One connection per cluster.

| Key | Env var | Required | Meaning |
|-----|---------|----------|---------|
| `baseUrl` | `TOIL_OPENSHIFT_BASE_URL` | yes | API server URL, e.g. `https://openshift.imagile.dev` |
| `token` | `TOIL_OPENSHIFT_TOKEN` | yes | Bearer token |
| `env` | `TOIL_OPENSHIFT_ENV` | no | Environment name `--env` selects this cluster by, e.g. `prod` |
| `instance` | `TOIL_OPENSHIFT_INSTANCE` | no | Cluster instance name `--instance` selects this cluster by, e.g. `east` |

There's no CI fallback variable. `TOIL_OPENSHIFT_*` sets the default connection; any
other connection takes `TOIL_CONN_<NAME>_*`.

```bash
export TOIL_OPENSHIFT_BASE_URL=https://openshift.imagile.dev
export TOIL_OPENSHIFT_TOKEN=<your token>
```

Several clusters, in `~/.toil/config.json`:

```json
{
  "version": 2,
  "connections": {
    "prod-east": { "area": "openshift", "baseUrl": "https://api.prod-east.openshift.imagile.dev:6443", "env": "prod", "instance": "east" },
    "dev-east": { "area": "openshift", "baseUrl": "https://api.dev-east.openshift.imagile.dev:6443", "env": "dev", "instance": "east" }
  },
  "defaults": { "openshift": { "connection": "prod-east" } }
}
```

The token never goes in this file; a plaintext one there is refused with
`CONFIG_INVALID`. Run `toil connections add prod-east --area openshift` (or
`toil connections login prod-east`) to keep it in the OS credential store, or set
`TOIL_CONN_PROD_EAST_TOKEN`.

### Choosing a cluster

`--env <name>` and `--instance <name>` go on the group (`toil openshift --env prod
--instance east pods ...`) or after the command. Each picks the connection with that
name, or the one whose `env` (or `instance`) setting matches. Given together, they
must pick the same connection. When a value matches several, the other flag narrows
it: with two `prod` clusters, `--env prod --instance east` picks the one that is both,
while `--env prod` alone is an `INVALID_INPUT` naming them, so add `--instance` or use
`--connection <name>`. An
unknown name is an `INVALID_INPUT` listing the clusters toil knows. With neither
flag, the default connection is used (`defaults.openshift.connection`, else the one
named `openshift`, else the only one).

Where the contract nests clusters in an `openshift.environments.<env>.instances.<instance>`
map, toil has one connection per cluster with `env` and `instance` set. The contract's
`defaultEnvironment` and `defaultInstance` are `defaults.openshift.connection`, and its
flat `baseUrl` and `token` are a connection with neither set.

A cluster with `env` and `instance` set reports a missing `baseUrl` or token as
`OpenShift cluster "<env>/<instance>" is not configured or missing baseUrl.` or
`... is missing a token.`; one without them as `OpenShift not configured.` or
`OpenShift credentials not configured.`, all `NOT_CONFIGURED`.

## Commands

Every command but `cluster list` needs `--namespace <ns>`.

- `cluster list`: Lists every configured cluster: it runs `toil connections list --area
  openshift` (CLI only; over MCP, call the `connections_list` tool with `area`
  `openshift`). Each connection shows its `name`, `isDefault`, `host`, `writes` and
  where each setting came from, never a secret. It takes no `--env` or `--instance`.
- `pod list`: Pod health summary: phase counters, `crashLoopBackOff`,
  `imagePullBackOff` (which includes `ErrImagePull`), `oomKilled` and
  `totalRestarts`, then each pod with `phase`, `ready`, `restartCount`, `age`,
  `reason`, `message`, `containers` and `labels`. Failed pods come first, then
  Pending, then Unknown, then the rest, by restarts within each. `--label-selector`
  filters; `--raw` returns the pod objects unmodified, with `count`.
- `deployment list`: Deployments (`apps/v1`), or DeploymentConfigs
  (`apps.openshift.io/v1`) with `--deployment-configs`: `ready` as `ready/desired`,
  replica counts, `age`, `images`, `strategy`, `latestVersion`, and only the problem
  conditions (Available or Progressing that are `False`, and any ReplicaFailure),
  sorted by unavailable replicas. `--raw` returns the objects unmodified.
- `event list`: Warning events only, unless `--all`. `--field-selector` adds to the
  `type=Warning` selector, joined with a comma. Sorted by `count`, highest first.
- `pod logs <pod>`: The last `--lines` (default 100) lines of the pod's log, as text in `log`.
  `--container` picks a container; without it no container is sent, and the API
  server refuses a pod with more than one unless it names a default container.
  `--previous` reads the previous container instance.
- `pod metrics`: Each pod's containers with their raw `cpu` and `memory` usage, from
  metrics-server.
- `namespace usage`: One row per container: usage, limits and requests, in millicores
  (`m`) and mebibytes (`Mi`); a quantity toil can't read is `null`. `--csv --out
  <file>` also writes the rows as CSV to a new file inside the workspace (it never
  overwrites) and returns its absolute path as `file`. `--csv` needs `--out`, and
  `--out` needs `--csv`. The CSV header is `Pod,Container,CPU Usage (m),Memory Usage
  (Mi),CPU Limits (m),Memory Limits (Mi),CPU Requests (m),Memory Requests (Mi)`, with
  an empty cell for `null`.

Lists come back whole: the API server is asked for everything in one response, with
no paging.

```bash
toil openshift pod list --namespace payments
toil openshift --env prod --instance east event list --namespace payments --all
toil openshift pod logs api-7d9f8b6c5-abcde --namespace payments --container api --lines 50
toil openshift namespace usage --namespace payments --csv --out usage.csv
```

## Checking a toil project

`check-toil-project` checks the call's toil project for the call's environment (`--env`, else the toil project's own) against that environment's cluster: each namespace it names (`namespace`, `namespaces`) is a project the token can see, and each deployment in `deployments` exists in its namespace. With one namespace per repo, a deployment passes when any of them has it, and the check's `note` says where it was looked for. It's `toil openshift check-toil-project` (`--toil-project <name|file>`, or the toil project the folder resolves to), and it returns `{ toil project, connection, env, ok, checked, checks, unchecked }`, one check per value with its key path. The CLI exits 1 when one is missing. A failure other than not-found (a bad token, an unreachable host) fails the command. Read only.
