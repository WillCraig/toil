---
area: util
description: Local utilities with no connection or network, decoding a JWT, inventorying dependencies from manifests and lockfiles, checked encoding and hashing, decoding certificates and checking a chain, summarising test, SARIF and coverage reports, triaging a large log, scanning for secrets before a commit or post, sizing files and folders before reading them, time zone, duration, business-day and cron arithmetic, comparing versions and ranges for npm, NuGet and Maven, converting Markdown to and from Jira and Confluence formats, reading OpenAPI documents, drawing C4 architecture diagrams from a JSON model, mapping Jira, Azure DevOps and GitHub work items to Open Work Items, and finding likely duplicates among them
---

# Local utilities (`util`)

Commands that work on what's on this machine: a token or version you paste, a file or
folder in the workspace (a certificate, a log or an API description), the manifests and lockfiles there, a
report a build left behind, a C4 model described in JSON, text you're about to commit or post, or a time and a time zone. They aren't
integrations. There is no server, no connection to add, no `TOIL_UTIL_*`
variable, no credential and no `--connection` flag, and none of them sends
anything over the network. None changes anything: the only file one writes is a
new one you name with `--out`, inside the workspace, and it never replaces a
file. Verification level: `unit`.

`jwt` and `deps` also have a short path, an alias that does the same thing with
the same flags and output:

| Command | Alias | MCP tool |
|---------|-------|----------|
| `toil util jwt decode` | `toil jwt decode` | `util_jwt_decode` |
| `toil util deps scan` | `toil deps scan` | `util_deps_scan` |
| `toil util deps diff` | `toil deps diff` | `util_deps_diff` |
| `toil util secrets scan` | none | `util_secrets_scan` |
| `toil util encode` | none | `util_encode` |
| `toil util cert` | none | `util_cert` |
| `toil util report` | none | `util_report` |
| `toil util log` | none | `util_log` |
| `toil util size` | none | `util_size` |
| `toil util time convert` | none | `util_time_convert` |
| `toil util time duration` | none | `util_time_duration` |
| `toil util time business-days add` | none | `util_time_business_days_add` |
| `toil util time business-days diff` | none | `util_time_business_days_diff` |
| `toil util time cron` | none | `util_time_cron` |
| `toil util semver compare` | none | `util_semver_compare` |
| `toil util semver satisfies` | none | `util_semver_satisfies` |
| `toil util semver sort` | none | `util_semver_sort` |
| `toil util semver bump` | none | `util_semver_bump` |
| `toil util md` | none | `util_md` |
| `toil util openapi list` | none | `util_openapi_list` |
| `toil util openapi show` | none | `util_openapi_show` |
| `toil util openapi example` | none | `util_openapi_example` |
| `toil util c4 render` | none | `util_c4_render` |
| `toil util c4 mermaid` | none | `util_c4_mermaid` |
| `toil util c4 d2` | none | `util_c4_d2` |
| `toil util owi map` | none | `util_owi_map` |
| `toil util owi similar` | none | `util_owi_similar` |

Over MCP the tools are served without any configuration. `toil mcp --areas util`
serves just these.

## By job

The same commands, grouped by what you need them for.

### Reading CI output

What a build or a scanner leaves behind, turned into something short enough to read: totals and failures from a report, and the errors that matter from a log thousands of lines long.

- **Summarising a report** (`toil util report`): Turns what CI and scanners write into one JSON summary. JUnit XML (Maven Surefire, Jenkins and Azure DevOps shapes) and TRX become test totals plus each failure with its suite, name, file, line, message and the first lines of its stack. SARIF 2.1.0 becomes findings with rule, level, file and line. lcov and Cobertura become per-file line and branch percentages and the lowest-covered files.
- **Triaging a log** (`toil util log`): Reads a CI console, a Maven, npm or dotnet build, or a test run, and returns what's worth reading: the error and warning lines grouped by signature, with numbers, ids, timestamps and hex replaced so the same complaint counts once. Each group has its count, its first and last line, one sample, and the Java, .NET, Node or Python stack trace that belongs to it.

### Writing for the tools

Getting text into the shape an enterprise tool expects before it's sent, so a description, a page or a request arrives the way it was meant.

- **Converting Markdown** (`toil util md`): Turns Markdown into Jira wiki markup (Jira Data Center), Atlassian Document Format (Jira Cloud and Confluence Cloud) or Confluence storage format (Confluence Data Center), and any of those back into Markdown.
- **Reading an OpenAPI document** (`toil util openapi list`, `toil util openapi show`, `toil util openapi example`): Reads an OpenAPI 3.0, 3.1 or 3.2 or Swagger 2.0 document, so an agent calls an endpoint right the first time: `list` gives every operation, `show` lays one out with each parameter and where it goes, its request and response bodies with `$ref`s expanded, and the exact inputs for `toil <area> api`, and `example` builds the smallest body its schema accepts.
- **Drawing a C4 architecture diagram** (`toil util c4 render`, `toil util c4 mermaid`, `toil util c4 d2`): Draws one view of a C4 model (a system context, container or component view) from JSON an agent writes: `render` lays it out and returns SVG, people on top and the scope's children inside a dashed boundary, checked for overlaps, arrows behind boxes and well-formed XML, and `mermaid` and `d2` write the same view as text for places that draw it themselves, such as a Mermaid block in Markdown on GitHub.

### Reading the trackers as one

Work from Jira, Azure DevOps and GitHub in one shape, so a sprint, a board or a question about the work reads the same whichever tracker holds it.

- **Mapping to Open Work Items** (`toil util owi map`): Turns what the jira, ado and github commands print into Open Work Items: one model with a type, a status and its category, people, an estimate with its unit and the field it came from, the sprint, parent and children, links, dates and the history of transitions and sprint moves. A GitHub issue and its project board item become one item. The pull requests of github, bitbucket (Data Center or Cloud), ado (Server or Services) and ado become changes: state, who wrote it (a person, an agent or a bot, and the signal that said so), reviewers, checks, size, the work items it names and its review timeline. Every record is checked against the published schema.
- **Finding likely duplicates** (`toil util owi similar`): Before filing, proposing or triaging an item, asks whether it already exists: ranks OWI records against some text or one of them, or lists likely duplicate pairs across Jira, Azure DevOps and GitHub. Lexical and deterministic, with no model or network, and every match says why it matched: the shared title and body terms, title trigrams, labels, parent and link.

### Safety

Checks to run before something leaves the machine or gets trusted: a secret in a diff, a certificate chain that won't validate, a token's claims, and the dependencies a repository ships.

- **Scanning for secrets** (`toil util secrets scan`): Looks for credential-shaped strings before you commit, push or post them: tokens, keys, `password=` values, credentials in URLs, private keys and long random strings. It uses the same rules toil's audit log redacts with, plus an entropy check, and exits with 1 when it finds anything, so a hook or a pipeline can stop on it.
- **Decoding certificates** (`toil util cert`): Decodes a certificate or a chain bundle, PEM or DER: subject, issuer, SANs, serial, how many days it has left, its key, its signature algorithm, its basic constraints and key usage, and its fingerprints, so a TLS failure can be explained from the files. It never connects to the host.
- **Decoding a JWT** (`toil util jwt decode`): Shows a token's header and claims, so you can see who it's for, what it grants and when it expires.
- **Inventorying dependencies** (`toil util deps scan`, `toil util deps diff`): `deps scan` lists every package the workspace's npm, NuGet and Maven/Gradle manifests and lockfiles declare, with its version, the file it came from, and whether it's direct or transitive, production or dev. That inventory is what the vulnerability and licence commands read, one source per command, so you choose which service sees your dependency list. `deps diff` lists what was added, removed, upgraded or downgraded between two git refs.

### Arithmetic models get wrong

Work that looks simple and is easy to get subtly wrong by reasoning alone: time zones and DST, version ordering, encodings and hashes, and how big a file is before reading it. Each one works the answer out, then checks it a second way.

- **Time zones, durations, business days and cron** (`toil util time convert`, `toil util time duration`, `toil util time business-days add`, `toil util time business-days diff`, `toil util time cron`): Date arithmetic on the time zone data Node already ships: convert a time between zones, read or write an ISO 8601 duration, add or count business days, and list a cron schedule's next run times.
- **Comparing versions** (`toil util semver compare`, `toil util semver satisfies`, `toil util semver sort`, `toil util semver bump`): Compare, sort and bump versions, and check them against ranges, in the grammar of the ecosystem they come from: npm (SemVer 2.0.0 and npm's ranges, the default), NuGet (up to four parts, interval notation) or Maven (Maven's own ordering, where `1.0.0.Final` is `1` and `SNAPSHOT` comes before the release).
- **Encoding, decoding and hashing** (`toil util encode`): Base64, base64url, hex, URL components and form values, in either direction, and a file's SHA-256, SHA-1 or MD5 hash.
- **Sizing before reading** (`toil util size`): Tells an agent how much a file or folder will cost to read. For a file it gives bytes, lines, an estimated token count, and an outline: functions, classes and methods with their line ranges, plus the modules the file imports, for TypeScript, JavaScript, Python, C#, Java and Go, headings for Markdown, and top-level keys for JSON and YAML, so the agent reads only the lines it needs. For a folder it gives a tree of totals, largest first, and names the largest files.

## Commands

### `toil util jwt decode`

Decodes a JWT's header and claims **without verifying it**. There's no key and no
network call, and nothing here says whether the token is valid, expired or trusted.

```bash
toil util jwt decode eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhYmMxMjM0NSJ9.c2ln
echo "$TOKEN" | toil util jwt decode -
```

| Argument | Meaning |
|----------|---------|
| `<token>` | The token, `header.payload.signature`. `-` reads it from stdin, which keeps it out of the process list and your shell history; one trailing line ending is dropped |

Output: `{ header, payload, signature }`, the header and claims as parsed JSON and
the signature segment as the text it is.

- A token that isn't three dot-separated parts (an encrypted 5-part JWE, say) fails
  with `INVALID_INPUT`, `Invalid JWT: expected 3 dot-separated parts`.
