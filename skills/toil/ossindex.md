---
area: ossindex
description: Known vulnerabilities for a dependency inventory, from the public Sonatype OSS Index API
---

# Sonatype OSS Index (`ossindex`)

Known vulnerabilities for the packages in a dependency inventory, from the public
**Sonatype OSS Index** API (`https://ossindex.sonatype.org`). It reads only.
Verification level: `unit`.

**Supported versions:** OSS Index REST API v3 or later

## Credential

OSS Index requires a free account: anonymous requests get HTTP 401. Sign up at
`https://ossindex.sonatype.org`, then copy the **API token** from your account
settings. toil sends your username and that token as HTTP Basic auth, and only ever
to `https://ossindex.sonatype.org`: the host is fixed, because the command names the
service, so there's no `baseUrl` setting.

## Configuration

| Key | Env var | Required | Meaning |
|-----|---------|----------|---------|
| `username` | `TOIL_OSSINDEX_USERNAME` | yes | Your OSS Index username (the email address you signed up with) |
| `token` | `TOIL_OSSINDEX_TOKEN` | yes | Your OSS Index API token |

```bash
export TOIL_OSSINDEX_USERNAME=you@example.com
export TOIL_OSSINDEX_TOKEN=<your API token>
```

Or add a connection with `toil connections add ossindex --area ossindex`, which keeps
the token in the OS credential store. A plaintext token in the config file is refused
with `CONFIG_INVALID`. With neither set, the command fails with `NOT_CONFIGURED`
before sending anything. toil uses `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` when
they're set.

## Commands

### `toil ossindex vulns`

Checks an inventory, a JSON list of packages, against OSS Index. MCP tool:
`ossindex_vulns`.

```bash
echo '[{"name":"lodash","version":"4.17.20","ecosystem":"npm"}]' > inventory.json
toil ossindex vulns --input-file inventory.json
toil ossindex vulns --input-file inventory.json --ecosystem maven
```

| Flag | Meaning |
|------|---------|
| `--input-file <path>` | A JSON file holding a list of `{ name, version, ecosystem }` packages (`ecosystem` is `npm`, `nuget` or `maven`; Maven names are `group:artifact`). Optional `type` (`direct`/`transitive`) and `scope` (`production`/`dev`) feed the filters below. `toil deps scan` output (its envelope or its `data`) is accepted too, so `toil deps scan | toil ossindex vulns` works. Omitted, the inventory is read from stdin on the CLI. Over MCP pass `inputFile`; there is no stdin |
| `--ecosystem <ecosystem>` | `npm`, `nuget`, `maven` or `all` (default). Any other value matches nothing and returns a clean result |
| `--direct-only` | Leave out packages the inventory marks `transitive` |
| `--include-dev` | Keep packages the inventory marks `dev` (left out by default) |

It first checks OSS Index answers (an empty list of coordinates), then sends
`POST /api/v3/component-report` with up to 128 package URLs a request, one request
after another: `pkg:npm/%40scope/name@1.0.0`, `pkg:nuget/Name@1.0.0`,
`pkg:maven/<group>/<artifact>@1.0.0`. Reports are matched back by their exact
`coordinates`; one OSS Index returns in another form is dropped.

Output is the same shape `deps frisk --source sonatype` had, so `source` is
`sonatype`:

```json
{
  "tier": "full", "source": "sonatype", "sourcesQueried": ["sonatype"], "sourceErrors": [],
  "scanned": 4, "vulnerable": 1,
  "packages": [{
    "name": "org.apache.logging.log4j:log4j-core", "version": "2.14.1", "ecosystem": "maven", "source": "pom.xml", "type": "direct", "scope": "production",
    "vulnerabilities": [{
      "id": "CVE-2021-44228", "summary": "[CVE-2021-44228] Improper input validation", "severity": "CRITICAL", "cvss": 10,
      "aliases": ["CVE-2021-44228"],
      "remediation": { "fixAvailable": false, "fixedVersions": [], "advice": "See https://ossindex.sonatype.org/vulnerability/CVE-2021-44228 for remediation details for org.apache.logging.log4j:log4j-core@2.14.1." },
      "references": ["https://ossindex.sonatype.org/vulnerability/CVE-2021-44228"]
    }]
  }]
}
```

`id` is the vulnerability's display name, `severity` comes from its CVSS score (9
CRITICAL, 7 HIGH, 4 MEDIUM, above 0 LOW, else UNKNOWN), and `aliases` are the CVE ids
found in its name, title and description. OSS Index gives no fixed versions, so
`fixAvailable` is always `false`.

## Errors

- `INVALID_INPUT`: the inventory isn't JSON, is a failed result, has no packages
  list, or has a package without a name, version or ecosystem. Nothing is sent.
- `NOT_CONFIGURED`: no OSS Index account is set up; set `TOIL_OSSINDEX_USERNAME` and
  `TOIL_OSSINDEX_TOKEN`.
- `AUTH`: OSS Index rejected the username and token.
- `NETWORK`: "toil ossindex vulns requires Sonatype OSS Index access but
  ossindex.sonatype.org is not reachable from this machine." The reachability check
  failed; `error.details.cause` says how.
- `HTTP`: "Sonatype OSS Index is rate-limiting requests from this IP…" on a 429. The
  limit is per account; wait and retry.
- `HTTP`: `Sonatype OSS Index returned HTTP <status> <reason>` for any other failed batch.

## Alias paths

`deps frisk --source sonatype` runs `toil ossindex vulns`, with the same `--ecosystem`,
`--direct-only`, `--include-dev` and `--input-file` flags.
