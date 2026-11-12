# Building a `util` command

The `util` group holds local utilities: commands that work on something on this
machine and talk to nothing else. Each one follows the same rules, which are on every
`util` issue (#175 to #184) and repeated here, plus the shared pieces in
`src/areas/util/kit/` and `src/core/` that make following them the easy path.

## The rules

- **Local only.** No connection, credential or network. Nothing is spawned, and
  `npm run check:pure` passes. A dependency is pure JavaScript or WebAssembly, and it
  loads only when its command runs (**Lazy loading**, below).
- **CLI and MCP stay 1:1.** The command is a standalone `defineCommand` under
  `['util', …]`, and the parity suite (`test/parity/`) proves both front doors
  agree. Every example in `examples` must run against `test/fixtures/util.fixture.ts`,
  so add the files it reads there.
- **Self-verifying.** The command checks its own result wherever a check is possible,
  says what it checked in `data.verified`, and puts anything it couldn't check or had
  to approximate in `meta.warnings`. It never silently guesses (principle 4).
- **Proof in the PR:** fixtures built from real-world samples, sanitized to
  placeholder hosts; a test that the self-check catches a deliberately broken input
  or result; and a run of the built CLI and MCP on the samples.
- **Documented in the same PR.** Adding or changing a command updates
  `skills/toil/util.md`, which is also `/docs/utilities/`: the site renders the file
  itself, so there is no second copy to keep in step.
  - **The skill file** gives each command a section with examples in a shell block,
    a row in its command table (aliases, or `none`, and the MCP tool), and a line
    under one of the jobs in **By job** (reading CI output, writing for the tools,
    safety, arithmetic models get wrong).
  - **The page** adds only what the registry knows: each command's flags, aliases
    and MCP tool, from `site/src/data/commands/util.json`, which the registry writes.
  - `test/util-docs.test.ts` fails on a command with no example, no table row or no
    line under **By job**; a row or a line for a command that doesn't exist; an
    example or `--flag` the command doesn't have, so a flag change turns up as a
    stale example; a table cell that disagrees with the registry; and unbalanced
    tags in `site/src/pages/docs/utilities.astro`.

## Reading input: `kit/input.ts`

A command that reads one document spreads `inputFields` into its zod object, and
takes `fileArgument` and `textOption` on the CLI:

```ts
input: z.object({ ...inputFields, since: z.string().optional() }),
args: [fileArgument],
options: [textOption, { flags: '--since <time>', field: 'since', description: '…' }],
```

That gives `toil util log build.log`, `toil util log - < build.log` (or no file at
all, which also reads stdin) and `--text '…'`, and over MCP `{ file }` or
`{ text }`. `openInput(ctx, input, options)` opens whichever was given. It refuses
both at once, stdin over MCP (naming `file` and `text`), a folder, and binary content
(a NUL byte in the first 8,000 bytes) unless `binary: 'allow'`, which a command that
takes bytes sets. That lifts only the NUL check; the UTF-8 warning is `utf8`'s
(below), so a command reading bytes such as DER passes both.

- **Whole reads:** `bytes()` and `text()`, capped at `maxBytes` (64 MiB by default).
  Past the cap they're `INVALID_INPUT`, before reading when a file's size already
  says so.
- **Streaming:** a pass yields whole characters only, holding back up to 3 bytes of one a chunk boundary splits, so `chunks()` and `bytesRead` are the same for any chunk size. `lines()` yields `{ number, text }` from 1, with LF and CRLF
  dropped, in constant memory for a file of any size. A line longer than
  `maxLineLength` (64 KiB) is cut and marked `cut: true`. With `maxBytes` set, a
  stream stops there, sets `truncated` and warns `INPUT_TRUNCATED`. `chunks()` is the
  same pass as raw bytes, for hashing.
- **Re-reading:** `linesAt([12, 40])` reads the input again and returns those lines,
  for a self-check that a reported line number holds what was reported.
- **Encoding:** bytes that aren't valid UTF-8 are shown as U+FFFD, and the first pass
  that meets them warns `INPUT_NOT_UTF8` once. A command that treats the content as bytes and
  never shows it as text (`util encode` hashing or encoding a file, `util cert`
  reading DER) passes
  `utf8: 'skip'`, which turns that check and its warning off.
- **Size:** `expectedBytes` is a file's size on disk (or the text's length), and
  `bytesRead` what the latest pass read.

A file streams. stdin can only be read once, so it's held in memory, up to the cap;
for a very large input, pass a file.

All file access goes through `ctx.files` (CLAUDE.md, Bounds); the reader adds no way
round the workspace or toil's own files. `ctx.files.readStream(path)` is the core
streaming read it uses, and is there for any command.