- A header or payload that doesn't decode to JSON fails with `Invalid JWT: header is
  not valid JSON` (or `payload`). A `Bearer ` prefix gives this error too, so strip it.
- The decoding is lenient, as it has always been. A segment that is JSON but not an
  object (`null`, a number) comes back as it is. Characters outside base64url are
  skipped. Invalid UTF-8 shows as `�`. Whitespace in a token passed as an argument
  is kept, so a trailing newline ends up in `signature`.

The token goes nowhere but the decoder. toil doesn't log it, and no error message
repeats it.

### `toil util deps scan`

The dependency inventory of the workspace, from its manifests and lockfiles. It
reads files only and needs no git. It must be inside a git repository, though, or it
fails with `Not inside a git repository. deps commands require a git repo root.`

```bash
toil util deps scan
toil util deps scan --ecosystem npm --include-transitive --include-dev
toil util deps scan | toil osv vulns
```

| Flag | Meaning |
|------|---------|
| `--ecosystem <ecosystem>` | `npm`, `nuget`, `maven` or `all` (default). Any other value matches nothing and scans nothing |
| `--include-transitive` | Include transitive dependencies (left out by default) |
| `--include-dev` | Include dev and test dependencies (left out by default) |

Which files it reads:

- **Which files:** every file in the workspace that `git ls-files --cached --others
  --exclude-standard` would list. That's tracked files plus untracked ones `.gitignore`
  and `.git/info/exclude` don't cover. A nested repository isn't walked into. Your
  global git excludes file isn't read, so a file only it ignores is scanned. An
  ignore file that exists but can't be read applies no rules, with a
  `GITIGNORE_UNREADABLE` warning naming it and the fix.
- **npm:** `package.json` (not under `node_modules`), with the first of
  `package-lock.json` (v2 or later), `yarn.lock` (v1) or `pnpm-lock.yaml` beside it.
  A `package-lock.json` with no packages falls back to `package.json`.
- **NuGet:** `.csproj`, `.fsproj`, `.vbproj`, `packages.config` and
  `Directory.Packages.props`, with a `packages.lock.json` in the same folder. Project
  files that share one lock file count once. A project with no version on a
  `PackageReference` takes it from the nearest `Directory.Packages.props`, up to 10
  folders up.
- **Maven/Gradle:** `pom.xml`, `build.gradle` and `build.gradle.kts`, with a
  `gradle.lockfile` beside them.

A lockfile wins over its manifest. Packages are de-duplicated on ecosystem, name,
version and source file. A manifest that can't be read is skipped. One that exists
but can't be read (a link out of the workspace, say) also gets a
`DEPS_FILE_SKIPPED` warning in `meta.warnings`. That warning is the only check it
makes of its own result: the `deps` commands have no `verified` block, so treat the
quirks below as unchecked.

Output:

```json
{
  "ecosystems": ["npm", "nuget", "maven"],
  "manifests": [{ "file": "package.json", "ecosystem": "npm", "lockFile": "package-lock.json" }],
  "packages": [{ "name": "lodash", "version": "4.17.21", "ecosystem": "npm", "source": "package-lock.json", "type": "direct", "scope": "production" }],
  "summary": { "totalPackages": 1, "byEcosystem": { "npm": 1 }, "byType": { "direct": 1, "transitive": 0 }, "byScope": { "production": 1, "dev": 0 } }
}
```

Paths are relative to the workspace, with forward slashes. Maven names are
`group:artifact`. When the repository's root is above the workspace, only the
workspace is scanned: run it from the root, or pass `--workspace <root>`, to scan
everything.

Known quirks, which stay until they're checked against real repositories:

- In an npm v7+ lockfile, `direct` means hoisted to the top `node_modules`, so most
  transitive packages count as direct. Workspace folders show up as packages.
- Yarn 1 headers with several ranges give a garbled name. Yarn 2+ lockfiles give no
  packages.
- pnpm peer suffixes stay in the version, and pnpm 9's scoped packages are missed.
- `CentralTransitive` NuGet packages count as direct.
- `gradle.lockfile` test dependencies are always included.
- Any `word 'a:b:c'` string in `build.gradle` reads as a dependency.
- `pom.xml` plugin dependencies count as the project's.

The output is the inventory the vulnerability and licence commands read from stdin
or `--from <file>`: `toil osv vulns`, `toil ossindex vulns`, `toil sonatypeiq
evaluate`, and `toil artifactory package outdated` / `license-check`. Over MCP, save it to a
file in the workspace and pass that file's path as `from`.

### `toil util deps diff`

How the inventory changed between two git refs. This command runs the git on PATH:
`git ls-tree` for each ref's files and `git show` for each one it reads. Without git
it fails with `GIT_NOT_FOUND`.

```bash
toil util deps diff --from main
toil util deps diff --from v1.0.0 --to main --ecosystem npm --include-dev
```

| Flag | Meaning |
|------|---------|
| `--from <ref>` | The base ref: a commit, tag or branch. Required |
| `--to <ref>` | The target ref (default: the working tree, scanned as `deps scan` does) |
| `--ecosystem <ecosystem>` | `npm`, `nuget`, `maven` or `all` (default) |
| `--include-dev` | Include dev and test dependencies |

Transitive dependencies are always included. Output: `{ from, to, changes: [{ name,
ecosystem, change, from, to, source }], summary: { added, removed, upgraded,
downgraded, unchanged } }`. `change` is `added`, `removed`, `upgraded` or
`downgraded`. Unchanged packages are counted, not listed. `to` reads `working tree`
when `--to` is left out.

Known quirks:

- A ref git can't read (a typo, or one you haven't fetched) gives an empty
  inventory for that side, so a bad `--from` reports every package as `added`.
  Check the ref first.
- Each package is keyed on ecosystem, name and source file, and one version per key
  survives. A package present at two versions can show a change that didn't happen.
- Paths that git quotes (non-ASCII names) aren't read at a ref.
- A ref that starts with `-`, or an empty `--from`, is refused with `INVALID_INPUT` before git runs. An empty `--to` means the working tree.

### `toil util secrets scan`

Finds credential-shaped strings before an agent or a person commits, pushes,
comments or posts them. It reads a file, a folder, stdin, text, or the
repository's staged or working-tree diff, and talks to nothing.

```bash
toil util secrets scan --diff staged          # before git commit
toil util secrets scan src/                   # a folder, .gitignore respected
toil util secrets scan notes.md
gh pr view 12 --json body -q .body | toil util secrets scan -
toil util secrets scan --text "$COMMENT"
```

| Argument / flag | Meaning |
|-----------------|---------|
| `[path]` | A file or folder inside the workspace. A folder is walked as `git ls-files --cached --others --exclude-standard` would list it. `-`, or nothing at all, reads stdin |
| `--text <text>` | The content itself, instead of a file |
| `--diff <kind>` | `staged` scans what the next commit holds (`git diff --staged`); `working` scans unstaged changes (`git diff`). Added lines only, in the workspace only. Runs the git on PATH |
| `--allow-file <file>` | The allow file (default: `.toil/secrets-allow` at the workspace's top, when it exists) |

Pass one of a path, `--text` or `--diff`; two at once is `INVALID_INPUT`. Over
MCP, pass `file`, `text` or `diff`.

A folder that `.gitignore` excludes is walked as git lists it: only the files git
tracks there. When that's none, the result has no findings and a
`SECRETS_NOTHING_SCANNED` warning saying 0 files were scanned and why; name a file
in the folder to scan that file.

**The exit code is 1 when anything is found**, and 0 when nothing is, so a hook
or a pipeline can gate on it. The envelope stays `ok: true` either way; `ok:
false` (also exit 1) means the scan itself failed.

**What it looks for:**

- The rules the audit log redacts with, so toil has one definition of a
  secret: GitHub, GitLab, Slack (tokens and webhook URLs), AWS, SonarQube, `sk-`,
  Atlassian, Bitbucket Data Center, npm, Artifactory, Dynatrace, Figma and Azure
  DevOps tokens, Azure SAS signatures (`sig=`), JWTs, private keys, credentials
  in URLs, `Bearer` / `Basic` / `Token`
  values, `name=value` pairs whose name says secret (`password=`,
  `"apiToken":`, `--token=`), `curl -u user:pass`, and long random runs of
  letters and digits.
- `high-entropy`: a run of 20 or more base64 or base64url characters, holding
  letters and digits, that those rules didn't catch and whose Shannon entropy
  is at least 4.2 bits per character.

Two things are set aside and counted instead of reported: Subresource Integrity
checksums (`sha512-…` in lockfiles, counted in `summary.checksums`), and a named
value that is a reference to a secret rather than one (`token: ${{ secrets.X }}`,
`password=$DB_PASSWORD`, `<your-token>`, `xxx`, counted in
`summary.placeholders`). Commits, digests and UUIDs aren't findings.

Output:

```json
{
  "source": { "kind": "staged", "path": null },
  "findings": [{ "file": "config/application.properties", "line": 4, "column": 28, "length": 14, "rule": "name-value", "confidence": "high", "entropy": 3.18, "preview": "…", "fingerprint": "e594506f-49ad270a-55b41205-70d9b059" }],
  "allowed": [],
  "unreadable": [{ "file": "logo.png", "reason": "binary", "message": "logo.png is binary in the diff; its content wasn't scanned." }],
  "allowList": null,
  "summary": { "files": 1, "lines": 5, "findings": 1, "allowed": 0, "unreadable": 1, "checksums": 0, "placeholders": 0, "byRule": { "name-value": 1 } },
  "verified": { "passed": true, "checks": [] }
}
```

- `file` is relative to the workspace, with forward slashes, or `null` for
  stdin and text. `line` and `column` start at 1; columns count UTF-16 code
  units. A private key spanning lines is one finding, with `endLine`.
- `source.kind` is `file`, `folder`, `stdin`, `text`, `staged` or `working`.
- `confidence` is `high` for a vendor's token format, `high` or `medium` for a
  value a name or scheme marks as secret (medium when it's short and plain),
  and graded by entropy for a random run (`low` below 3.5 bits per character).
- **The full secret is never in the output**, nor in a warning, an error or the
  audit log, which keeps no copy of `text`. `preview` keeps at most 4
  characters at each end of a secret of 24 or more, 2 of one of 16 to 23, and
  none of a shorter one: `ghp_…c9vB`, `…`.
- `fingerprint` identifies the value without revealing it: a salted scrypt,
  four groups of 8 hex digits. It's slow on purpose, so a short password can't
  be recovered from it by guessing at speed.

**The allow file** lists known false positives, one fingerprint per line, copied
from a finding. `#` starts a comment. It's matched by fingerprint only, never by
the raw value, so it's safe to check in. A finding it names goes in `allowed`
instead of `findings` and doesn't set the exit code. `allowList` says which file
was read, how many entries it had, how many lines weren't fingerprints, and how
many entries matched nothing. A line that isn't a fingerprint is ignored with a
`SECRETS_ALLOW_INVALID` warning that gives its line number and never its text. A
named `--allow-file` that doesn't exist is `INVALID_INPUT`.

```text
# .toil/secrets-allow
e594506f-49ad270a-55b41205-70d9b059  # the test fixture's dummy password
```

**What it checks of its own result** (`verified`):

- `finding.reread`: every finding is read again at its reported line, from the
  file on disk, from the index (`git show :<path>`) for a staged diff, or from
  what stdin or the text held. The same characters must be at the same column,
  with the same rule finding them. A mismatch warns `SECRETS_REREAD_MISMATCH`.
- `preview.masked`: every preview is checked to hold none of the secret's
  middle. One that fails warns `SECRETS_PREVIEW_LEAK` and is replaced by `…`.
- `input.complete`: each file was read to its size on disk. For a diff this is
  `unchecked`, with an `UNVERIFIED` warning, since git's output has no size to
  compare with; the re-read checks each finding instead.

**What it couldn't read is listed**, never skipped silently. `unreadable` holds
each binary file, each file over 64 MiB, each one it couldn't open (a permission
error, say), each nested repository a folder scan didn't walk into, and each line
over 4 MiB, of which only the start was scanned. Any of them adds a
`SECRETS_UNREADABLE` warning. A single file named on the call that can't be read
is an `INVALID_INPUT` error instead. `--diff working` also warns
`SECRETS_UNTRACKED_NOT_SCANNED` with the number of untracked files, which no diff
holds: scan the folder, or stage them, to include them.

**A diff covers the workspace, not the whole repository.** When the workspace is
a folder inside the repository, changes outside it aren't scanned, and a
`SECRETS_DIFF_PARTIAL` warning gives the number of changed files left out. To
check a whole commit, run it with `--workspace` at the repository's top.

Known limits:

- A diff and a file are scanned line by line, so a secret split across two lines
  (other than a private key) isn't found.
- A private key spans lines only when its BEGIN line stands alone and an END
  line follows its body (base64, blank, `Proc-Type:` and `DEK-Info:` lines). It's
  then one finding, with `endLine`. When no END comes (another line, a gap
  between diff hunks, or the end of the file), the BEGIN line is reported on its
  own and the lines below it are scanned as usual.
- A bare `key=` isn't treated as a secret's name, because in toil's inputs it's
  an issue, space or project key. A real key there is still caught by its shape
  or its entropy.

### `toil util encode`

Encodes or decodes base64, base64url, hex and URL percent-encoding, and hashes a
file with SHA-256, SHA-1 or MD5. Each result is checked before it's returned, and
`data.verified` says how.

```bash
toil util encode base64 --text 'you@example.com:abc12345'
toil util encode base64 --decode mail-part.b64 --out logo.png
toil util encode url --text 'project = PAY AND assignee = "you@example.com"'
toil util encode form --decode --text 'project+%3D+PAY+AND+assignee+%3D+%22you%40example.com%22'
printf 'hello' | toil util encode hex
toil util encode sha256 release.tgz
```

| Argument or flag | Meaning |
|------------------|---------|
| `<scheme>` | `base64`, `base64url`, `hex`, `url`, `form`, or a hash: `sha256`, `sha1`, `md5`. Required |
| `[file]` | A file inside the workspace. `-`, or leaving out both the file and `--text`, reads stdin |
| `--text <text>` | The content itself, instead of a file. It's encoded as UTF-8 |
| `--decode` | Decode instead of encode. Not for a hash |
| `--out <file>` | Write the result to this new file inside the workspace instead of returning it. Never replaces a file. Not for a hash |

The schemes:

- **`base64`** is written padded. Decoding accepts it with or without padding, and
  ignores spaces and line breaks, so MIME-wrapped base64 reads as it is.
- **`base64url`** (`-` and `_`) is written without padding, as JWTs use it, and
  read with or without.
- **`hex`** is written in lower case and read in either. Spaces and line breaks are
  ignored; a `0x` prefix or `:` separators are not.
- **`url`** is a URL component, written as JavaScript's `encodeURIComponent` writes
  it: letters, digits and `-_.!~*'()` stay, every other byte becomes `%XX`.
- **`form`** is one name or value of an `application/x-www-form-urlencoded` body:
  letters, digits and `*-._` stay, a space becomes `+`, and every other byte becomes
  `%XX`. Decode a body one field at a time. A whole body decodes, but its `=` and
  `&` come back the same as an encoded `%3D` and `%26`, so `roundtrip.encode`
  fails, as it should.

Output:

- **Encode:** `{ operation: "encode", scheme, inputBytes, outputBytes, output, verified }`.
- **Decode:** `{ operation: "decode", scheme, inputBytes, outputBytes, utf8, output, verified }`.
  `utf8` says whether the decoded bytes are valid UTF-8.
