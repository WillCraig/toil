---
area: osv
description: Known vulnerabilities for a dependency inventory, from the public OSV.dev API
---

# OSV.dev (`osv`)

Known vulnerabilities for the packages in a dependency inventory, from Google's
public **OSV.dev** API (`https://api.osv.dev`). It reads only and needs no
connection. Verification level: `unit`.

**Supported versions:** OSV API v1 or later

## Credential and configuration

None. OSV.dev is a public API, and the command names it, so toil talks to
`https://api.osv.dev` and nothing else. There is no connection to add, no `TOIL_OSV_*`
variable and no `--connection` flag. toil uses `HTTPS_PROXY`, `HTTP_PROXY` and
`NO_PROXY` when they're set.

## Commands

### `toil osv vulns`

Checks an inventory, a JSON list of packages, against OSV.dev. MCP tool: `osv_vulns`.

```bash
echo '[{"name":"lodash","version":"4.17.20","ecosystem":"npm"}]' > inventory.json
toil osv vulns --input-file inventory.json
toil osv vulns --input-file inventory.json --ecosystem npm --direct-only
```

| Flag | Meaning |
|------|---------|
| `--input-file <path>` | A JSON file holding a list of `{ name, version, ecosystem }` packages (`ecosystem` is `npm`, `nuget` or `maven`; Maven names are `group:artifact`). Optional `type` (`direct`/`transitive`) and `scope` (`production`/`dev`) feed the filters below. `toil deps scan` output (its envelope or its `data`) is accepted too, so `toil deps scan | toil osv vulns` works. Omitted, the inventory is read from stdin on the CLI. Over MCP pass `inputFile`; there is no stdin |
| `--ecosystem <ecosystem>` | `npm`, `nuget`, `maven` or `all` (default). Any other value matches nothing and returns a clean result |
| `--direct-only` | Leave out packages the inventory marks `transitive` |
| `--include-dev` | Keep packages the inventory marks `dev` (left out by default) |

It first checks OSV.dev answers (an empty batch), then sends `POST /v1/querybatch`
with up to 500 packages a request, one request after another. Ecosystems go as
`npm`, `NuGet` and `Maven`; Maven names are `group:artifact`.

Output, the same shape `deps frisk` had:

```json
{
  "tier": "full", "source": "osv", "sourcesQueried": ["osv"], "sourceErrors": [],
  "scanned": 4, "vulnerable": 1,
  "packages": [{
    "name": "lodash", "version": "4.17.20", "ecosystem": "npm", "source": "package-lock.json", "type": "direct", "scope": "production",
    "vulnerabilities": [{
      "id": "GHSA-35jh-r3h4-6jhm", "summary": "Command Injection in lodash", "severity": "HIGH", "cvss": null, "aliases": ["CVE-2021-23337"],
      "remediation": { "fixAvailable": true, "fixedVersions": ["4.17.21"], "advice": "Upgrade lodash to 4.17.21" },
      "references": ["https://github.com/advisories/GHSA-35jh-r3h4-6jhm"]
    }]
  }]
}
```

OSV's batch query answers with vulnerability ids only, so toil then fetches each
distinct id's full record (`GET /v1/vulns/<id>`, eight at a time) and fills
`summary`, `severity`, `cvss`, `aliases`, `references` and the fix from it.
`fixedVersions` collects the `fixed` events of every affected package in the record,
and `severity` is the record's `database_specific.severity` as given (GHSA uses
`MODERATE`), so read the advice against the advisory for multi-package records.

## Errors

- `INVALID_INPUT`: the inventory isn't JSON, is a failed result, has no packages
  list, or has a package without a name, version or ecosystem. Nothing is sent.
- `NETWORK`: "toil osv vulns requires OSV.dev access but api.osv.dev is not reachable
  from this machine." The reachability check failed; `error.details.cause` says how.
- `HTTP`: `OSV.dev returned HTTP <status> <reason>` for a batch that failed, and
  `OSV.dev returned HTTP <status> <reason> for <id>` (`NOT_FOUND` for a 404) for a record that couldn't
  be fetched.

## Alias paths

`deps frisk` (the default source) and `deps frisk --source osv` run `toil osv vulns`, with the same
`--ecosystem`, `--direct-only`, `--include-dev` and `--input-file` flags.
