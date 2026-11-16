# Demo data for the launch recordings (#623)

The principle review asked seven questions about how the Test Projects rules apply to
demo prep. The maintainer answered them (2026-11-16): demo and local-development prep
is held to what keeps people and sandboxes safe, not to the product rules, and
CLAUDE.md now says so in its principles preamble, Cross-Platform and Test Projects. The
decisions below that this settles are kept here only as the record of what the PR did.

- **GitHub writes go through `gh`, Jira and Azure DevOps through toil.** toil's
  github area has no milestone command, and the demo home keeps every connection's
  writes off, so `demo-week.mjs` writes GitHub the way `seed-sandbox.mjs` already
  does. Jira and ADO go through toil with `--allow-write`, so the connection's
  `writes` decides. Where: `ui/scripts/demo-week*.mjs`.
- **ADO Services stopgaps use `toil ado api`.** Repo creation, sprint dates, pushes
  and the PR-to-work-item link have no Services command yet; #621 adds them, and the
  script should switch once it lands. Assigning goes through `work-item update`.
  Where: `ui/scripts/demo-week-ado.mjs`, and `.claude/skills/sandboxes/demo-reset.md`, **Stopgaps**.
- **The active Jira sprint is renamed and re-dated, not completed and replaced.**
  Completing would move issues and close history; renaming keeps the board as it
  was. The three placeholder issues a new Jira site
  starts with ("Task 1/2/3") get real titles, but only while they still have the
  placeholder title.
- **ADO keeps its own sprint names** (Sprint 1 is the current one) instead of
  renaming to "Sprint 44": renaming iterations would break `ado-seed/apply.mjs`,
  which looks sprints up by name, and teams in different tools rarely share sprint
  names anyway.
- **Each seeded comment carries a marker** (`(Sprint 44 update, …)`), so a re-run
  finds it and doesn't post twice.
- **The Postgres replica uses trust authentication on loopback only**, so no
  password exists anywhere and nothing goes through the credential store. Where:
  `ui/scripts/demo-db.mjs`.
- **The sandbox's demo `package.json` pins two old releases with real advisories**
  (`express` 4.19.2, `jsonwebtoken` 8.5.1), so `toil deps scan` and `toil osv vulns`
  have something true to report. Nothing installs or runs them.
- **The demo home links `~/Library/Keychains` on macOS**, because `security` finds
  the login keychain under `$HOME/Library`; without it every `keychain:` reference
  reads as missing. The toil-side fix (and an honest error) is in #617.
- **The Confluence pages are the source; the Python generator that first wrote them
  stays out of the repository**, because repo tooling doesn't run Python. Where:
  `ui/scripts/demo-confluence/`.
- **The Postgres replica runs on Node alone by default**: PGlite (real Postgres in
  WebAssembly) served by `@electric-sql/pglite-socket`, both dev dependencies of Toil
  UI, pinned to releases at least 14 days old; Docker is an option (`--docker`). Local
  development needs only npm and the ability to run a local web app (the maintainer's
  call). The socket package lists seven PGlite extensions as peers, so npm installs
  them too: about 27 MB, all JavaScript and WebAssembly, never shipped. Where:
  `ui/scripts/demo-db.mjs`.
- **The sandbox and demo-prep guidance lives in the `sandboxes` skill**, with the two
  demo docs beside it, because it's needed only for marketing prep and LLM-based live
  checks, not for deterministic tests (the maintainer's call). CLAUDE.md keeps a short
  Test Projects rule that points there.
- **demo-week takes no target flags**: the three test projects are constants
  (`SANDBOX` in `ui/scripts/demo-week-data.mjs`), so a run can't be aimed anywhere
  else. GitHub has no seed mark from `seed-sandbox.mjs`; what demo-week creates there
  gets the label `toil-seed`.
- **A failed read stops a run** instead of counting as "nothing there", so a run
  never posts a comment twice. An earlier draft did, once, on ADO #157; the
  duplicate, which that run had posted itself, was deleted.
- **The demo home copies only the demo's five connections**, refuses any secret-like
  key that isn't a `keychain:` reference, runs toil without the shell's `TOIL_*`
  variables, and `--fresh` deletes only a folder carrying its marker file. `--launch`
  starts Toil UI there on every platform (HOME and USERPROFILE), reading the GitHub
  token from `gh auth token` into that process only.
- **Skipped from the review:** `npm run smoke -w ui` and `npm run verify:ui`, which
  test Toil UI's app and screens; this change touches neither, and nothing under
  `ui/scripts/` ships. Retitling the older GitHub sandbox issues that mention EU and
  FX: `seed-sandbox.mjs` finds its issues by title, so retitling them would make it
  create them again; `.claude/skills/sandboxes/demo-story.md` says what they stand for instead.
- **The Figma mockup was made once in the browser and isn't reseeded**: Figma's REST
  API can't write a file. `.claude/skills/sandboxes/demo-reset.md` says so, and toil reads it back.
- **The story is fictional and American**: Deliverables Unlimited (a consultancy) at
  Overdraft Federal (a US bank), merchants in US states, every amount in USD, the
  maintainer's call. People other than the protagonist appear only in text, since
  the seeds can assign only the token's identity. Where: `.claude/skills/sandboxes/demo-story.md`.