- **Hash:** `{ operation: "hash", scheme, inputBytes, hex, base64, verified }`, the
  digest both ways.
- With `--out`, `file` (the absolute path written) replaces `output`.

The input is bytes: a file or stdin is encoded or hashed exactly as it is, so
`echo hello | toil util encode base64` includes the newline `echo` adds. Use
`printf` or `--text` to leave it out. When decoding, one trailing line ending is
dropped.

**Decoded bytes that aren't valid UTF-8 are refused** with `INVALID_INPUT` unless
`--out` names a file to write them to. JSON can only carry them as text, and any
text would be different bytes. Valid UTF-8 comes back as the text it is.

What `data.verified` checks:

| Check | What it means |
|-------|---------------|
| `roundtrip.decode` | An encode was decoded back, and gave exactly the input |
| `roundtrip.encode` | A decode was encoded again, and gave the input, allowing for whitespace, padding, the case of hex and `%XX`, and `%20` for `+` in a form |
| `input.complete` | The bytes read equal the file's size on disk, so a read that stopped short can't pass. Unchecked for stdin, which has no size |
| `output.file` | The file written was read back, and holds exactly the bytes written |

A failed check sets `verified.passed` to `false` and adds a warning:
`ENCODE_ROUNDTRIP_MISMATCH`, `INPUT_INCOMPLETE` or `ENCODE_OUTPUT_MISMATCH`. Input
that decodes but fails `roundtrip.encode` isn't how the scheme writes those bytes.
For example, base64 `QR==` decodes to `A`, but base64 writes `A` as `QQ==`, and a URL
with a space left in it isn't encoded. Check that it wasn't changed on the way.

Errors:

- Text that isn't the scheme is `INVALID_INPUT`, naming the offset of the first
  character that's wrong but never the character, in case the text is a credential.
  A base64 character that only base64url uses (or the other way round) says to try
  the other scheme.
- A file to decode that looks binary (a NUL byte), `--decode` or `--out` with a hash,
  and a scheme toil doesn't have are `INVALID_INPUT`.
- Encoding or decoding reads at most 64 MiB. A hash of a file streams, with no
  limit; stdin is held in memory, so it keeps the 64 MiB limit.

MD5 and SHA-1 are here to match checksums that other tools publish, not to protect
anything. The audit log keeps only a hash of `--text`.

### `toil util cert`

Decodes X.509 certificates, one or a chain bundle, in PEM or DER, so you can
explain a TLS failure from the files. It never connects to the host the certificate
is for: pass the file the server is configured with, or the chain a client saved.

```bash
toil util cert chain.pem
toil util cert chain.pem --host api.imagile.dev
toil util cert server.der
cat chain.pem | toil util cert -
```

| Argument or flag | Meaning |
|------------------|---------|
| `[file]` | A file in the workspace, PEM or DER. `-`, or leaving it out, reads stdin |
| `--text <text>` | The PEM itself, instead of a file. Over MCP, `text` is read as UTF-8, so a DER certificate goes as `file` |
| `--host <host>` | A host name or IP address: do the first certificate's SANs cover it? |

Output: `{ format, certificates, skipped, chain, host, verified }`. Each
certificate is `{ position, line, offset, subject, issuer, sans, serial, validity:
{ notBefore, notAfter, daysLeft, status }, key: { type, bits, curve },
signatureAlgorithm: { name, oid }, selfSigned, basicConstraints: { ca, pathLength },
keyUsage, extendedKeyUsage, fingerprints: { sha1, sha256 } }`. `position` counts
every block in a PEM bundle (or element in a DER one) from 1, `line` is where a PEM
block starts and `offset` where a DER certificate does. `status` is `valid`,
`expired` or `not-yet-valid`, and `daysLeft` is negative once expired.
`basicConstraints`, `keyUsage` and `extendedKeyUsage` are null when the certificate
doesn't have that extension.

What it checks, in `data.verified` (a failure also warns under its code):

| Check | Means | Fails with |
|-------|-------|------------|
| `bundle.readable` | Every block meant to be a certificate decodes | `CERT_UNREADABLE` |
| `decode.matchesNode` | toil's DER reader and `node:crypto` agree on the serial and CA flag, and nothing follows the certificate in its block | `CERT_DECODE_MISMATCH` |
| `validity.notExpired`, `validity.started` | Each certificate is inside its validity window now | `CERT_EXPIRED`, `CERT_NOT_YET_VALID` |
| `chain.order` | Each certificate's issuer is the next one's subject | `CERT_CHAIN_ORDER` |
| `chain.signature` | Where the names match, each signature verifies with the next certificate's key, and a self-issued last certificate with its own | `CERT_SIGNATURE_MISMATCH` |
| `chain.root` | Unchecked (`UNVERIFIED`) when the last certificate isn't self-signed, so its issuer doesn't follow it: the chain is checked only as far as the bundle goes | |
| `host.covered` | With `--host`, a DNS or IP SAN of the first certificate covers it | `CERT_HOST_MISMATCH` |
| `input.complete` | The whole file was read (unchecked for stdin) | `INPUT_INCOMPLETE` |

- The chain is checked in the order given, leaf first. When it's out of order but
  is one chain in another order, `chain.suggestedOrder` lists the positions in the
  right order and `CERT_CHAIN_REORDER` says so.
- `chain.inOrder` is true when every link's names match and every signature
  checked verifies. `chain.root` is `included` when the last certificate is
  self-signed. Nothing is checked against a trust store: a chain that verifies to
  a root in the bundle isn't thereby trusted.
- `--host` follows what browsers do: SANs only, never the subject CN, and a
  wildcard covers exactly one label (`*.imagile.dev` covers `api.imagile.dev`, not
  `imagile.dev` or `a.api.imagile.dev`). `host.explanation` says why it's covered
  or not.
- A PEM block that isn't a certificate is skipped, listed in `skipped` and named in
  a `CERT_BLOCK_SKIPPED` warning. A private key is never read, and
  `CERT_PRIVATE_KEY_IN_INPUT` says one was there. `CERTIFICATE` and
  `X509 CERTIFICATE` blocks are read; `TRUSTED CERTIFICATE`, PKCS#7 (`.p7b`) and
  PKCS#12 (`.pfx`) are not.
- In DER input a damaged certificate ends the reading, since nothing says where the
  next one starts; it's reported at its byte offset.
- Input with no certificate that can be read fails with `INVALID_INPUT`, naming
  each block and why.

### `toil util semver`

Versions and ranges in the grammar of the ecosystem they come from. Pick it with
`--ecosystem`: `npm` (the default), `nuget` or `maven`.

- **npm:** SemVer 2.0.0 versions (`1.2.3`, `1.2.3-rc.1+build.5`; a leading `v` is
  allowed) and npm's ranges, as `package.json` takes them: `^1.2.3`, `~1.2`, `1.x`, `>=1.0.0 <2.0.0`,
  `1.0.0 - 2.0.0`, joined with `||`. A prerelease satisfies a range only when the
  range names a prerelease of the same `major.minor.patch`, unless you pass
  `--include-prerelease`. There's no loose mode that turns text that isn't a
  version into one.
- **nuget:** one to four numbers (`1`, `1.0` and `1.0.0.0` are one version), then
  an optional `-prerelease` and `+metadata`. Labels compare case-insensitively.
  Ranges are interval notation: `1.0` (at least 1.0), `[1.0]`, `[1.0,2.0)`,
  `(,2.0]`. A prerelease inside the bounds satisfies the range. Floating versions
  (`1.*`, `1.0.0-*`) are refused, because what one picks depends on the feed.
