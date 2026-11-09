---
area: connections
description: Which scopes or permissions a credential needs before toil can use it, for read-only use and for everything toil can do
---

# What a credential must be allowed to do (`connections`)

Setting up, listing and testing connections is in `core.md`, **Configuration**, and
`setup.md`. This page is the one local, read-only command in the group: it answers
"what do I tick on the vendor's token page?".

## `toil connections scopes`

```bash
toil connections scopes                 # every area that declares scopes
toil connections scopes --area github   # one area
```

It reads nothing from your config, sends nothing, and needs no connection, so it works
before anything is set up. It is a plain read over MCP too (`connections_scopes`).

For each area whose credential has named scopes (`github` today) it returns the kinds of
credential the area accepts, and for each kind:

| Field | Meaning |
|-------|---------|
| `id`, `label`, `tokenPrefix` | The kind (`classic`, `fine-grained`) and how its tokens start (`ghp_`, `github_pat_`), so you can tell which one you hold |
| `readOnly.needs` | What read-only use needs. A fine-grained permission reads `Pull requests: Read` |
| `everything.needs` | What everything toil can do needs. The highest level per permission: `Pull requests: Read and write` |
| `createUrl` (inside `readOnly` and `everything`) | The vendor's page for making that token, with the scopes filled in where the vendor takes them in the link. Nothing is sent to it; open it yourself |
| `entries` | Every scope with `required` (`read` when read-only use needs it, `write` when only writes do), the `commands` that need it, and a `note` |

`--area` for an area that declares no scopes returns an empty `areas` list and a
`NO_SCOPES_DECLARED` warning. That means toil does not say, not that nothing is needed.

toil never checks a token's scopes. A token short of one gets the service's own refusal,
which toil reports as `AUTH` with the fix. Writes still need `writes: true` on the
connection and `--allow-write`; a classic GitHub `repo` token cannot be read-only, and
toil's own gate is what keeps it so until you turn writes on.