## Self-verification: `kit/verify.ts`

```ts
const v = new Verifier(ctx.warn);
v.equal('tests.total', declared, counted, { code: 'REPORT_TOTALS_MISMATCH', at: `testsuite "${name}"` });
for (const f of findings) v.expect('finding.reread', reread.get(f.line) === f.sample, { at: `line ${f.line}`, expected: f.sample, actual: reread.get(f.line) }, { code: 'LOG_LINE_MISMATCH' });
v.inputComplete(input);
v.unchecked('coverage.branches', 'the report states no branch counts');
v.approximated('tokens', 'counted as one token per four characters');
return { ...result, verified: v.done() };
```

`data.verified` is `{ passed, checks }`. Each check appears once, however many times
it ran: `{ check, status, checked, failed, detail?, failures? }`, with `status` one of
`passed`, `failed`, `unchecked` or `approximated` and up to five sample failures.
`passed` is false when any check failed.

- **A failed check** warns once, at `done()`, under the command's own code (default
  `VERIFY_FAILED`), naming the first failure's expected and found values and how many
  of how many runs failed. Name codes after the command and what disagreed:
  `REPORT_TOTALS_MISMATCH`, `LOG_LINE_MISMATCH`.
- **A check that couldn't run** is `unchecked` and warns `UNVERIFIED` with the reason.
  **An approximation** is `approximated` and warns `APPROXIMATED` with how it was made.
  Neither fails `passed`, and neither is ever reported as passed.
- **`inputComplete(input)`**, after a full pass, compares the bytes read with the
  file's size (`INPUT_INCOMPLETE`), fails on a truncated read (`INPUT_TRUNCATED`), and
  is `unchecked` for stdin, which has no size to compare with.
- Everything passed as `expected` or `actual` is copied into the envelope. Never pass
  a secret; pass where it is.

Anything the command skipped (an element it didn't parse, a line it couldn't
classify, a file it couldn't read) is counted and reported in `data` and
`meta.warnings`, with the reason, never dropped.

## Shared parsers

| Piece | Where | What it is |
|-------|-------|------------|
| XML | `kit/xml.ts` | Built in. `XmlTokenizer` streams events from chunks of any size; `parseXml` builds a tree. Well-formed or `XmlSyntaxError` with line and column. No DTD processing, so nothing expands or is fetched; extra entities (HTML's, for storage format) come from the caller, and `fragment: true` reads a fragment. For JUnit, TRX, Cobertura and Confluence storage format |
| YAML | `kit/yaml.ts` | js-yaml, YAML 1.2 core schema (no timestamps), duplicate keys refused, one document, and aliases may add at most 1,000,000 values beyond the document as written (`INVALID_INPUT` past it, so a "billion laughs" document is refused; a document without aliases is held only by the input cap). Errors give line and column, never the text. Lazy only |
| JSON Schema | `kit/json-schema.ts` | @cfworker/json-schema, drafts 4, 7, 2019-09 and 2020-12, chosen from `$schema`. Problems by JSON pointer, deepest first, capped; `leafProblems` keeps the ones that say what is wrong. A validation that runs out of stack comes back `unchecked` with the reason. For ADF, OpenAPI and generated examples, through `kit/bounded.ts`. Lazy only |
| Bounded work | `kit/bounded.ts` | `runBounded`: work whose cost an input controls (JSON Schema validation, an input's own regexes, a user's `--grep`, laying out a C4 view, parsing YAML, outlining a file, converting Markdown, scoring work items for `util owi similar`) in a worker thread with a deadline (2 s) and a heap limit (256 MB), or a step's own limits where it measured past them (`DOCUMENT_LIMITS`, `MD_LIMITS`, `OUTLINE_LIMITS`, each with its measurements). One worker per process, reused: tasks queue, each with its own deadline, and one that passes a limit or is cancelled takes the worker with it, so the next starts fresh. Pass a `key` with a schema used repeatedly, so each worker builds it once. Send a large document as bytes (`source`, moved with `transfer`) and let the worker parse it, never as a parsed value: cloning a 60 MB value into the worker took the process down. `validateBounded`, `matchBounded` and `grepBounded` wrap it. Pass the command's `ctx.signal` as `signal`, so a cancel terminates the worker at once. A timeout, memory limit, stack overflow or Node's permission model denying workers is an outcome with a plain reason: report it as unchecked, or fail with `boundedError` (`boundedStep`), which names the step and the limit (TIMEOUT, INVALID_INPUT, CANCELLED, NOT_CONFIGURED), never INTERNAL. A ToilError thrown in the worker comes back as the input's own error (`refused`). The worker evaluates `kit/bounded-task.ts`, bundled with what it runs into a string by `scripts/gen-worker.mjs`, not the CLI, with the same no-spawn plugin; `check:pure` checks its metafile (`dist/metafile-worker.json`) like the bundle's. Lazy only |
| Secrets | `src/core/secret-shapes.ts` | toil's one definition of a secret. The audit log redacts with `redactText`; `findSecrets(text)` returns each secret's rule and position (the secret alone, never the name around it), from the same rules |
| Similarity | `src/core/owi/similar.ts` | Likely duplicates among Open Work Items, for `util owi similar`, Toil UI and anything else that asks "does this already exist?": BM25 over titles and bodies, title character trigrams and small boosts, deterministic and explained term by term (`why`). `findSimilar` asks once; `SimilarityIndex` is built once and asked many times. Pure, with no Node import, so Toil UI's page imports it as it is. The command runs it in the bounded worker under `SIMILAR_LIMITS` |
| Versions | `src/core/versions.ts` | The comparison `artifactory package outdated` and `util deps diff` use, exactly as recorded, and beside it each ecosystem's own grammar: `grammarFor(ecosystem)` loads npm's, NuGet's or Maven's (`src/core/versions/`, lazily) with parse, compare, ranges, bump and the intervals a range covers. `util semver` is built on it; use it rather than a second comparison |

Folder walking is `ctx.files.list(dir)`: what `git ls-files --cached --others
--exclude-standard` would list, `.gitignore` respected, with `stat` for sizes. There's
no second walker. A `.gitignore` line it can't compile (a reversed range such as
`[b-a]`) is skipped on its own, with a `GITIGNORE_LINE_SKIPPED` warning in
`meta.warnings` naming the file, the line and the fix; the rest of that file still
applies. So is a line longer than 4096 characters (`docs/bounds.md`,
`gitignore.line`), whose warning quotes only its start. A folder inside one that
`.gitignore` excludes lists only what git tracks there, with a `LIST_FOLDER_IGNORED`
warning saying so; `secrets scan` words it as `SECRETS_NOTHING_SCANNED` when that
leaves nothing to scan. An ignore file that exists but can't be read (permission, a lock, a folder
of that name) applies no rules and is a `GITIGNORE_UNREADABLE` warning naming the
file, the error and the fix; one that isn't UTF-8 still applies, decoded with
replacements, with a `GITIGNORE_NOT_UTF8` warning. Only a missing ignore file is
silently no rules.