- **maven:** Maven's own ordering: `alpha < beta < milestone < rc < snapshot <
  release < sp`, `1`, `1.0` and `1.0.0.Final` are one version, and `1a1` is
  `1-alpha-1`. A version is letters, digits, `.`, `-`, `_` and `+` with at least
  one digit, so an unresolved `${property}` is reported, not ordered. Ranges are
  `[1.0,2.0)`, `[1.0]` and `(,1.0],[1.2,)`. A bare version is a soft requirement
  that any version satisfies, and says so in a `MAVEN_SOFT_REQUIREMENT` warning.

A version or range that doesn't parse in the chosen grammar is `INVALID_INPUT`,
with the reason and an example of what fits. Build metadata never affects order.

```bash
toil util semver compare 1.0.0-rc.10 1.0.0-rc.9
toil util semver satisfies 1.3.0-rc.1 '^1.2.0' --include-prerelease
toil util semver satisfies 5.3.39 '[5.0,6.0)' --ecosystem maven
toil util semver sort versions.txt --range '^5.0.0'
toil util semver bump 1.2.3 prerelease --preid rc
```

| Command | Arguments and flags | Output |
|---------|---------------------|--------|
| `compare <a> <b>` | `--ecosystem <ecosystem>` | `{ ecosystem, a, b, order, higher, difference, normalized: { a, b }, verified }`. `order` is -1, 0 or 1 for a against b, `higher` is `a`, `b` or null, and `difference` is the most significant part they differ in: `major`, `minor`, `patch`, `revision` (NuGet's fourth part, or Maven's), `prerelease`, `qualifier` (Maven) or null |
| `satisfies <version> <range>` | `--ecosystem <ecosystem>`, `--include-prerelease` | `{ ecosystem, version, range, normalizedRange, satisfies, verified }` |
| `sort [file]` | `--text <text>`, `--ecosystem <ecosystem>`, `--range <range>`, `--include-prerelease` | `{ ecosystem, count, sorted, invalid, verified }`, lowest first, plus `{ range, normalizedRange, satisfying, highest }` with `--range` |
| `bump <version> <release>` | `--ecosystem <ecosystem>`, `--preid <id>` | `{ ecosystem, version, release, preid, result, verified }` |

- **`sort`** reads a file in the workspace, stdin (`-`, or no file), or `--text`.
  Versions go one per line or separated by spaces. An entry that doesn't parse is
  left out of the sort and listed in `invalid` with its line and the reason, with a
  `SEMVER_INVALID_VERSION` warning.
- **`bump`** takes `major`, `minor` or `patch` in every ecosystem. npm also takes
  `premajor`, `preminor`, `prepatch`, `prerelease` and `release`, the bumps npm
  publishes with, and `--preid` names the prerelease (`1.2.3` `prerelease --preid rc` is
  `1.2.4-rc.0`). A NuGet result has three parts, with the revision and labels
  dropped. Maven bumps the leading numbers and drops the qualifier
  (`1.2.3-SNAPSHOT` `minor` is `1.3.0`).

**What it checks** (`verified`, with failures as warnings):

- `sort.transitive`: every pair in the sorted list is in order, so a comparison
  where a < b and b < c but not a < c can't hide. Up to 2,000 versions; past that,
  each against its neighbour, reported as `APPROXIMATED`.
- `sort.antisymmetric`, `sort.complete`: each neighbouring pair compares the same
  both ways round, and every entry is either sorted or listed as invalid.
- `range.boundaries`, `range.answers`: each answer agrees with the range's
  intervals, worked out by comparison alone, at the range's boundary versions and
  at every version asked about. A range with no bounds (`*`) has none to test, and
  says so with `UNVERIFIED`.
- `compare.antisymmetric`, `diff.consistent`, `bump.increases`,
  `version.normalized`: b against a is the reverse of a against b, a difference is
  named exactly when the versions differ, a bump goes up, and a normalised version
  reads back as the same version.
- `input.complete`: the whole file was read. stdin has no size to compare with, so
  it's `UNVERIFIED`.

`diff` names the most significant part that changed, the same rule in every
ecosystem; it never answers `premajor` or the like.

### `toil util report`

One JSON summary of a report that CI or a scanner wrote: JUnit XML, TRX, SARIF
2.1.0, lcov or Cobertura. It reads the file and nothing else, and checks the report
against its own declared totals.

```bash
toil util report target/surefire-reports/TEST-dev.imagile.OrderTest.xml
toil util report TestResults/build.trx
toil util report coverage/lcov.info --lowest 5
toil util report results.sarif
cat coverage.xml | toil util report --format cobertura
```

| Argument / flag | Meaning |
|-----------------|---------|
| `[file]` | The report, inside the workspace. `-`, or no file and no `--text`, reads stdin |
| `--text <text>` | The report itself, instead of a file |
| `--format <format>` | `junit`, `trx`, `sarif`, `lcov` or `cobertura`. Left out, it's detected from the content: the root element for XML (`<testsuites>` or `<testsuite>`, `<TestRun>`, `<coverage>`), `"runs"` for SARIF, a first `TN:` or `SF:` line for lcov |
| `--lowest <n>` | How many of the lowest-covered files to list (default 10, up to 1000) |

Over MCP the tool is `util_report`, with `file` or `text`, `format` and `lowest`.

Output: `{ format, formatFrom, tests, findings, coverage, skipped, verified }`.
`formatFrom` is `content` or `flag`. One of `tests`, `findings` and `coverage` is
filled in, by format, and the other two are `null`.

- **`tests`** (JUnit, TRX): `{ suites, totals: { tests, passed, failures, errors,
  skipped, flaky, other }, failures: [{ suite, name, className, kind, type,
  message, file, line, location, stack, stackLines }] }`. The totals are recounted
  from the cases, never copied from the report. `kind` is `failure` or `error`.
  `stack` is the first 15 lines, and `stackLines` how many there were. `location` is
  `report` when the report states `file` or `line`, and `stack` when they were read
  from the first stack frame naming the test's class or method (an `APPROXIMATED`
  warning says how many). It's `null` when neither has one.
- **`findings`** (SARIF): `{ runs: [{ tool, version, results }], total, byLevel,
  results: [{ tool, rule, level, kind, file, line, message, suppressed }] }`. `level`
  follows the spec: the result's own, else its rule's default, else `warning` for a
  failing result and `none` for any other. `file` is the first location's URI as
  written, and `line` its `startLine`.
- **`coverage`** (lcov, Cobertura): `{ sources, totals: { lines, branches }, files:
  [{ file, lines, branches }], lowest }`. Each figure is `{ covered, total, percent }`,
  with `percent` rounded to two places (`null` when there's nothing to cover).
  `branches` is `null` where the report has no branch data. `lowest` lists the
  `--lowest` files with the lowest line coverage, leaving out files with no lines.
- **`skipped`**: `{ count, elements: [{ element, count, reason }] }`, every element
  (or lcov record) the reader met and didn't read, also warned as
  `REPORT_ELEMENTS_SKIPPED`. Known parts that hold nothing it summarises
  (`system-out`, `properties`, TRX's settings and lists, Cobertura's per-method copies
  of the lines) aren't counted.

What `verified` checks:

| Format | Check | Warning when it fails |
|--------|-------|-----------------------|
| JUnit | Each suite's (and `<testsuites>`') declared `tests`, `failures`, `errors` and `skipped`, recounted from its cases, nested suites included | `REPORT_TOTALS_MISMATCH`, naming both numbers |
| TRX | `<Counters>`' `total` and each outcome counter, recounted from the results' `outcome` | `REPORT_TOTALS_MISMATCH` |
| Cobertura | Every stated `line-rate` and `branch-rate` (class, package and root), to within one unit of its last written decimal, and the root's `lines-covered`, `lines-valid`, `branches-covered` and `branches-valid` | `REPORT_COVERAGE_MISMATCH` |
| lcov | Each record's `LF`, `LH`, `BRF`, `BRH`, `FNF` and `FNH`, recounted from its `DA`, `BRDA`, `FN` and `FNDA` lines | `REPORT_COVERAGE_MISMATCH` |
| SARIF | Each `ruleIndex` points at the rule its `ruleId` names | `REPORT_SARIF_INCONSISTENT` |
| All | The whole input was read (`input.complete`) | `INPUT_INCOMPLETE`, or `INPUT_TRUNCATED` at the cap |

What it can't check is reported as `UNVERIFIED`, never as passed: a JUnit report
that declares no totals, SARIF (which declares none), a TRX counter left at `0` over
results with that outcome (VSTest leaves `notExecuted` at 0, for one), and the size
of stdin. TRX's `executed` isn't compared, because writers disagree on what it
counts.

Formats it reads:

- **JUnit:** Maven Surefire's, the Jenkins shape (nested `<testsuite>`s, `status`,
  `assertions`, `disabled`) and the Azure DevOps shape (the VSTest JUnit logger's).
  Surefire's `flakyFailure` and `flakyError` mean a rerun passed: the case counts as
  passed and in `flaky`. A case with `<error>` is an error, else one with
  `<failure>` is a failure, else one with `<skipped>` is skipped.
- **TRX:** `dotnet test --logger trx` and Visual Studio's. Top-level results are
  counted, as the counters count them, and a data-driven test's inner rows aren't.
  `failures` is `Failed`; `errors` is `Error`, `Timeout` and `Aborted`; `skipped` is
  `NotExecuted` and `NotRunnable`; any other outcome is `other`. `suites` is the
  number of test classes, and a failure's `suite` is its class.
- **SARIF 2.1.0:** any tool's. A rule reference with a `toolComponent` index is
  looked up in that entry of `tool.extensions` (CodeQL query packs); one that names
  its component only by `guid` can't be found, so `sarif.ruleIndex` is `UNVERIFIED`
  and the level falls back to `warning`. A file with another `version` is read as
  2.1.0, with an `APPROXIMATED` warning. A run whose invocation says it failed warns
  `REPORT_TOOL_FAILED`.
- **lcov:** `SF` to `end_of_record` records, including lcov 2's `FNL` and `FNA`.
  `FNH` is recounted as distinct functions hit: `FNA` by index, so a function's
  aliases count once, and `FNDA` by name. A file in several records is merged, and a
  line is covered when any record hit it.
- **Cobertura:** coverlet's, coverage.py's and others'. Classes in the same file are
  added together, and branch counts come from `condition-coverage="50% (1/2)"`.

Limits: XML and lcov stream, so memory stays flat for a report of any size, apart
from the failures it lists, up to the 64 MiB input cap. At the cap the read stops,
`INPUT_TRUNCATED` says so, `input.complete` fails, and what came before the cut is
summarised; a suite the cut left open isn't compared. SARIF is JSON and is read
whole, so a SARIF file over the cap is `INVALID_INPUT`. Malformed XML or JSON is
`INVALID_INPUT` with the line and column. So is a document whose format can't be
detected, or whose root doesn't match `--format`, with a fix naming `--format`.

### `toil util log`

Triages a large log (a CI console, a Maven, npm or dotnet build, a test run) into
what's worth reading: its error and warning lines grouped by signature, each with the
stack trace that follows it. It reads the file only, streams it, and holds memory
constant however large the log is.

```bash
toil util log build.log
toil util log console.log --level error --context 3
toil util log console.log --since 2026-10-14T09:12:00Z --grep 'Failed to execute'
some-build 2>&1 | toil util log -
```

| Argument or flag | Meaning |
|------------------|---------|
| `[file]` | The log, inside the workspace. `-`, or no file and no `--text`, reads stdin |
| `--text <text>` | The log itself, instead of a file |
| `--since <timestamp>` | Only lines dated at or after this ISO 8601 time (`2026-10-14`, `2026-10-14T09:12:00Z`, `"2026-10-14 09:12:00"`). A line with no date takes the date of the last dated line before it. Without a zone, a time is read as UTC |
| `--level <level>` | `warning` (default) reports errors and warnings; `error` reports errors only |
| `--grep <regex>` | Only error and warning lines matching this JavaScript regular expression (case-sensitive, no slashes or flags). An error also matches when the exception line heading its trace does (`--grep IllegalStateException`). Frames aren't searched; `LOG_GREP_STACK_ONLY` says when only they matched |
| `--max-groups <n>` | The most groups to return, default 50, up to 1000 |
| `--context <n>` | Lines to show before and after each group's sample, default 0, up to 20 |

Over MCP the tool is `util_log`, with `file` (a path in the workspace) or `text`, and
the same fields: `since`, `level`, `grep`, `maxGroups`, `context`.

How it reads a log:

- **Timestamps:** a leading timestamp, bracketed (Jenkins' timestamper) or bare (CI
  runners, log4j, Serilog), is set aside before anything else, so it never splits a
  group.
- **Levels:** the first level word decides (`ERROR`, `FATAL`, `SEVERE`, `WARN`,
  `WARNING`, `INFO`, `DEBUG` …, and npm's `npm error` / `npm warn`). A line tagged
  `INFO`, or with no tag, is still an error by its shape: `BUILD FAILURE`, `FAILED`,
  `error CS0246:`, `error TS2322:`, `TypeError: …`, `Unhandled exception.`, an eslint
  or vstest failure line. A tag with nothing after it (`[ERROR] `) is not a group.
- **Signatures:** dates and times, UUIDs, hex and every number are replaced, and
  spaces collapsed. Codes such as `CS0246` and `TS2322` keep their digits, and paths
  and quoted names stay, so two different errors stay apart.
- **Stack traces:** Java (`at …(File.java:12)`, `Caused by:`, `... 14 more`), .NET
  (`at … in file:line 9`, `--->`, `--- End of inner exception stack trace ---`), Node
  (`at fn (file:12:3)`) and Python (`Traceback (most recent call last):`, printed
  before its exception) are joined to the error they belong to, with the exception
  line that heads one. An exception line joins an error, never a warning: after a
  warning it's an error of its own. A trace is reported for each group's first occurrence, up to
  50 lines.

Output:

```json
{
  "lines": { "total": 76, "error": 20, "warning": 5, "other": 35, "stack": 12, "unclassified": 4 },
  "matched": 25, "filtered": 0, "groupsTotal": 18, "truncated": false, "ungrouped": 0, "unjoinedFrames": 0,
  "groups": [{
    "level": "error",
    "signature": "[ERROR] /build/ledger/Reconciler.java:[<n>] cannot find symbol",
    "count": 4, "firstLine": 27, "lastLine": 52,
    "sample": "[ERROR] /build/ledger/Reconciler.java:[54,38] cannot find symbol",
    "trace": { "kind": "java", "firstLine": 57, "lastLine": 68, "frames": 12, "lines": ["…"] },
    "context": { "before": [{ "line": 26, "text": "…" }], "after": [{ "line": 28, "text": "…" }] }
  }],
  "verified": { "passed": true, "checks": [{ "check": "lines.reread", "status": "passed", "checked": 36, "failed": 0 }] }
}
```

Groups are errors first, then warnings, each in order of first appearance. `lines`
classes every line once: `other` is a level below warning, `stack` a trace line, and
`unclassified` a line with no level at all. `filtered` counts the error and warning
lines `--since`, `--level` or `--grep` left out.

It checks its own answer, in `data.verified`:

- **`lines.reread`:** every group's first line is read again from the file and must
  be its sample, and its last line must still have its signature. `trace.reread`
  does the same for every trace line shown. A mismatch is `LOG_LINE_MISMATCH`, which
  usually means the file changed while it was read.
- **`groups.sum`, `lines.sum`, `filter.sum`:** the group counts add up to the matched
  lines, the line classes to the lines read, and matched plus filtered to the error
  and warning lines. A mismatch is `LOG_COUNT_MISMATCH`.
- **`input.complete`:** the bytes read equal the file's size. It's `unchecked` for
  stdin and text.

What it reports in `meta.warnings` rather than leave out: `LOG_UNCLASSIFIED` (lines
with no level, in no group), `LOG_GROUPS_TRUNCATED` (more groups than
`--max-groups`), `LOG_UNGROUPED` (matched lines whose signature came after the first
2,000 distinct ones, counted but not grouped, which is what keeps memory constant),
`LOG_TRACE_UNJOINED` (trace lines with no error before them), `LOG_GREP_STACK_ONLY`
(`--grep` matched only stack trace lines), `LOG_SINCE_UNDATED`
(lines `--since` couldn't date, kept), and `APPROXIMATED` for a line longer than
4,096 characters (grouped by its start) or a `--since` compared with times that had
no zone.

A file streams with no size limit. stdin and `--text` are held in memory, up to
64 MiB, so pass a file for anything bigger.

`--grep` runs in a worker thread, a batch of up to 4,096 lines at a time, each batch
with 2 seconds and 256 MB. A pattern that backtracks without end on some line, such as
`(a+)+b`, fails the command with `TIMEOUT` naming the lines, rather than holding it.

### `toil util size`

How big a file or folder is before you read it, so an agent can budget its
context: bytes, lines and an estimated token count, and for one file an outline
with line ranges, so you can read just the part you need.

```bash
toil util size src/areas/util/size.ts
toil util size src --depth 2 --top 5
git show HEAD:README.md | toil util size - --language markdown
```

| Argument / flag | Meaning |
|-----------------|---------|
| `[file]` | A file or folder inside the workspace. `-` (or nothing) reads stdin |
| `--text <text>` | The content itself, instead of a file |
| `--language <language>` | Outline it as this language: `typescript`, `javascript`, `python`, `csharp`, `java`, `go`, `markdown`, `json` or `yaml`. Needed for stdin and `--text`; for a file it overrides the extension |
| `--top <n>` | For a folder: how many of the largest files to list (default 10) |
| `--depth <n>` | For a folder: how many levels of subfolders the tree shows (default 3). Deeper folders still count in their parent's totals, and `foldersHidden` says how many were left out |

**Tokens are an estimate**: `ceil(characters / 4)` per file, counting Unicode code
points. No model's tokenizer is bundled, and real counts vary by model and
content. Every result says so in `tokenMethod` and with an `APPROXIMATED` warning.

**For a file**: `{ kind: "file", path, language, bytes, lines, tokens, tokenMethod,
outline, notOutlined, verified }`. `outline` is `{ precision, method, symbols }`
(code adds `imports` and `importsMethod`), each symbol `{ name, kind, startLine, endLine, container }` (headings add `level`):

- **Code** (`precision: "syntactic"`): TypeScript and JavaScript (`.ts`, `.tsx`,
  `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`), Python, C#, Java and Go. Functions,
  classes, interfaces, types, enums, namespaces, methods, constructors, C#
  properties and exported names. It's a pure-JavaScript scan that skips comments
  and strings and matches braces (indentation for Python), not a compiler, so
  `method` says what each language covers. Function bodies aren't searched, and
  fields aren't listed. `container` is the enclosing class or namespace.
- **Imports** (code files, one file only; a folder's listing doesn't read each
  file's imports): `outline.imports` lists the modules the file names, found
  from the same tokens as the outline, so an import in a string or comment never
  counts. Each is `{ specifier, kind, line }`, plus `names`, `alias` or `modifiers`
  where the syntax says so. The `specifier` is exactly as written (`./foo`,
  `node:fs`, `java.util.List`, `System.Text`, `..pkg`) and `line` is the line it's
  written on. `kind` is `import`, `require`, `dynamic` (`import('…')` with a literal),
  `from` (`export … from`, Python's `from … import`) or `using` (C#). `names` are
  `default`, `*` or each name as the module exports it, not its local alias; a
  Python `import a, b` is one entry per module. C# `using (…)` and `using var`
  statements aren't imports. **Nothing is resolved**: no file lookup, no path,
  package or tsconfig resolution, so `./foo` doesn't say which file it is, and a
  `require(name)` with no literal isn't listed. A file with none has `imports: []`.
  At most 2,000 are listed; a `SIZE_IMPORTS_TRUNCATED` warning says when more were
  found. `precision` is `syntactic`, like the outline.

  ```json
  "imports": [
    { "specifier": "node:fs", "kind": "import", "line": 1, "names": ["default"] },
    { "specifier": "./lexer.js", "kind": "import", "line": 2, "names": ["lex", "OutlineError"] },
    { "specifier": "./legacy", "kind": "require", "line": 9 }
  ]
  ```
- **Markdown**: ATX and setext headings, outside code fences and front matter.
- **JSON and YAML** (`precision: "parsed"`): the top-level keys, found by scanning
  and held against what the parser returns.

When there's no outline, `outline` is null and `notOutlined` says why: `binary` (a
NUL byte in the first 8,000 bytes; lines and tokens are null too),
`unsupported-language`, `parse-error` (with the line, never the text, or that it
nests too deep to outline; also a `SIZE_PARSE_ERROR` warning) or `too-large` (over
8 MiB; it's still counted).

The outline is made in a worker thread with 10 seconds and 512 MB; a file at the
8 MiB limit takes under 2 seconds. Past either, the command fails with `TIMEOUT` or
`INVALID_INPUT` naming the file and the limit.

**For a folder**: `{ kind: "folder", path, tokenMethod, totals, tree, largest,
skipped, verified }`. It lists files the way `deps scan` does, skipping what
`.gitignore` ignores. `totals` and every `tree` node hold `files`, `bytes`, `lines`,
`tokens` and `binaryFiles`; binary files count in files and bytes only. Folders are
sorted largest first. `largest` names the biggest files with their language.
`skipped` lists what wasn't counted, with the reason: `unreadable` (with a
`SIZE_FILES_SKIPPED` warning), `not-a-file` or `nested-repository`.

**What it checks**, in `data.verified`:

- `outline.start`: each symbol's start line, re-read from the input, names it.
- `outline.range` and `outline.nesting`: each range is inside the file and in
  order, and a member sits inside its container.
- `outline.keys`: JSON and YAML keys match the parser's.
- `imports.line` and `imports.range`: each import's line, re-read from the input,
  holds its specifier as written (spaces ignored), and is inside the file.
- `counts.reread`: the outline's full read gives the same bytes and lines.
- `totals.sum` and `tree.sum`: the totals equal the files added up, and each
  folder equals its own files plus its subfolders.
- `input.complete`: every file was read to its size on disk.

A failed check sets `verified.passed` to false and warns `SIZE_OUTLINE_MISMATCH`,
`SIZE_TOTALS_MISMATCH` or `SIZE_COUNTS_MISMATCH`.

### Time: `toil util time`

Date and time arithmetic on the time zone data Node ships (IANA, through `Intl`);
toil bundles no zone database of its own, and nothing reads the network. Each
command checks its own answer a second way and reports the checks in
`data.verified` (`{ passed, checks }`), with anything it couldn't check or had to
approximate in `meta.warnings` as `UNVERIFIED` or `APPROXIMATED`.

Times are ISO 8601: a date (`2026-03-08`), a wall clock (`2026-03-08T02:30`), or an
instant with `Z` or an offset (`2026-03-08T07:30:00Z`, `2026-03-08T02:30:00-05:00`).
`@1760000000` is epoch seconds, and `now` is the current time, read once per call.
Fields out of range (`2026-02-29`, `24:00`, a leap second) are `INVALID_INPUT`,
never rolled over. Digits below a millisecond are dropped with an `APPROXIMATED`
warning. Zones are IANA names (`America/New_York`); an unknown one is
`INVALID_INPUT`.

**DST.** A wall clock a zone skipped (spring forward) or showed twice (fall back) is
always reported, in `data` as a `dst` object and in `meta.warnings` as
`TIME_DST_GAP` or `TIME_DST_OVERLAP`. A gap is read as the time the clocks showed
after the jump (02:30 becomes 03:30) and an overlap as the earlier of the two. Give
the time an offset to choose otherwise.

#### `toil util time convert`

```bash
toil util time convert 2026-03-08T02:30 --zone America/New_York --to UTC --to Europe/London
toil util time convert now --to Asia/Kolkata
```

| Argument or flag | Meaning |
|------------------|---------|
| `<time>` | The time to convert |
| `--zone <zone>` | The zone of a time written without an offset. Required for one; refused for a time that has an offset |
| `--to <zone>` | A zone to convert to (repeatable; default `UTC`) |

Output: `{ input, instant, epochMs, source: { kind, zone, offset, dst? }, results:
[{ zone, local, offset, offsetSeconds, dst? }], verified }`. `local` is the time in
that zone with its offset. Checks: each result reads back as the same instant
(`convert.roundtrip`), the zone shows that wall clock then (`convert.zone`), and a
wall-clock input is what its zone shows at the instant found (`convert.source`). A
failure warns `TIME_ROUNDTRIP_MISMATCH`.

#### `toil util time duration`

```bash
toil util time duration P1DT2H30M
toil util time duration --seconds 93784.5
```

| Argument or flag | Meaning |
|------------------|---------|
| `<duration>` | An ISO 8601 duration to read: `PT1H30M`, `P1Y2M10DT2H`, `PT0.5S`, `-PT15M`. Only the last part may have a fraction |
| `--seconds <seconds>` | Instead, a number of seconds to write as a duration |

Output: `{ input, iso, negative, parts: { years, months, weeks, days, hours,
minutes, seconds }, totalSeconds, text, verified }`. `iso` is the canonical text.
Seconds are written in hours, minutes and seconds only (`PT26H3M4.5S`), since a day
isn't always 24 hours. Years and months have no fixed length, so `totalSeconds` is
`null` with an `UNVERIFIED` warning; days and weeks count as 24 hours and 7 days,
with an `APPROXIMATED` warning. Check: the canonical text reads back as the same
parts (`duration.roundtrip`, warning `DURATION_ROUNDTRIP_MISMATCH`).

#### `toil util time business-days add` and `diff`

```bash
toil util time business-days add 2026-12-23 3 --holidays holidays-2026.txt
toil util time business-days add 2026-12-28 -1
toil util time business-days diff 2026-12-24T15:00 2026-12-29T10:00 --zone America/Chicago --holiday 2026-12-25
```

| Argument or flag | Meaning |
|------------------|---------|
| `<start>` | The start time or date |
| `<days>` | `add`: business days to add; negative subtracts |
| `<end>` | `diff`: the end time or date |
| `--zone <zone>` | The zone whose calendar days count, and the zone of a time without an offset (default `UTC`) |
| `--holidays <file>` | A file in the workspace: one `YYYY-MM-DD` per line, optionally followed by a name; `#` lines are comments. Any other line is `INVALID_INPUT` naming it |
| `--holiday <date>` | A holiday as `YYYY-MM-DD` (repeatable) |

