---
area: splitio
description: Split.IO feature flags, segments, environments and change requests through the Split Admin API
---

# Split.IO (`splitio`)

Feature flags, segments, environments and change requests on **Split.IO** (Harness
FME), through the Admin API under `/internal/api/v2` (flag sets under `/internal/api/v3`).
The reads list workspaces, environments, flags, segments, flag sets, traffic types,
attributes, rollout statuses and change requests; every write files a **change
request** that Split's approvers then accept or reject. toil never changes a flag or
a segment directly.
Verification level: `unit`.

**Supported versions:** The oldest Split.IO Admin API version toil supports hasn't been established. toil calls the
Admin API under `/internal/api/v2` (flag sets under `/internal/api/v3`) with an Admin API key sent as a Bearer header. It
has not been run against a live Split account yet.

## Credential

A Split **Admin API key**: in Split, Admin settings → API keys → Create API key, with
the type Admin. toil sends it as `Authorization: Bearer <key>`. There is no login and
no token exchange.

## Configuration

| Key | Env var | Required | Meaning |
|-----|---------|----------|---------|
| `baseUrl` | `TOIL_SPLITIO_BASE_URL` | yes | Admin API root, normally `https://api.split.io` |
| `adminApiKey` | `TOIL_SPLITIO_ADMIN_API_KEY` | yes | Admin API key |
| `workspace` | `TOIL_SPLITIO_WORKSPACE` | no | Default Split workspace (project) ID, used when `--ws` is not given |

There is no CI fallback variable.

```bash
export TOIL_SPLITIO_BASE_URL=https://api.split.io
export TOIL_SPLITIO_ADMIN_API_KEY=<your Admin API key>
```

Or `~/.toil/config.json`:

```json
{
  "version": 2,
  "connections": {
    "split": { "area": "splitio", "baseUrl": "https://api.split.io", "workspace": "<workspace id>" }
  }
}
```

The key never goes in this file; a plaintext one there is refused with
`CONFIG_INVALID`. Run `toil connections add split --area splitio` to keep it in the
OS credential store, or set `TOIL_SPLITIO_ADMIN_API_KEY`.

## The workspace is `--ws`

Every command but `workspace list`, `segment keys`, `flag-set get` and
`change-request get` acts in one Split
workspace: `--ws <id>`, else the connection's `workspace`. Over MCP the field is
`workspace`. **On the CLI, `--workspace` is toil's own flag** for the folder commands
may read files in, so `--workspace <split id>` doesn't name the Split workspace; a
command left without one fails with `INVALID_INPUT` saying to pass `--ws`.

## Commands

Reads:

- `workspace list`: List all Split.IO workspaces, every page.
- `environment list`: List environments in a workspace.
- `flag list`: List feature flags in a workspace. `--limit` (default 50, Split's
  maximum) and `--offset` (default 0); `data.totalCount` is Split's total.
  `--flag-set` is sent as `flagSetName`, which Split's reference doesn't document,
  so the result carries a warning to compare `totalCount` with an unfiltered list.
  `--tag <tag>` (repeatable) is Split's own server-side filter. `--search <text>` keeps
  the flags whose name contains the text, in any letter case: Split has no name
  filter, so toil reads every page, 50 at a time, and adds `searched` (how many flags
  it read) and `complete` (`true` when that reached Split's `totalCount`, `null` when
  Split gave no total). It takes no `--limit` or `--offset`, and a timeout is an
  error, never a partial list.
- `flag get <flag>`: Get a flag, or with `--environment` its definition in that
  environment: treatments, rules, default rule, kill state.