Before adding a dependency, read CLAUDE.md, **No Executables** and **Secrets**: pure
JS or WASM, a licence of MIT, Apache-2.0 or BSD, pinned exactly, at least 14 days old,
and an entry in `NOTICE`.

## Lazy loading

Startup pays for every module evaluated at import. A `util` command keeps its
definition (schema, flags, examples, which the registry and `--help` need) in a small
module, and loads the code that does the work only when it runs:

```ts
run: async (input, ctx) => {
  const { summarise } = await import('./report/summarise.js');
  return summarise(input, ctx);
},
```

The bundle stays one file. esbuild wraps a module reached only through `import()` so
that it is evaluated on first use, not at startup. A static import anywhere undoes
that, so ESLint refuses a static import of `js-yaml`, `@cfworker/json-schema`,
`kit/yaml`, `kit/json-schema` and `kit/bounded` outside those wrappers and tests. A type-only import
is allowed, since it's erased. Treat a command's own heavy module the same way.

**A module reached through `import()` must not import zod**, directly or through
something that does (`kit/input.ts` does, for `inputFields`). esbuild then wraps
zod to be evaluated lazily too, and the MCP SDK's own top-level zod calls run
before it is, so the bundle fails at startup with `Class2 is not a constructor`.
Unit tests don't see it; `npm run smoke` does. A command whose work needs the
input reader and has no heavy dependency (`secrets scan`) imports it statically.

A module loaded through `import()` must not import zod, directly or through
`kit/input.ts`. esbuild then defers zod's own setup too, the MCP SDK's schemas hit
it at startup, and the bundle fails on every command, `toil version` included, with
`Class2 is not a constructor`; the unit suite doesn't notice, `npm run smoke` does.
Keep the reading in the command's small module and hand the lazy one what it read:
bytes, text, or the opened `UtilInput`, importing only the reader's types there
(`util log` does this in `runLog`). A small module may simply be a static import, as
`util encode` is. `util md` reads its input in `src/areas/util/md.ts` and hands the text on.

Data a command bundles (the OpenAPI schemas `util openapi` validates against, in
`src/areas/util/openapi/schemas/`) is vendored as published, with its source and
licence in `NOTICE`, and imported as JSON from inside the lazy module
(`await import('./schemas/x.json', { with: { type: 'json' } })`), so it loads with
the command and nothing is fetched.