Business days are Monday to Friday, less the holidays given. No country's holidays
are built in: list the dates the office is actually shut (the observed Friday, not
the Saturday it stands in for).

`add` counts as a spreadsheet's `WORKDAY` does: the start never counts, each step
lands on the next business day, and `0` returns the start unchanged. A time of day
is kept, and a result in a DST gap or overlap is warned about. Output: `{ start,
days, zone, result, weekday, skipped: { weekendDays, holidays }, holidaysListed,
dst?, verified }`. Checks: the business days between start and result, counted
again day by day, number `days` (`business.count`); the result is a business day
(`business.landing`); and it's on the right side of the start
(`business.direction`). A failure warns `BUSINESS_DAYS_MISMATCH`.

`diff` measures the time between two times that falls on business days in the
zone. A date means midnight. Output: `{ start, end, zone, negative, businessDays,
hours, duration, totalBusinessSeconds, elapsedSeconds, holidays, verified }`:
`businessDays` is whole 24-hour days of business time, `hours` what's left over,
and `duration` the same, exactly (`PT43H`). DST days count as the 23 or 25 hours
they are. Checks: business time plus the rest adds up to the elapsed time
(`business.partition`), and the days and hours make the business time
(`business.total`), warning `BUSINESS_TIME_MISMATCH`.

#### `toil util time cron`

```bash
toil util time cron "*/15 9-17 * * 1-5" --zone Europe/London --count 10
toil util time cron "0 0 12 ? * MON#2" --dialect quartz
toil util time cron "H H(0-7) * * 1-5" --dialect jenkins --job platform/api-build
```

| Argument or flag | Meaning |
|------------------|---------|
| `<expression>` | The cron expression, quoted |
| `--dialect <dialect>` | `standard`, `quartz` or `jenkins` (default: detected: 6 or 7 fields is `quartz`, an `H` is `jenkins`, otherwise `standard`) |
| `--zone <zone>` | The zone the schedule runs in (default `UTC`) |
| `--from <time>` | List runs after this time (default `now`) |
| `--count <n>` | How many run times to list, 1 to 100 (default 5) |
| `--job <name>` | The Jenkins job's full name (`folder/job`), which `H` is hashed from. Required when the expression uses `H` |

The dialects:

- **standard**: five fields, minute hour day-of-month month day-of-week, as the classic
  crontab reads them. Names (`JAN`, `MON`), ranges, lists and steps (`*/15`,
  `1-30/5`, `5/15`); day-of-week 0 to 7, with 0 and 7 both Sunday. Macros `@yearly`,
  `@annually`, `@monthly`, `@weekly`, `@daily`, `@midnight` and `@hourly`; `@reboot`
  is refused, since it has no times. When neither day field starts with `*`, a day
  matching **either** runs. A detected standard expression with both day fields set
  warns `CRON_DIALECT_ASSUMED`, since Jenkins reads it differently.
- **quartz**: six or seven fields, second first and an optional year (1970 to 2099)
  last. Day-of-week is 1 to 7 from Sunday. One of the day fields must be `?`.
  Day-of-month takes `L`, `L-3`, `15W` (the weekday nearest the 15th, inside the
  month) and `LW`; day-of-week takes `6L` (the last Friday) and `6#3` (the third
  Friday). A backwards range wraps (`FRI-MON`, `22-2`).
- **jenkins**: five fields like standard, plus `H`, `H(0-7)` and `H/15`, placed as
  Jenkins places them from the job's full name. An unbounded `H` in day-of-month
  stays within 1 to 28. Both day fields must match. The macros use `H` (`@daily` is
  `H H * * *`, `@midnight` is `H H(0-2) * * *`), so pass `--dialect jenkins` for a
  Jenkins macro: a bare macro is detected as standard.

Output: `{ expression, dialect, dialectSource, zone, from, explanation, fields,
runs: [{ instant, local, offset, dst? }], skipped, skippedTotal, verified }`. `fields` holds what
each field expanded to, with day-of-week 0 for Sunday in every dialect.