- `segment list`: List segments in a workspace, or with `--environment` those enabled
  there. `--limit` (default 50, Split's maximum) and `--offset`; `data.totalCount` is
  Split's total.
- `segment keys <segment> --environment <id>`: The keys in a segment in one
  environment, as plain strings in `data.keys`. `--limit` (default 100, Split's
  maximum) and `--offset`; `data.totalCount` is the segment's total.
- `large-segment list`, `large-segment get <name>`: Large segments in a workspace
  (`--environment` lists those enabled there), or one by name. toil doesn't upload
  their keys: Split takes those at a pre-signed URL on another host.
- `rule-based-segment list`, `rule-based-segment get <name>`: Rule-based segments in a
  workspace (`--environment` lists those enabled there, with their rules), or one by
  name.
- `flag-set list`: Flag sets in a workspace. `--limit` (default 200, Split's maximum);
  Split pages by marker, so pass `meta.page.nextCursor` as `--cursor` for the next
  page. `totalCount` is `null`, since Split reports none.
- `flag-set get <id>`: Get a flag set by ID.
- `traffic-type list`: Traffic types in a workspace; `attribute list` takes their IDs.
- `attribute list --traffic-type <id>`: The attributes of a traffic type. `--prefix`
  keeps the ones whose ID starts with the text, in any letter case, searched by Split.
  `--limit` (default 50, up to 200) and `--cursor`, paged by marker as `flag-set list` is.
- `rollout-status list`: The rollout statuses in a workspace: the IDs that
  `--rollout-status` takes.
- `change-request list`: List Change Requests for a workspace (`--environment`,
  `--status`; Split returns `REQUESTED` ones when `--status` is unset). `--limit`
  defaults to 25 (Split allows 1 to 100). Split pages by marker: pass
  `data.nextMarker` (also `meta.page.nextCursor`) as `--after` for the next page.
  `--offset` accepts only 0, and `totalCount` is `null`, since Split reports none.
- `change-request get <id>`: Get a Change Request by ID.

Flag writes, each a change request against one `--environment`. They need `writes: true`
on the connection and `--allow-write` on the call. Every one takes `--mnemonic` (the
title), `--description` (the comment), `--change-number` (added to the comment as
"Change number: …", since Split has no field for it), `--approvers` (comma-separated
email addresses, only where the environment lets submitters choose) and
`--rollout-status <id>` (a rollout status ID from `rollout-status list`; Split's guide
says KILL doesn't need one, and the others may).

- `flag update <flag>`: Replace a flag's definition with the JSON object in `--input-file`
  (`-` reads stdin on the CLI). Start from `flag get <flag> --environment`.
- `flag set-rule <flag>`: Change rule `--rule-index` (from 0) to one `--treatment` (a
  100% bucket) or `--weights` (a JSON array of `{treatment, size}`, sizes in percent;
  anything but an array is refused).
  The rest of the definition is copied from the current one.
- `flag set-default <flag>`: Set the default rule to one `--treatment` at 100%.
- `flag toggle <flag>`: `--enabled false` (or `0`) kills the flag; **any other value
  restores it**, `off` and `no` included. A value other than `true` or `1` that
  restores adds a `SPLITIO_TOGGLE_RESTORED` warning to `meta.warnings` saying so.
- `flag toggle-many`: One change request per entry of `--input-file`, a JSON array
  of `{flag, enabled}`, titled `<mnemonic> — <flag>`. A failed entry doesn't stop the
  rest; it's reported in `results[]` with `ok: false`, the envelope stays `ok`, and
  `meta.warnings` says how many failed. `enabled` is read by truthiness, so the
  string `"false"` restores. Every entry must have a `flag` name; if one doesn't, the
  command fails with `INVALID_INPUT` naming the entry, before any request is filed.
- `flag kill <flag>`, `flag restore <flag>`: Kill or restore a flag in the environment.
- `flag archive <flag>`: Remove a flag's definition from the environment (Split's
  `ARCHIVE` change request; not Split's flag-archive API). CLI only: it removes a
  definition, and deletes are never served over MCP.

Segment writes are change requests too, with the same gate and the same
`--mnemonic`, `--description`, `--change-number` and `--approvers`, but no
`--rollout-status`, which belongs to flags:

- `segment add-keys <segment> --environment <id>`: Add keys to a standard segment
  (Split's `CREATE` change request). Keys come from `--key` (repeatable) and
  `--keys-file` (one key per line, a JSON array of strings, or the output of `segment
  keys`, so the two pipe; `-` reads stdin on the
  CLI), together and each once. More than 10,000, Split's limit for one change, is
  refused with `INVALID_INPUT` before anything is filed.
- `segment remove-keys <segment> --environment <id>`: Remove keys from a standard
  segment (Split's `ARCHIVE` change request, which here means remove), taking keys as
  `add-keys` does.
- `rule-based-segment update <name> --environment <id>`: Replace a rule-based segment's
  definition in the environment with the JSON object in `--input-file`. Only its `rules`,
  `excludedKeys` and `excludedSegments` are sent, so `rule-based-segment get` output
  (its `data`, or the whole envelope) can be edited and passed back. A file with none
  of the three is refused with `INVALID_INPUT` before anything is filed, since a
  request with no rules would clear them.

```bash
toil splitio workspace list
toil splitio flag list --ws <workspace id> --search checkout
toil splitio segment keys beta_users --environment <environment id>
toil splitio segment add-keys beta_users --ws <workspace id> --environment <environment id> \
  --key user-1 --key user-2 --mnemonic beta-cohort --description "Add the pilot users" --change-number CHG0001234 --allow-write
toil splitio flag get new_checkout --ws <workspace id> --environment <environment id>
toil splitio flag kill new_checkout --ws <workspace id> --environment <environment id> \
  --mnemonic checkout-off --description "Kill during incident" --change-number CHG0001234 --allow-write
```
