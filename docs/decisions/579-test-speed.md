# Tests and CI run faster without dropping a check (#579)

## The root suite

- **Parity is eight files, not one** (`test/parity/shard-0.test.ts` to `shard-7.test.ts`, one shared `test/parity/suite.ts`). The 4,700-test file set the wall time of the whole suite. Each shard claims units of work by counting them in a fixed order, so no list of areas or commands exists and areas still register by existing. A unit is a suite's own checks, one command's checks, or one cross-area check. A traced suite (`db`, `git`, `util`) stays in one shard, because its last check reads what every example logged. Each shard takes its index from its own file name, and a coverage check fails unless the files are exactly `shard-0` to `shard-(PARITY_SHARDS-1)`, so a missing shard can't silently skip a slice.
- **`--select` and `--output-format toon` with `--summary-file` run once per area, on its first command, and on every command that dispatches another** (`test/parity/suite.ts`, `sampled`). They test core machinery, and CLAUDE.md's list of parity checks never named them. `toil wait` hands `--select` to the read it repeats, a different path through core, so every `dispatches` command keeps them. The maintainer chose this over running them on every command or only once per area (on #579, 2026-11-12). What is lost is catching one ordinary command that breaks one of them alone; the dedicated suites in `test/select.test.ts` and `test/output.test.ts`, which use test-only commands, still run the machinery on its own terms. This is the one root-suite check that got narrower.
- **A toil-project test disk resets by difference.** `toilProjectDisk().reset()` used to delete and rewrite the whole temp tree twice per example, which made the toil projects commands about five times slower per test than any area on Windows. It now removes what a run added, and rewrites a seeded file only if it no longer reads as seeded, so the disk ends up as `seed()` left it. Skipping the removal on purpose fails 25 parity examples, so the suite still bites.
- **The triage safety list names the folder `test/parity/`**, not one file, so a shard or the suite is flagged for a human the way `test/parity.test.ts` was (principle 2).
- **Wall-clock bounds got room, and keep their meaning.** Linear-time guards in `test/audit.test.ts`, `test/owi.test.ts`, `test/owi-similar.test.ts`, `src/core/query/query.test.ts` and `src/areas/util/size-imports.test.ts` now allow seconds where linear takes milliseconds and the quadratic they guard against took six to seventeen. The size-imports ratio test takes the best of three on each side, so one garbage collection cannot decide it.
- **The root Vitest config sets no `maxWorkers`.** Fewer workers measured slower on the root suite, so Vitest's default stays.

## Toil UI's suite

- **The default environment is node** (`ui/vite.config.ts`). A file that needs a DOM says `// @vitest-environment jsdom` on its first line, so the server and model tests skip jsdom's startup.
- **It runs on half the cores** (`maxWorkers: '50%'`). At one worker per thread the jsdom files starved each other and the slowest cases timed out at 5 s.
- **`ui/test/views.test.tsx` is now `views-*.test.tsx`**, sharing `views-kit.tsx`, with one axe file per strict theme (`views-axe-plain`, `views-axe-crate`), so the pool runs them side by side. Every route still checks the banner's text.
- **`theme-bar.test.tsx` runs axe only in Plain and Crate.** The decorative themes could never fail it there (AGENT_DECISIONS.md, #267), and colour contrast is off in jsdom; the browser layout check still reports their findings. The click-target comparison still runs in every theme.
- **`find-fields.test.tsx` derives its counts from the fixture**, so adding a field to the fixture doesn't break a count that isn't the point of the test.

## The layout check and verify:ui

- **The layout check waits on conditions, not fixed sleeps** (`ui/scripts/layout-check.mjs`). A route, resize or `<details>` counts as settled after two still frames with no finite animation running. A state, once opened or undone, waits for its own end condition (its dialog present with no loading placeholder, a busy button free again) and then for 150 ms of stillness, so a placeholder is never what gets checked. A layout still changing 3 s after a step is a failure that names the step.
- **`LAYOUT_WORKERS` keeps one Chrome per core.** With the sleeps gone the work is CPU-bound, and eight workers on four cores starved the states that wait on a streamed answer.
- **`verify.mjs` makes one layout pass per part**, strict and decorative schemes in one `checkLayout` call (`shotsFor` shoots only the strict ones), instead of two passes one after the other. Strict schemes still fail the run on axe; the others are still report-only.