DST: a run time the zone skipped isn't listed as a run; it's in `skipped`, with a
`CRON_DST_GAP` warning giving the total. `skipped` lists the first 100 and
`skippedTotal` counts them all. The walk stops after 5,000 skipped run times (more
than one every-second gap hour), warning `CRON_SEARCH_STOPPED` with the last one
reached, so a schedule that only lands in gaps (`* * 2 ? 3 1#2` in New York) answers
at once; pass a later `--from` to look further. A run time that happened twice is listed once, at the first,
with a `dst` object and a `CRON_DST_OVERLAP` warning. Schedulers differ on both, so
check yours. Fewer runs than `--count` in the next 100 years (or in Quartz's listed
years) warns `CRON_FEW_RUNS`; `0 0 30 2 *` never runs.

Checks: each run, read back as the wall clock its zone shows then, matches every
field again (`cron.rematch`); the runs come after `--from` and in order
(`cron.order`); `local` is the same instant (`cron.local`); and each skipped time
really is in a gap (`cron.gap`). A failure warns `CRON_RUN_MISMATCH`. The
explanation's wording isn't checked, and says so (`UNVERIFIED`): it's built from the
same fields the run times come from, and the run times are what's checked.

### `toil util md`

Converts a document between Markdown and the rich-text formats the Atlassian
areas send: Jira wiki markup (Jira Data Center), Atlassian Document Format
(Jira Cloud, Confluence Cloud) and Confluence storage format (Confluence Data
Center). One side is always Markdown. Every result is checked by converting it
back, so you're told exactly what didn't survive.

```bash
toil util md description.md --to wiki
toil util md page.md --to storage
toil util md description.md --to adf --select output
toil util md PROJ-142.wiki --from wiki
toil util md description.adf.json --from adf
```

ADF input is the document itself, `{ "type": "doc", "version": 1, "content": [...] }`:
an issue's `fields.description` or a comment's `body`, not the issue around it.

| Argument / flag | Meaning |
|-----------------|---------|
| `[file]` | A file inside the workspace. `-`, or no file and no `--text`, reads stdin |
| `--text <text>` | The document itself, instead of a file |
| `--to <format>` | `wiki`, `adf` or `storage`, to convert Markdown into it |
| `--from <format>` | `wiki`, `adf` or `storage`, to convert it into Markdown |

Over MCP the tool is `util_md`, with `file` or `text` plus `from` or `to`.

Output:

```json
{
  "from": "md",
  "to": "wiki",
  "output": "h2. Steps\n\n# Open the login page\n...",
  "lossless": false,
  "losses": [{ "construct": "task list", "at": "line 12", "detail": "Jira wiki markup has no task lists; each task is written as [ ] or [x] text" }],
  "roundTrip": { "blocks": 9, "differences": [] },
  "verified": { "passed": true, "checks": [{ "check": "roundTrip.blocks", "status": "passed", "checked": 9, "failed": 0 }] }
}
```

- **`output`** is the converted document: an ADF document object for `adf`,
  text for the others. Markdown output is in one canonical spelling (`-` bullets,
  `*emphasis*`, `**strong**`, fenced code, one line per paragraph).
- **`losses`** lists every construct that has no equivalent in the target, with
  its position: `line N` in Markdown, wiki markup and storage format, a JSON
  pointer (`/content/6/content/2`) in ADF. Each kind is also an `MD_LOSSY`
  warning. Words are kept wherever there are words to keep: a panel becomes a
  quote, a mention becomes `@name` text, a merged cell is unmerged with the cells
  it covered left empty.
- **`roundTrip`**: the output is read back and compared with the input, block by
  block, as canonical Markdown. `differences` shows each block that changed, and
  whether a loss explains it. A change no loss explains fails the
  `roundTrip.blocks` check and warns `MD_ROUNDTRIP_MISMATCH`: that's a bug in the
  converter, so check the output before you send it.
- **`lossless`** is true only when nothing was lost and every block came back the same.
- **ADF output is validated against the ADF JSON schema** (Atlassian's
  `@atlaskit/adf-schema`, bundled) before it's returned, and storage output is
  read back as XML. Output that fails either is never returned; the command fails
  instead. ADF input the schema refuses is converted as far as it reads, with an
  `ADF_INPUT_INVALID` warning.

Reading and writing run in a worker thread, the conversion and the read back each
with 10 seconds and 1,024 MB; a 4 MiB document, the input limit, takes under
4 seconds. A document whose emphasis or brackets would take far longer, or that
nests past the stack, fails with `TIMEOUT` or `INVALID_INPUT` naming the step and
the limit.

What Markdown means here: CommonMark plus GFM tables, task lists, strikethrough
and bare-URL links. Raw HTML (other than `<br>`), link reference definitions and
footnotes aren't read; they're kept as text and reported as losses.

Known losses, by format:

- **Wiki markup:** no task lists (written as `[ ]` / `[x]` text), no table
  alignment, no link or image titles, lists always start at 1, and a list item is
  one line, so a code block or second paragraph in one is joined with line breaks.
  Underline, colour, sub/superscript, citations, panels, mentions, attachments and
  other macros don't come back into Markdown. Text such as `(y)` that Jira shows as
  an emoticon, and a URL written as text, which Jira links, are reported too.
- **ADF:** a quote can't hold a heading, table, task list or another quote, and a
  list item can't hold a heading, quote or table, so those are brought down and
  reported. Inline images become links; explicit left alignment is the default.
  Panels, expands, mentions, emoji, dates, statuses, smart links, decisions,
  attachments, layouts, extensions and merged cells don't come back.
- **Storage format:** a list mixing tasks and ordinary items becomes a task list.
  Info, note, tip and warning panels, expand, layouts, page and user links,
  attachments, emoticons, colour, merged cells and other macros don't come back.
  Only XML's entities and HTML's common named ones (`&nbsp;`, `&mdash;` and so on)
  are read; any other is refused with `INVALID_INPUT`, as is XML that isn't
  well-formed, with its line and column.

To send the result, pass it to the area's own command: wiki markup as
`toil jira issue create --description`, storage format as
`toil confluence page create --body` (on a Data Center or a Cloud connection), and ADF as
`fields.description` in a `toil jira issue create --input-file` on a Cloud connection. How each product's own renderer displays it hasn't
been checked against a live instance.
### `toil util openapi`: read an API description before calling it

Three commands that read an OpenAPI 3.0, 3.1 or 3.2 or Swagger 2.0 document, in JSON
or YAML, so you can call an endpoint right the first time, usually through
`toil <area> api`. The document is a file in the workspace, `-` for stdin, or
`--text` (`file` or `text` over MCP). Nothing is fetched: the official schemas
each version is checked against are bundled.

```bash
toil util openapi list jira-platform.json --tag Issues
toil util openapi list github.yaml --path pulls
toil util openapi show jira-platform.json --operation createIssue
toil util openapi show bitbucket.json --method POST --path /repositories/{workspace}/{repo_slug}/pullrequests --depth 1
toil util openapi example jira-platform.json --operation createIssue
toil util openapi example github.yaml --operation pulls/get --response 200
```

| Flag | Meaning |
|------|---------|
| `[file]` | The document: a file in the workspace, or `-` (or nothing) for stdin |
| `--text <text>` | The document itself, instead of a file |
| `--tag <tag>` | `list`: only operations with this tag (any case) |
| `--path <text>` | `list`: only operations whose path contains this text. `show` and `example`: the path exactly as the document writes it, with `--method` |
| `--operation <operationId>` | `show`, `example`: the operation, by its operationId |
| `--method <method>` | `show`, `example`: the method, with `--path`, for an operation with no operationId |
| `--depth <n>` | `show`: how many `$ref`s deep to expand schemas (default 3, at most 20) |
| `--response <status>` | `example`: build that response's body (`200`, `201`, `default`) instead of the request body |
| `--content-type <type>` | `example`: which of the body's content types (default: the first JSON one) |

In Git Bash on Windows, leave the leading `/` off `--path`
(`--path repos/{owner}/{repo}/pulls`): the shell rewrites `/repos/...` into a file
path. Both forms match.

- **`list`** returns `{ document, count, operations: [{ method, path, operationId,
  summary, tags, deprecated }] }`.
- **`show`** returns `{ document, operation, parameters, requestBody, responses,
  call, expansion }`. Each parameter has `name`, `in` (path, query, header, cookie),
  `required` and `schema`. The request body and each response have `contentTypes`,
  the `contentType` the `schema` is for (the first JSON one), and `schemaPointer`.
  Swagger 2.0's `body` and `formData` parameters come out as the request body, so
  both versions have one shape.
- **Expanded schemas:** `$ref`s are replaced by what they point at, `--depth` refs
  deep, and an expanded one says where it came from in `x-toil-ref`. One left in
  place says why in `x-toil-stop`: `depth`, `circular` (it loops back), `external`
  (another file or a URL) or `broken`. `expansion.stopped` counts each. Expansion
  builds at most 250,000 objects and arrays per call (`expansion.nodes`) and copies
  at most 4,000,000 characters of the document's text (`expansion.chars`), since refs
  can fan out and each copies its whole target (three properties each referring to
  the next, twenty deep, is 3^20 copies). Past that, the rest stay in place as
  `depth`, `expansion.truncated` is true and an `OPENAPI_EXPANSION_TRUNCATED` warning
  says so. `example` generates at most 250,000 values, no more array items than
  that leaves room for, strings of at most 10,000 characters each, and at most 1,000,000
  characters in all, a document's own `const` and `enum` values included (a
  `minLength` or a pattern's `{n}` past that is cut; any value past the total is null). A cut-short example fails `example.valid` with
  `OPENAPI_EXAMPLE_TRUNCATED` and isn't validated. In 3.0 and
  Swagger 2.0 a `$ref`'s sibling keys are dropped, as the spec says. From 3.1
  they're kept, over the target's keys.
- **`example`** returns `{ document, operation, body, status, contentType,
  schemaPointer, example }`. The example is the smallest body the schema accepts:
  required properties only (read-only ones left out of a request, write-only ones
  out of a response), the first enum value, the lowest number in range, a string in
  the right format with placeholder values (`you@example.com`, `api.imagile.dev`),
  the first branch of a `oneOf`. It's minimal, not complete: Jira's `createIssue`
  gives `{}`, because its schema requires nothing. Use `show` to see the fields you
  want to add.

#### Calling the endpoint with `<area> api`

`show`'s `call` is the operation as `<area> api` takes it: `method`, `path` (the
server's base path plus the operation's, with `{name}` for each of
`pathParameters`), `query` (each required query parameter as `name=<name>`),
`bodyFile`, `contentType` (set only when it isn't `application/json`), whether it
`writes`, and the CLI line. Over MCP the same fields are `<area>_api`'s inputs.

```bash
toil util openapi show jira-platform.json --operation editIssue --select call
# { "method": "PUT", "path": "/rest/api/2/issue/{issueIdOrKey}", "bodyFile": "body.json", "writes": true,
#   "cli": "toil <area> api PUT /rest/api/2/issue/{issueIdOrKey} --body-file body.json --allow-write", ... }
toil util openapi example jira-platform.json --operation editIssue --select example
toil jira api PUT /rest/api/2/issue/ABC-123 --body-file body.json --allow-write
```

Save the example as `body.json`, fill in the placeholders, and put the area the
document describes for `<area>`. The path is relative to the connection's
`baseUrl`: when `baseUrl` already ends with the server's base path (`/2.0` for
Bitbucket Cloud's), leave that part off. `call.unsupported` lists required header and
cookie parameters, which `<area> api` doesn't send. `call` is null for a method it
doesn't send (OPTIONS, TRACE, QUERY).

#### What every command checks

Each one reads the whole document and checks it before answering, and
`data.verified` says what it checked:

| Check | What it is | Warning when it fails |
|-------|------------|-----------------------|
| `document.schema` | The document against the official schema for its version (Swagger 2.0, OpenAPI 3.0, 3.1 or 3.2), bundled. Every problem is in `document.problems` by JSON pointer (`/paths/~1pets/get/responses`), at most 50, with `problemCount` | `OPENAPI_INVALID` |
| `refs.resolve` | Every local `$ref` points at something. Broken ones are in `document.refs.broken` as `{ at, ref }`, `at` being where the `$ref` sits | `OPENAPI_REF_BROKEN` |
| `operations.uniqueIds` | No operationId is used twice | `OPENAPI_DUPLICATE_OPERATION_ID` |
| `operations.pathParameters` | Every `{name}` in a path is declared as a path parameter | `OPENAPI_PATH_PARAMETER_MISSING` |
| `example.valid` | `example` only: the generated body validates against its own schema, `$ref`s and all, before it's returned | `OPENAPI_EXAMPLE_INVALID` |
| `input.complete` | The whole file was read | `INPUT_INCOMPLETE` |

An invalid document is still listed and shown, since real vendor documents aren't
always valid, but `verified.passed` is false. `document.refs.circular` lists each
loop of references (a recursive schema), which is legal; nothing follows one
forever. What can't be checked is reported, never assumed:

- Checking the document against its schema gets 15 seconds and 1,536 MB, enough for a
  vendor spec of 13 MB, which takes about 4 seconds. Validating an example, and
  running the document's own `pattern`s, each get 2 seconds and 256 MB.
  A document too big to finish, a schema that branches too much (a diamond of
  `anyOf`s), a pattern that backtracks without end (`^(a+)+$`), or a document too
  deep for the stack leaves `document.schema`, `example.valid` or `example.patterns`
  unchecked, with which limit it hit (`UNVERIFIED`). So does a Node run with
  `--permission` and no `--allow-worker`.
  A document nested more than 256 levels is refused (`INVALID_INPUT`).
- A YAML document is read in a worker thread with the same 15 seconds and 1,536 MB:
  YAML takes several times JSON's memory. Past either limit the command fails with
  `TIMEOUT` or `INVALID_INPUT` naming it; the same document as JSON reads in a fraction
  of both.
- A `$ref` to another file or a URL isn't followed (`refs.external`, `UNVERIFIED`),
  and an example whose schema reaches one isn't validated.
- The 3.1 and 3.2 schemas leave Schema Objects to the JSON Schema 2020-12 dialect,
  which isn't checked (`document.schemaObjects`, `UNVERIFIED`). Swagger 2.0 and 3.0
  documents are checked all the way down.
- Some schemas have no value that satisfies them (two `allOf` branches that
  disagree, a property required and forbidden at once). The example is returned
  anyway, with `example.valid` failed at the pointer that doesn't fit, so you fill
  that value in by hand.

A document that isn't an object, has no `openapi` or `swagger` field, declares a
version these commands don't read (OpenAPI 4, Swagger 1.2), or isn't valid JSON or
YAML fails with `INVALID_INPUT`. So does an operation that isn't there (the fix names
close operationIds), `example` on an operation with no request body (pass
`--response`), and a status or content type the operation doesn't list.

### `toil util c4 render`, `toil util c4 mermaid`, `toil util c4 d2`

One view of a C4 architecture model: `render` draws it as SVG, `mermaid` writes it
as Mermaid's C4 syntax (GitHub draws a ```` ```mermaid ```` block inline), and `d2`
writes it as D2 text. `render` lays the diagram out itself, with a layered layout
made for C4 views: people on the top row, the scope's children together inside
their dashed boundary, and each relationship's label placed clear of the boxes.
Nothing is installed or run, and nothing goes over the network.

```bash
toil util c4 render docs/c4/bookshop.c4.json --view containers --out containers.svg
toil util c4 mermaid docs/c4/bookshop.c4.json --view context
cat model.json | toil util c4 d2 - --view components
```

| Flag | Meaning |
|------|---------|
| `[file]` | A JSON file holding the model, inside the workspace, or `-` (or nothing) for stdin |
| `--text <text>` | The model itself, as a JSON string, instead of a file. Over MCP, `file` or `text` |
| `--view <key>` | The view to draw. It can be left out when the model has only one |
| `--out <file>` | `render` only: write the SVG to this new file inside the workspace instead of returning it. toil never overwrites a file |

The model:

```json
{
  "title": "Online bookshop",
  "people": [{ "id": "customer", "name": "Customer", "description": "Buys books" }],
  "systems": [{
    "id": "bookshop", "name": "Online Bookshop", "description": "Sells books at bookshop.imagile.dev",
    "containers": [
      { "id": "web", "name": "Web shop", "technology": "React",
        "components": [{ "id": "cart", "name": "Cart", "technology": "TypeScript" }] },
      { "id": "db", "name": "Database", "technology": "PostgreSQL", "database": true }
    ]
  }, { "id": "payments", "name": "Payment provider", "external": true }],
  "relationships": [{ "source": "customer", "destination": "web", "description": "Buys books using", "technology": "HTTPS" }],
  "views": [
    { "key": "context", "type": "systemContext", "scope": "bookshop" },
    { "key": "containers", "type": "container", "scope": "bookshop" },
    { "key": "components", "type": "component", "scope": "web", "include": ["*", "payments"] }
  ]
}
```

- **Elements** are people and software systems at the top, containers inside a
  system, and components inside a container. Each has an `id`, a `name`, and
  optionally a `description`, a `technology` (containers and components) and
  `external: true`, which draws it grey. A container with `database: true` is drawn
  as a cylinder. Ids start with a letter and hold only letters, digits and
  underscores, and are unique across the whole model.
- **Relationships** join any two elements, at any level: `source`, `destination`,
  and optionally `description` and `technology`.
- **Views** have a `key`, a `type` (`systemContext`, `container` or `component`), a
  `scope` (a system for the first two, a container for `component`), an optional
  `title`, and an optional `include` list of ids. `"*"` in it stands for the default
  set, which is also what you get with no `include`: for `systemContext`, the scope
  and every person and system related to it; for `container`, the scope's
  containers inside a dashed boundary and what they relate to; for `component`, the
  scope's components and what they relate to.
- A relationship is drawn between the nearest elements a view shows, so one between
  two containers shows up between their systems in a system context view. Model
  relationships at the most detailed level you know. One that ends on a view's own
  boundary from outside can't be drawn there; a `C4_RELATIONSHIP_NOT_DRAWN` warning
  in `meta.warnings` names it, unless that outside element already has a drawn
  relationship into the boundary.

Output: `{ view, type, title, elements, relationships, verified, format, svg }` for
`render`, where `elements` lists the ids drawn and `relationships` counts the arrows.
With `--out`, `{ file, bytes }` take the place of `svg`, and `file` is the absolute
path written. `mermaid` and `d2` return `text` in place of `svg`.

`render` lays the view out down the page: arrows leave a box from its bottom, run
straight through any row they pass, and enter their target from the top, so they
bend only in the gaps between rows. It checks its own drawing before returning it,
and `data.verified` lists each check:

| Check | What held |
|-------|-----------|
| `input.complete` | The whole file was read (unchecked for stdin and `--text`) |
| `boxes.apart` | No two boxes overlap |
| `children.inBoundary` | Every child is inside its dashed boundary, and nothing else is drawn over it (views with a boundary only) |
| `edges.touchBoxes` | Every arrow starts on its source's border and ends on its target's |
| `edges.clearOfBoxes` | No arrow passes behind a box it doesn't join |
| `labels.clearOfBoxes` | No label covers a box |
| `svg.wellFormed` | The SVG parses as XML and holds no character XML forbids. A control character in the model's text (other than tab and line breaks), U+FFFE, U+FFFF or a lone surrogate is drawn as U+FFFD |
| `text.width` | Always `approximated`: text is measured with Helvetica's widths, which Arial shares |

Each check that fails is one `C4_LAYOUT_CHECK` warning in `meta.warnings` naming
the first boxes or arrow involved and how many failed, and the first five are in
`verified`, so a bad drawing is never returned without saying so. `mermaid` and
`d2` check their own text instead: every element declared once (`text.elements`)
and one line per arrow (`text.relationships`), failing as `C4_TEXT_CHECK`. Whether
the text draws is up to whatever renders it, and is reported as unchecked
(`text.renders`, `UNVERIFIED`).

Limits, each an `INVALID_INPUT` past it, before any work grows with it:

- The model's JSON is at most 4 MiB.
- A model holds at most 1,000 elements (people, systems, containers and components
  together), 2,000 relationships and 100 views.
- `render` draws at most 100 boxes and 250 arrows in one view. Draw fewer with the
  view's `include` list, or split the view; `mermaid` and `d2` write a view of any
  size the model allows.

The layout runs in a worker thread with a 2 s deadline and 256 MB, past which it's
stopped with `TIMEOUT`, or `INVALID_INPUT` for the memory; at the limits above it
takes well under a second and about 40 MB. Past about
25 boxes, arrows cross more often and the drawing grows tall.

A model with mistakes fails with `INVALID_INPUT` before anything is drawn. The
message names each problem by its path in the model, such as
`relationships[2].destination: no element has the id "warehose"`, and
`error.details` lists them all. An unknown `--view` lists the keys the model has.

A sample model, an online bookshop with all three views, is
`docs/c4/bookshop.c4.json` in toil's source, and `docs/c4/busy.c4.json` is a busier
view of 25 boxes.

### `toil util owi map`

Maps the output of toil's own work item and pull request commands to Open Work
Items (OWI 0.2), the model in `docs/owi/spec.md` in toil's source, with its JSON
Schema beside it in `docs/owi/schema.json`. It composes: each tracker is read by its own command,
and this reads what they printed, whether piped, saved to a file, or appended one
envelope a line.

```bash
toil jira issue search --jql "sprint in openSprints()" --fields "summary,status,issuetype,Story Points,Sprint" | toil util owi map
toil util owi map sprint-42.jsonl
toil util owi map changelog.json --key PAY-104
toil util owi map batch.json --field estimate=Custom.TeamPoints --field estimateUnit=points
toil util owi map issue.json --command "github issue get"
toil util owi map prs.jsonl --key-pattern "PAY-{n}=corp-jira" --author-kind release-bot=BOT
```

| Argument / flag | Meaning |
|-----------------|---------|
| `[file]` | A file inside the workspace. `-`, or no file and no `--text`, reads stdin |
| `--text <text>` | The input itself, instead of a file |
| `--command <name>` | The command whose data the input is, when it holds `data` without its envelope (`"jira issue search"`) |
| `--key <key>` | The item a history belongs to, when its output doesn't say: `PAY-104`, or `imagile/payments-web#44` (a bare `44` takes the envelope's owner and repo) |
| `--field <name=field>` | Point an OWI field at a field of your own, repeatable: `estimate`, `estimateUnit` (`points`, `hours` or `days`), `priority`, `type`, `team`, `dueDate` or `iteration`; and for GitHub without a board, `estimateLabel` (`size/{n}`) and `iterationDays` |
| `--key-pattern <pattern=connection>` | Where work item keys in a pull request's title, branch and description point, repeatable, with `{n}` where the number is: `PAY-{n}=corp-jira`, `AB#{n}=corp-ado` |
| `--author-kind <id=KIND>` | Set a pull request author's kind by hand, repeatable: `release-bot=BOT`, with `KIND` one of `HUMAN`, `AGENT` or `BOT`. It wins over every other signal |

Over MCP the tool is `util_owi_map`, with `file` or `text`, and `command`, `key`,
`field` (a list of `name=field`), `keyPattern` (a list of `pattern=connection`)
and `authorKind` (a list of `id=KIND`).

**What it reads**, by the command each envelope's `meta.command` names:

- **Jira and Jira Cloud:** `issue search` and `issue get` (one key or several) for items,
  `issue history` for history.
- **Azure DevOps and Azure DevOps Services:** `work-item get` and `work-item get-many` for items, `work-item history`
  for history, and `work-item iterations` for iteration dates. `work-item search`
  returns ids only and is skipped: map `work-item get-many` for those ids instead.
- **GitHub:** `issue list`, `issue search` and `issue get` for issues,
  `project items` for the board's status, estimate and iteration, and
  `issue history` for history. Where no board gives a value, the issue's
  milestone is its iteration, a `points: N` label its estimate, and "Blocked by
  #n" or "Depends on #n" in its body a `blocks` link. Pull requests in an issue
  list or on a board are left out of the items with a warning.
- **Pull requests:** `pr list` and `pr get` of `github`, `bitbucket` (Data Center or Cloud)
  and `ado` (Server or Services), as changes. A list is enough to rank
  what is open; `pr get --include reviews,checks,commits,files` adds what a list
  lacks, and a pull request in both is one change with the get's fields.

Pass one envelope, a JSON array of them, or one a line (`>>` appends each command's
output to one file). A Jira changelog and a GitHub timeline don't name their issue,
so give `--key`, or wrap each as `{ "key": "PAY-104", "history": <envelope> }` in a
file holding several. Output from any other command is refused with
`INVALID_INPUT` naming the ones that map.

Output:

```json
{
  "owi": "0.2",
  "count": 1,
  "items": [{
    "owi": "0.2",
    "id": "corp-jira:PAY-101",
    "source": { "area": "jira", "connection": "corp-jira", "key": "PAY-101", "command": "jira issue get" },
    "url": "https://jira.imagile.dev/browse/PAY-101",
    "type": "STORY", "typeName": "Story",
    "title": "Tokenise card numbers at the edge",
    "status": "In Progress", "statusCategory": "IN_PROGRESS",
    "estimate": { "value": 5, "unit": "points", "field": "Story Points" },
    "iteration": { "id": "42", "name": "Sprint 42", "path": null, "start": "2026-10-05T09:00:00.000Z", "end": "2026-10-16T17:00:00.000Z", "state": "current" },
    "parent": "corp-jira:PAY-100",
    "links": [{ "type": "blocks", "direction": "outward", "target": "corp-jira:PAY-102", "name": "blocks" }],
    "history": { "transitions": [{ "from": "To Do", "to": "In Progress", "fromCategory": "TODO", "toCategory": "IN_PROGRESS", "at": "2026-10-06T09:15:00.000Z", "by": { "id": "jsmith", "name": "J. Smith", "email": null } }], "iterations": [] },
    "unmapped": [],
    "native": { "jira issue get": { "key": "PAY-101", "fields": { "...": "..." } } }
  }],
  "changes": [],
  "histories": [],
  "unmapped": {},
  "skipped": [],
  "verified": { "passed": true, "checks": [{ "check": "items.schema", "status": "passed", "checked": 1, "failed": 0 }] }
}
```

(Each item has every field in the spec; this one is shortened.) `count` is the
number of items. A pull request is one of `changes`:

```json
{
  "owi": "0.2",
  "id": "github:imagile/payments-web#51",
  "source": { "area": "github", "connection": "github", "key": "imagile/payments-web#51", "command": "github pr get" },
  "repo": "imagile/payments-web",
  "title": "Retry the address lookup once",
  "branch": { "source": "claude/address-retry", "target": "main" },
  "state": "OPEN",
  "author": { "id": "ada-dev", "name": null, "email": null },
  "authorKind": "AGENT", "authorKindSource": "trailer", "authorKindSignal": "Co-Authored-By: Claude <you@example.com>",
  "reviewers": [], "reviews": [],
  "checks": "FAILING", "checksAt": "2026-10-09T08:10:00.000Z",
  "mergeable": true,
  "size": { "files": 2, "additions": 71, "deletions": 5 },
  "workItems": [],
  "created": "2026-10-08T09:00:00.000Z", "firstReviewAt": null, "approvedAt": null, "mergedAt": null,
  "unmapped": []
}
```

- **`authorKind`** is `HUMAN`, `AGENT` or `BOT`, and `authorKindSource` says what
  set it, strongest first: an `override` (`--author-kind`), the `account` (GitHub's
  Bot type, a coding agent's account, a Bitbucket service account), an agent's
  Co-Authored-By `trailer` on a commit, an agent's `branch` prefix (`claude/`,
  `copilot/`, `codex/`), or `default` (`HUMAN`, nothing said otherwise).
- **`workItems`** are the OWI ids the title, branch and description name: GitHub's
  own `#12` and Azure DevOps' own `#2302` with no setup, and everything else by
  `--key-pattern`.
- **`checks`** is `PASSING`, `FAILING`, `PENDING` or `NONE`, rolled up from the
  checks on the latest commit; null, with the reason in `unmapped`, when the input
  didn't hold them. The same goes for reviews, mergeability and size: each says
  which command fills it.

- **`id`** is `<connection>:<native key>`, so items from two Jira sites never
  collide. Links, parents and children use the same ids.
- **`statusCategory`** is `TODO`, `IN_PROGRESS`, `DONE` or `UNKNOWN`: from Jira's
  status category, Azure DevOps' default states, and a GitHub board's Status
  options. A status with no known category is `UNKNOWN`, with an
  `OWI_UNKNOWN_STATE` warning naming it.
- **`estimate`** comes from each tracker's default field: Story Points or Story
  point estimate in Jira (by the name the connection registers, never a fixed
  `customfield_` id), then the original estimate in hours; StoryPoints, Effort or
  Size in Azure DevOps, then OriginalEstimate; a board number field named
  Estimate, Size or Story Points in GitHub, else a label such as `points: 3`
  (`field` is then `label:points: 3`). `field` says which. Teams with a field of
  their own point `estimate` at it with `--field`, the same keys a toil project's
  `fields` uses; a GitHub team with its own estimate labels names them with
  `--field estimateLabel=size/{n}`.
- **`iteration`** on a GitHub issue with no board value is its milestone: the
  due date is the end, and the previous milestone's due date the start (14 days
  before the end for the first, or `--field iterationDays=10` for every one).
- **`unmapped`**, on each item, lists every field the record couldn't fill and
  why: a field `jira issue search` wasn't asked for, an iteration whose dates need
  `ado work-item iterations`, a GitHub issue with no milestone and no board. `data.unmapped`
  counts them by field, and an `OWI_UNMAPPED` warning sums them up. Nothing is
  guessed.
- **`histories`** holds histories whose item wasn't in the input, by id, so they
  can be joined to items read earlier. **`skipped`** lists each document that
  wasn't mapped (a failed call, `work-item search`), each also an `OWI_SKIPPED` warning.
- **`native`** keeps every source record as it came, keyed by command.
- **`verified`:** every item, every history in `histories` and every change is
  validated against `docs/owi/schema.json` (`items.schema`, `histories.schema`,
  `changes.schema`) before it is returned; a failure is an `OWI_SCHEMA_INVALID` warning naming the item and the
  JSON pointer. The validation runs in a worker with a 2 s deadline per item, and
  one that can't finish is unchecked, never passed. `input.complete` checks the
  whole file was read.

At most 5,000 items, and 5,000 changes, are mapped in one call; past that the rest are left out with
an `OWI_ITEMS_CAPPED` warning, so map them in another call. Input is at most
64 MiB.

### `toil util owi similar`

Finds likely duplicate work items among Open Work Items, offline and deterministic:
no model, no network, and the same answer every time. It reads what
`toil util owi map` printed and asks no tracker itself, so it composes with any
search. **Run it before filing or proposing a new item**, and before triaging one:
`--query` with the title you were about to file says whether it already exists, in
Jira, Azure DevOps or GitHub.

```bash
toil jira issue search --jql "project = PAY" | toil util owi map | toil util owi similar --query "Card payments time out at checkout"
toil util owi similar --input-file items.owi.json --item corp-jira:PAY-101 --limit 5
toil util owi similar --input-file items.owi.json --pairs --threshold 0.6
toil util owi similar items.owi.json --pairs --fields title,body
```

| Argument / flag | Meaning |
|-----------------|---------|
| `[file]`, `--input-file <path>` | The OWI records: a file inside the workspace. `-`, or no file and no `--text`, reads stdin |
| `--text <text>` | The records themselves, instead of a file |
| `--query <text>` | Rank every item against this text |
| `--item <id>` | Rank the set against one of its items, by OWI id (`corp-jira:PAY-101`) |
| `--pairs` | List likely duplicate pairs across the whole set, so items from different trackers are compared with each other |
| `--limit <n>` | The most matches or pairs to return (default 10, up to 1000) |
| `--threshold <score>` | The lowest score returned, 0 to 1 (default 0.35) |
| `--fields <list>` | What to compare, separated by commas: `title`, `body`, `labels`, `parent` and `links` (default all) |

A `--query` that nothing scores the threshold or more against returns no matches
and an `OWI_SIMILAR_NO_MATCH` warning: there is no likely ticket for that text, so
suggest creating one. Don't lower `--threshold` to force a match. Matching work to a
ticket before starting it is `core.md`, **Ticket the work**.

Ask exactly one of `--query`, `--item` and `--pairs`. Over MCP the tool is
`util_owi_similar`, with `file` or `text`, one of `query`, `item` and `pairs`, and
`limit`, `threshold` and `fields`.

**What it reads:** the envelope `util owi map` printed, its `data`, a JSON array of
OWI records (as Toil UI's cache holds them), or one record a line. A record needs an
`id` and a `title`; one without either is skipped, listed in `data.skipped` and
warned about (`OWI_SIMILAR_SKIPPED`). Output from any other command is refused with
`INVALID_INPUT`: map it first. An id that appears twice is read once
(`OWI_SIMILAR_DUPLICATE_ID`).

Output, for `--item corp-jira:PAY-210 --limit 1`:

```json
{
  "mode": "item",
  "method": "Lexical similarity: BM25-weighted shared terms in titles and bodies, title character trigrams, and small boosts for shared labels, the same parent and a direct link. It measures shared words, not meaning, so a duplicate written in entirely different words scores low.",
  "fields": ["title", "body", "labels", "parent", "links"],
  "threshold": 0.35, "limit": 1,
  "query": null,
  "item": { "id": "corp-jira:PAY-210", "title": "Card payments time out at checkout", "source": { "area": "jira", "connection": "corp-jira", "key": "PAY-210", "command": "jira issue search" }, "url": "https://jira.imagile.dev/browse/PAY-210" },
  "items": 39, "count": 4,
  "matches": [{
    "id": "github:imagile/payments-web#51",
    "title": "Checkout times out when paying by card",
    "source": { "area": "github", "connection": "github", "key": "imagile/payments-web#51", "command": "github issue list" },
    "url": "https://ghe.imagile.dev/imagile/payments-web/issues/51",
    "score": 0.7211,
    "why": {
      "summary": "title terms checkout, time, card; body terms pay, 504, release, spinner, timeout, gateway; titles 72% alike by trigram; shared label checkout.",
      "titleTerms": ["checkout", "time", "card"],
      "bodyTerms": ["pay", "504", "release", "spinner", "timeout", "gateway"],
      "trigram": 0.7234,
      "labels": ["checkout"], "parent": null, "link": null, "titleOnly": false,
      "parts": { "terms": 0.4702, "trigram": 0.217, "labels": 0.0338, "parent": 0, "link": 0 }
    }
  }],
  "pairs": [], "search": null,
  "titleOnly": 19, "skipped": [],
  "verified": { "passed": true, "checks": [{ "check": "score.parts", "status": "passed", "checked": 1, "failed": 0 }, { "check": "score.meaning", "status": "approximated", "checked": 0, "failed": 0, "detail": "…" }, { "check": "input.complete", "status": "passed", "checked": 1, "failed": 0 }] }
}
```

`--pairs` returns `pairs` instead, each `{ score, a, b, why }` with `a` the lower id,
and `search`: how many pairs were `compared`, and `skippedFeatures` (below).

**How it scores**, so `why` can say exactly what drove each score:

- **Terms (`titleTerms`, `bodyTerms`):** titles and bodies (Markdown, Jira wiki
  markup, HTML and ADF, read as plain text without their URLs) become lowercase
  words, with common English words dropped and plurals, `-ed` and `-ing` stemmed,
  each weighted by BM25 over the set, a title word worth twice a body word. Two
  items are compared by the cosine of those weights; a query by how much of its
  weight an item covers, a word in the title counting fully and one only in the
  body at most 0.7.
- **Trigrams (`trigram`):** the character trigrams of the titles' words, which
  catch typos and word forms the terms miss (`Recipt` and `Receipt`).
- **Boosts (`labels`, `parent`, `link`):** up to 0.08 for shared labels (a rarer
  label counts more), 0.05 for the same parent and 0.1 for a direct link. Together
  they can't reach the default threshold on their own; at a threshold of 0.23 or
  less they can, and `OWI_SIMILAR_LOW_THRESHOLD` says so.

The score is 0.7 of the terms and 0.3 of the trigrams (all terms when titles aren't
in `--fields`), plus the boosts, capped at 1 and rounded to four places. `parts`
says what each added, and they sum to the score. Results score at least the
threshold, best first, ties by id.

**What it misses:** it measures shared words, not meaning. Two items that describe
one problem in entirely different words ("checkout hangs" and "payment page never
loads") score low, which `method` and an `APPROXIMATED` warning say on every call.
An item with no body is compared on its title alone (`why.titleOnly`), and
`OWI_SIMILAR_TITLE_ONLY` names those items: where the tracker holds a body, map them
from a command that returns it. A body is read up to 5,000 terms
(`OWI_SIMILAR_BODY_CUT`).

**Large sets:** scoring runs in a worker with a 30 s deadline, so tens of thousands
of items never hold the CLI or the MCP server. `--pairs` finds pairs through the
terms, trigrams, labels and parents they share, so its work grows with what items
have in common, not with the square of the set. On a very large set the commonest
of those stop being used to find pairs once a fixed budget is spent; `search`
counts them, and an `APPROXIMATED` warning says a pair sharing only those wasn't
compared. At most 50,000 records are scored in one call (`OWI_SIMILAR_CAPPED`), and
input is at most 64 MiB.

**`verified`:** `score.parts` checks every returned score lies in 0 to 1 and equals
its parts. With `--pairs`, `pairs.postings` holds the one shortcut the scorer takes
to it: each pair's score is summed from the terms and trigrams it shares, and every
pair returned is worked out again in full, so the two must agree (where common
features were skipped, the summed score must not be the larger). A failure is an
`OWI_SIMILAR_MISMATCH` warning. The same input always gives the same `data`.

From a program, `findSimilar(items, request, options)` in `@imagile-dev/toil/api`
ranks OWI records you already hold the same way, in-process (`core.md`, **Using
toil from a program**).
