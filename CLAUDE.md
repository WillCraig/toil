# CLAUDE.md

## Project

toil is a structured-JSON CLI and MCP server, owned by Imagile, that gives AI agents
and humans one interface to enterprise tools and databases. TypeScript on
Node.js (24.22.1 or later on 24.x, or 26.12.1 or later), published to npm as `@imagile-dev/toil`.

Who it is for, in priority order:

1. **Engineers at locked-down organizations** who install it themselves from npm and
   let an agent drive it. Every default is chosen for them.
2. **A stand-in for vendor MCP servers** that are blocked, need an OAuth login, or
   don't exist. `toil mcp --areas <list>` replaces one vendor server with one config
   entry.
3. **CI pipelines and headless agents**, configured entirely through env vars.

## Principles

The rules in this file are consequences of a few principles. When a rule and a
situation disagree, or a case is not covered, reason from the principle.

Principles 1 to 7, 9 and 10 govern **toil itself**: the npm package and what it does on a
user's machine. Principle 11 governs the screens people work in: Toil UI and toil's
welcome menu. This repository's own tooling (`scripts/`, the tests, workflows, and
the skills under `.claude/skills/`) is never published or installed by toil. It may
run `git` and `gh` and call GitHub. It still follows principle 8, because every
contributor runs it, and principle 2 where an agent does the work.

**When feedback or a correction arrives, find the principle under it before changing
anything.** Add or sharpen the principle here, then update every rule that follows
from it, not only the one instance that prompted it. A fix with no principle recorded
gets made again in the next place it applies.

1. **Adoptable inside a locked-down enterprise.** Installs from npm, runs on Node, and
   needs nothing else: no executable, no native library, no other CLI, no browser
   login. The only things a security team should need to approve are Node and one npm
   package. The one optional exception is git, which only the commands that are git
   need (#68); everything else, area context from a repository included, works without
   it. → No Executables, the Authentication Bar and no hardcoded hosts
   (`integrations` skill), placeholders that never resolve.
2. **Safe by default when an agent is driving.** Reads are free. Anything that writes,
   to a database or an enterprise tool, needs a human's standing opt-in in config
   plus an explicit flag on the call. Agents never loosen the rules that constrain
   them, and a person decides every merge. An agent may set up a connection, on the
   person's approval, with its non-secret settings (`toil connections add --area … --set
   key=value`, the maintainer's call on #516, 2026-10-28, trust settings such as a `db`
   connection's `tlsCaFile` included, the maintainer's call on #520, 2026-10-29), or import database connections
   from another tool's file (`toil connections import … --save`, the maintainer's call on
   #520, 2026-10-28, as long as each then names `toil connections login` for the person);
   only a person enters a secret,
   in their own terminal (`toil connections login`) or in Toil UI's Settings, so an agent
   never sees, types, stores or moves one, and `writes` stays off until the person turns
   it on. The same holds for agents working on this repository:
   they act only on feedback from its own people and named bots, stop after three
   pushed rounds with `needs-human`, and stay off any PR labelled `no-auto-fix`.
   The one exception: issues filed from outside (the site's feedback form and its
   curl endpoint) may be triaged by an agent, but only after redaction, within the
   daily cap, under the safeguards in the `automation` skill, and only through PRs
   that a human merges. Triage may fix almost anything: core, several areas at once, the
   skill, the docs, the tests and Toil UI (`ui/`, but not its spawner, packaging or tooling)
   (the maintainer's call, 2026-10-28, widening #487's of 2026-10-26). It leaves the
   website (`site/`) and the Azure Function backend (`functions/`, `infra/`) for a maintainer
   to review first, along with anything it cannot confirm or cannot do without running npm: it
   comments and labels the issue `needs-maintainer`, and the issue stays open. It denies and
   closes only what directly violates these principles, quoting the one. It never edits the
   rules that constrain it: `.github/`, `scripts/`, CLAUDE.md, `.claude/`, `dist/`, the
   decisions files, and anything at the repository root but `README.md`. Edits to a safety
   layer (toil's write gate, secrets, files, network, bounds, audit and config code, the MCP server, and Toil UI's gates, allowlists and
   launchers) are allowed and are listed at the top of the draft PR (`automation` skill).
   On a PR the maintainer is driving through Claude Code, the maintainer's decision is
   standing (2026-10-19): the agent turns on auto-merge, so the PR lands once the
   Imagile Bot's review approves its head commit and `CI ok` passes. A human still
   merges triage's PRs, any PR for an issue filed from outside, and the release PR.
   → Writes; the `databases`, `mcp`, `automation` and `ship` skills.
3. **One command does one thing against one source; the caller composes.** No
   aggregate command that decides on the caller's behalf which services to ask. →
   dependency analysis split by source, stdin / `--from` composition (`integrations`
   skill).
4. **Honest and obvious.** Every result says where it came from and how precise it
   is; every integration says how far it has been verified. Errors are unmistakable:
   they say plainly what went wrong and what to do about it. Nothing fails silently,
   and nothing important hides behind `--debug`. Jokes live in the copy, never in an
   error or failure notice. → Verification Levels (`unit`, `live`, `stable`, meant as
   `site/src/data/levels.json` says; `integrations` skill), source on
   every finding, the fix on every error.
5. **The environment wins without editing files.** CI and agents configure through
   env vars that override anything on disk. → Configuration Precedence.
6. **This repository stands alone.** Docs, code and skills never name another
   repository or another CLI as a reference or comparison. The command contract
   (**The command contract**, below) is toil's own record, kept by hand in this
   repository. The one exception is learning content: Context Overflow's glossary
   and modules, the maintainer's AI-fluency course, may be linked from Toil UI's
   learning links (behind its "Links to learning content" setting), the welcome
   menu's Learn, and one line in `skills/toil/core.md`. They are links a person
   follows, never fetched, and the glossary's first sentences are copied into the
   source by hand with their source named (the maintainer's decision on #418,
   2026-10-22).
7. **Never break what users already rely on silently.** Config on disk, command paths
   and flags, MCP tool names (which follow the paths), page cursors, the JSON envelope,
   precedence, the `./api` `execute()` surface and exit codes are contracts. **They
   are stable from the first beta, `0.1.0-beta.1`** (the maintainer's call on #478,
   2026-10-24). From then on, changing one is a declared breaking change: a `feat!:`
   with a `BREAKING CHANGE:` footer saying why and how to migrate, and, where
   practical, the old name keeps working with a deprecation warning for at least one
   beta before it's removed. → Output Contract, Delivery. While toil has no CI users,
   a fix that only stops toil answering from a source nobody configured (a precedence
   fall-through that reads the wrong repo or project) is a `fix:`, not a declared
   breaking change, and its PR says so (the maintainer's call on #540, 2026-11-02). The alphas
   (`0.1.0-alpha.N`) came before that commitment, so what changed in them needs no
   migration notes. Toil UI's screens and HTTP API (internal to its package) and
   the welcome menu's look are not contracts, and keep evolving. Compatibility
   with the command contract (the `integrations` skill) is a separate requirement
   and still applies.
8. **Same behavior on Windows, macOS and Linux.** None is second-class; a feature
   that works on one and not the others is not done. → Cross-Platform; the site
   is mobile responsive for the same reason (`site` skill).
9. **toil talks only to what the user pointed it at.** No telemetry, no update checks,
   no call home. The only network traffic is to hosts in the user's config, or to a
   public API that a command the user ran names in its own name (`toil osv vulns`),
   plus the proxy the environment names. The one exception is feedback to Imagile:
   `toil feedback` sends one report to Imagile's feedback endpoint, and only on a
   person's approval of the exact report it shows them, never on its own
   (`docs/bounds.md`, `feedback.send`). A credential goes only to the connection
   it's configured on, or to one the user paired it with; the one exception is an
   area's default connection taking another area's default env value, which keeps
   the env chain the contract records, unless the area's `shares.fallbackWhen`
   refuses it (Confluence takes Jira's token only from a Jira of the same
   deployment).
10. **Learn one area, know them all.** Integration commands converge on one shape,
    `toil <area> <resource> <action> [ids...] [--flags]`: everything you can do to a
    thing lives under that thing, positional arguments are only the ids that lead to
    it, and one idea has one flag in every area (`--limit`, `--assignee`, `--target`,
    `--body`). The welcome menu's Services module is that tree, so browsing it teaches
    what to type. The shape is toil's own: when an area is reshaped, the paths and flags
    the contract recorded before are dropped, not kept as aliases. Deliberate aliases
    (`deps outdated`, a routed alias, an area's `coreAliases`) are a different thing
    and stay. A product's Data Center and Cloud deployments are one area and one
    tree, not two to learn: the connection's `deployment` picks the API (#495). →
    **Command Shape** and **Deployment Variants** (`integrations` skill); every
    integration area follows it (#290, #297).
11. **Quiet screens: show what's needed to act, disclose the rest progressively.**
    A screen carries the data and the controls someone needs right now, and little
    else. Each screen has one focus, the thing to read first; everything else is a
    step further in, and each step is one the person chooses (expand, open, drill
    down), never a wall laid out up front. Detail is never removed, only layered: a
    summary line, then the item, then its evidence and history. Every page is
    reachable by more than one path (a link from the summary, its tab or list, the
    command palette, a search or shortcut, and its own address), so no layer is a
    dead end and nobody has to know the one way in. An
    explanation goes into an (i) tooltip with a Read more link to the docs. A
    control appears where it's used, or in a menu, the command palette or a
    shortcut, never as one more button on every row. An empty state offers the
    action that fills it, not a paragraph about why it's empty. Principle 4 still
    holds: errors, failures, and a result's source and verification level always
    stay on screen, never behind a tooltip; a source may shrink to a badge whose
    detail opens on demand, but it never disappears. When something new
    is added, something should come off the screen, or it should stay out of sight
    until it's called up (the maintainer's call, 2026-10-22). Progressive
    disclosure and multiple paths to each page are the central design principle of
    Toil UI (the maintainer's call, 2026-10-27). → Toil UI's help
    topics (`ui/src/help.ts`, #346) and the **Screen review** in the `ship` skill.

## Cross-Platform

*Principle 8.* Windows, macOS and Linux are all first-class.

- Agent CLI environment allowlists preserve the OS identity needed to locate an
  existing sign-in, including `USER` for Claude on macOS. Keep these names exact;
  preserving identity must not admit unrelated credentials (#489).
- Build paths with `node:path` and resolve home with `os.homedir()`; never hardcode a
  separator, a drive letter, or `~`. Paths in JSON output use forward slashes;
  paths on disk use the platform's own form.
- Never spawn through a shell (`shell: true`, `exec`), and never assume bash,
  PowerShell, or a POSIX utility. toil itself runs only git and programs the OS
  ships to hand over what it already holds for the user (No Executables); repo
  tooling may also run tools developers already have (git, gh, a browser, node),
  never through a shell. The credential stores are in `src/core/keychain.ts`, each
  behind a platform check (`secrets` skill), Windows authentication's SSPI helper is
  in `src/os/windows-sspi.ts`, and git is in `src/core/git.ts`.
- Read files as UTF-8 and accept both CRLF and LF; write LF. `.gitattributes` keeps
  the repo LF so Windows checkouts produce identical bundles.
- Config lives in `~/.toil/` on every platform, so instructions are identical.
- CI runs the full gate on `windows-latest`, `macos-latest` and `ubuntu-latest`, on
  Node 24.22.1 (the floor) and 26.12.1, the current release. 24.14 was the floor
  first, the first release where toil can trust the OS certificate store and honour
  `HTTPS_PROXY` / `NO_PROXY` from code, with no flag and no package
  (`src/core/network.ts`). The floor also has to be a release patched for every
  known remote code execution in Node, so it is each line's release that fixes
  CVE-2026-111497 (24.22.1 and 26.12.1, #479), and 25.x, which gets no fix, is
  refused. On any other Node the CLI prints one `UNSUPPORTED_NODE` envelope naming
  the CVE and exits 1 (`src/core/runtime.ts`). A test that is skipped on one platform says why in its name.

## No Executables

*Principle 1.* toil runs as JavaScript on the user's existing Node runtime and nothing else. Many
organizations block unsigned or unapproved executables and native libraries but allow
Node, and toil has to work there. This is the most important rule in the repo.

- Every runtime dependency is pure JavaScript or WebAssembly. No native addons (`.node`
  files), no `node-gyp`, no `prebuild`, no package that downloads a binary on install,
  no `install` / `postinstall` scripts.
- toil never spawns a bundled or downloaded binary. Spawning a program the OS already
  ships is allowed only to **ask the OS for something it already holds for the
  user**: a stored secret (the credential store, see the `secrets` skill) or a logon
  ticket (Windows authentication's SSPI handshake). toil never collects a credential
  to do this; it collects credentials only in an explicit setup command on a
  terminal (`toil connections login`, #51), which hands them straight to the OS
  store. The one other program toil may run is git, below.
- The published package is one bundle of code, `dist/toil-lib.js`, which runs nothing
  when loaded, plus two thin entries beside it (`scripts/entries.mjs`): the bin
  `dist/toil.js`, which calls its `main()`, and `dist/api.js`, which re-exports the
  API; `dist/api.d.ts`, declarations only; and `package.json`. No runtime
  `dependencies`. It installs with `npm install --ignore-scripts` and runs offline.
- CI enforces it on what ships, not on the dev toolchain:
  - `npm run check:pure` fails if `package.json` has runtime `dependencies` or any
    install/prepare script, or if the bundle imports anything but Node built-ins.
    That's read from esbuild's metafile, never by scanning text. It also fails on
    a native addon, on `child_process` imported by any file but the reviewed
    spawners in `scripts/spawners.mjs` (stubbed or not), or if the
    tarball holds anything beyond those files, `README.md`, `LICENSE` and `NOTICE`,
    if the build emits a second bundle, if a thin entry isn't exactly what
    `scripts/entries.mjs` defines, if `bin` or `exports["./api"]` point anywhere
    else, or if the declarations import another module.
  - `npm run smoke` installs the packed tarball with `--ignore-scripts` into a
    throwaway prefix and drives the installed bin through the CLI and MCP.
- Bundled dependencies can drag in a spawning API (commander imports `child_process`
  for subcommands toil never uses). The build resolves `child_process` to
  `src/shims/no-spawn.ts`, a stub that throws, for every importer but one.
- **Only the files in `scripts/spawners.mjs` get the real `node:child_process`**,
  a reviewed allowlist: the tsup `no-spawn` plugin decides by importer path,
  `check:pure` verifies it from the metafile, and ESLint allows the import in those
  files only, apart from repo tooling and tests, which never ship. Dependencies
  always get the stub. Any other spawn, or another file on the list, needs this
  section changed first.
  - **The OS credential store**, `src/core/keychain.ts`. It runs only what the OS
    ships (`security`, Windows PowerShell, `secret-tool`), never through a shell,
    with secrets on stdin.
  - **Windows authentication**, `src/os/windows-sspi.ts`, for SQL Server's
    `auth: "windows"` (#49). One Windows PowerShell (`powershell.exe` by absolute
    path under the system root, `-NoProfile -NonInteractive`) per connection, its
    script on stdin and never argv, calls SSPI's Negotiate package for the
    server's SPN; tokens pass base64 over stdin and stdout, and a password for
    another account, read from the credential store, goes on stdin too. It gets
    only an allowlist of the caller's env, refuses to run in Constrained Language
    Mode with an error saying so, and on any other OS the connection is refused
    before anything runs.
  - **git**, `src/core/git.ts`, the one optional exception to principle 1 (#68,
    decision 1). Only the commands that are git (the `git` area, `util deps diff`,
    and the `skills` marketplace commands, which clone and pull over https or from
    a local path only) run it;
    repository root, HEAD, branch and remotes are read from `.git` in pure JS
    (`src/core/git-repo.ts`), so area context needs no git. Without git on PATH those
    commands return `GIT_NOT_FOUND`, with a fix naming the PATH searched, and nothing
    else is affected. toil finds git's absolute path itself, skipping relative PATH
    entries and the working directory; runs it with no shell, a fixed subcommand
    list, and `--end-of-options` / `--` before user values; turns off what
    repository config can make it run (`-c core.fsmonitor=`,
    `-c log.showSignature=false`, `--no-ext-diff`, `--no-textconv`, no pager); sets
    `GIT_TERMINAL_PROMPT=0` and `GIT_OPTIONAL_LOCKS=0`; passes git only an
    allowlist of the caller's env (PATH, home, locale, temp, the Windows system
    variables, and the two that pick git's global config), so no token reaches it; and cancels it with the command's signal. It needs git 2.24 or later (`--end-of-options`); an older git
    gets `GIT_NOT_FOUND` saying so.

## Secrets

**A secret comes from the OS credential store or from an env var, never from a
file.** For every key an area lists in `defineArea({ secrets })`, a value in the
config file must be a `keychain:<ref>` reference; a plaintext one is
`CONFIG_INVALID` (fix: `toil connections login <name>`, or the env var), and the
value is never echoed. Config then holds nothing worth stealing, so a command that
reads or uploads files can't leak a credential by reading `~/.toil/config.json`.
Env vars are the path for CI, containers and machines with no store (headless Linux
without `secret-tool`). There is no `--plaintext`. Details are in the `secrets`
skill.

Before adding a dependency, check it against this rule. If the only good library is
native, find a pure-JS or WASM alternative or implement the protocol directly.

**Dependencies are pinned exactly** (`.npmrc` sets `save-exact`) and must be at least
14 days old when added or bumped, so a compromised release has time to be caught
before it lands here. Everything lives in `devDependencies`, because it all gets
bundled. npm 11.5's resolver can crash (`Cannot read properties of null (reading
'edgesOut')`) when resolving this tree from scratch. Installs from
`package-lock.json` are fine, so keep the lockfile, and if a fresh resolve crashes,
add the new package with `--legacy-peer-deps` and confirm `npm ls` reports no
invalid peers.

The rule protects what users install, so it covers the published package and its
runtime dependencies. `site/` is a separate private package that only ever builds in
GitHub Actions; its build tooling is out of scope.

## Layout

- `src/core/` — the machinery: `defineArea`, `defineCommand`, `execute`
  (validation, connection and context resolution in `call-context.ts`, write gate,
  envelope), errors, config loading and
  writing, the OS credential store (`keychain.ts`), the terminal prompter
  (`prompt.ts`) and the paste checks every secret goes through
  (`secret-input.ts`), and
  JMESPath (`query/`, behind `--select` and `toil wait --until`), and `toil wait`
  (`wait.ts`), which runs a read through `execute()` once per attempt
- `src/connections/` — `toil connections add | login | list | remove | test | writes | default | migrate | import`; `import-command.ts` is `import` and `import/` its pure parsers, one per tool (DBeaver, SSMS, pgAdmin, DataGrip, ...), which map a tool's file to `db` connections and never carry a secret (`docs/bounds.md`, `connections.import`)
- `src/setup/` — `toil setup alias | remove-alias`, the `toil` alias for a clone
  (CLI only; the profile editing is `src/core/shell-profile.ts`)
- `src/skills/` — the skills folders and marketplace clones (`docs/bounds.md`,
  `skills.folders`), the `skills` commands that read or change config, and the toil
  skill itself (`bundled.ts`, and `skill install | show` in `skill-commands.ts`); the
  `skills` area's own commands are in `src/areas/skills/`
- `src/dossiers/` — `toil dossiers list | show | check | context` (`commands.ts`),
  `init | add-repo | link | env | field | person | wip-limit | analyze set | describe | export | import | unlink | remove` (`build.ts`),
  `onboard` (`onboard.ts`), and `brief | analyze show | analyze prompt` (`brief.ts`); the
  model, resolution and writing are `src/core/dossier.ts`, and the briefing's lenses,
  its reader and the Analyze prompt are `src/core/brief/`, which Toil UI reads too
- `src/repos/` — `toil repos scan`, discovery for dossiers
- `src/audit/` — `toil audit list | stats | path`, reading the audit log
  `src/core/audit.ts` keeps; `stats.ts` is the summary's arithmetic
- `src/feedback/` — `toil feedback bug|feature`, CLI only, and the disclaimer every
  way of sending feedback shows (`consent.ts`, which `test/feedback-consent.test.ts`
  holds the function's and the site's copies to, and which also holds the feedback
  form's address, `FEEDBACK_FORM`)
- `src/theme/` — `toil theme list | set`: the one `"theme"` setting in the user's
  config, `TOIL_THEME` over it, that the welcome menu and Toil UI both follow (#427)
- `src/areas/<area>/index.ts` — one folder per area, exporting `area` and
  `commands` (standalone commands export only `commands`). `src/areas/util/kit/`
  is what the local `util` commands share: the input reader, self-verification,
  and the XML, YAML and JSON Schema parsers (`docs/util.md`)
- `src/registry.ts` — every shipped area and command, read by both front doors. It
  imports `src/areas.generated.ts`, which `scripts/gen-areas.mjs` writes before
  typecheck, build and tests and git ignores. **Areas register by existing:** adding
  one never edits a shared list, so parallel area PRs don't conflict.
- `src/program.ts` — builds the CLI from the registry; `src/cli.ts` is the bundle's
  entry: it exports the API and `main()`, which wires the CLI to the real process,
  and runs nothing when loaded. Only the bin, `dist/toil.js`, calls `main()`
- `src/api.ts` — `@imagile-dev/toil/api`, the third front door: `execute()` for a
  program in-process, the registry, the envelope types, `version` and
  `contractVersion`, and the pure helpers (`mapOwi`, `findSimilar`,
  `checkSecret`). It's the same bundle (`package.json` `exports` points at the
  thin `dist/api.js`, which re-exports `dist/toil-lib.js`), with its types in
  `dist/api.d.ts`; what it exports follows the
  command contract (`skills/toil/core.md`, **Using toil from a program**)
- `src/mcp/` — the MCP server (`toil mcp`, stdio); tools generated from the registry,
  and the read-only resources (`resources.ts`): connections, dossiers and each area's
  skill page, which `scripts/gen-areas.mjs` builds into `src/skill-pages.generated.ts`
- `src/welcome/` — the splash and menu that bare `toil` opens on an interactive
  terminal. Plain ANSI over Node's own `readline`, no package. Anything else (args,
  a pipe, CI, MCP) gets the JSON CLI untouched. Every screen is a pure function of
  data and every animation frame a pure function of time, so both are unit-tested.
  One file of views per menu module under `views/`, registered in `views/index.ts`;
  every action runs a real `toil` command in-process and shows the line it ran (a
  `--text` that carries earlier steps' output is named, with the pipe to type
  instead). Its Dossiers module can brief a dossier (`views/briefing.ts`, #494):
  each read, then `util owi map`, then `dossiers brief`, with every key an OSC 8
  hyperlink where the terminal draws them (`TermCaps.hyperlinks`) and the URL
  printed where not; service text goes to the screen with its control characters
  stripped. Its Services module (`views/services.ts`) runs any area command that way: a
  write only after a confirm screen that shows the line with `--allow-write`,
  so the connection's `writes` still decides, as it would typed by hand.
  It wears the theme `toil theme set` picks (#427): `themes/` holds one terminal
  version of each Toil UI theme (its light and dark colours, copied from its
  `theme.json`, which authors both, #507; the splash's ornament; a few menu
  words), `test/theme-sync.test.ts` holds each to
  `ui/themes/<name>/theme.json`, and the splash's cues are read from that file's
  `moments.splash` at build time (`scripts/gen-areas.mjs`). A theme never reaches
  an envelope, `--help`, an error, a fix or MCP.
  The one exception is Two Weeks' Notice, a roguelike for the wait on a build,
  reached by typing `resign` on the home screen and listed nowhere: its rules are
  pure functions in `rogue/`, the loop hands it the screen until q, and its progress
  is sealed under `"game"` in the user's config (`rogue/save.ts`), the only write
  the menu makes without a command. Without a config file, the first save creates
  one holding only that key.
- `src/shims/` — build-time stand-ins (the no-spawn stub, and the Azure SDK stub that keeps tedious's cloud sign-in out of the bundle)
- `src/**/*.test.ts`, `test/` — Vitest; `test/harness/` holds the shared fakes,
  `test/fixtures/` one `<area>.fixture.ts` per area plus the test-only demo commands;
  `test/live/` is the real-credential-store suite, kept out of `npm test` (`secrets`
  skill)
- `scripts/` — area registration, the purity gate, the committed-bundle check
  (`check-dist.mjs`), the tarball and clone smoke test, the area stub generator (`stub-area.mjs`), the divergence
  table (`divergences.mjs`), PR screenshots (`shoot.mjs`), the PR watcher the
  `ship` skill runs, and the review workflow's merge-only check (`review/`) (dev
  tooling; none of it ships)
- `skills/toil/` — the one skill shipped to users, and the site's docs: `SKILL.md` is a
  small index (a test caps it) of `core.md`, `dossiers.md`, the per-area files,
  `install.md` and `mcp.md`. `scripts/gen-areas.mjs` embeds every file in the bundle, `toil skill
  install` writes it into an agent's skills folder (`src/skills/bundled.ts`), and toil
  rewrites that copy, and only that copy, when a command changes the config file or
  another toil version runs. `.claude-plugin/` lists it as a Claude Code plugin
  marketplace, so the repository installs as one
- `dist/toil.js` and `dist/toil-lib.js` — the last released bin and the bundle it
  runs, committed so a clone runs with no `npm install`; only the release PR
  rebuilds them (Build & Test). Until the first release only the earlier
  single-file `dist/toil.js` is committed (`README.md`, Running from a clone)
- `.claude/skills/` — repo-internal skills only. They're for working in this
  repository; they're never published or installed by toil (that's `skills/toil/`)
- `docs/` — plans and decisions; `docs/decisions/<issue#>-<slug>.md` holds the
  decisions agents made by default, one file per PR (Delivery);
  `docs/divergences/<area>.json` holds each area's
  divergences from the command contract, and `docs/briefs/<area>.md` the integration brief for each
  area still to build
- `site/` — the GitHub Pages site (Astro), its own private package; see the `site`
  skill
- `ui/` — Toil UI (#206), the separate package `@imagile-dev/toil-ui` (beta, local
  only), the root's npm workspace with its own release (`toil-ui-v…`): a React and
  Vite front end, with one dashboard per dossier, and its local server in
  `ui/server/` (`node:http`, the `toil-ui` bin), which pins `@imagile-dev/toil`
  exactly and has no other runtime dependency. The app is built on toil's own
  `execute()` and an `Agent` interface, and imports a few of toil's pure modules
  from source where it needs them in the page (`src/core/brief/`, the briefing and
  the Analyze prompt, #494; `src/core/owi/similar.ts`; the workflow pages in `skills/toil/workflows/`, read when it is built for its Review, Ship and Diagram jobs, #532), which is why it releases with
  the toil it needs; the server answers both behind its `Store`
  and `Agent` interfaces, behind a launch token. It reads by default and writes only
  what a person presses: a worklog export, through `util encode --out` and toil's file
  service (#308), and the connection and dossier changes Settings runs through toil's
  own commands (`CONFIG_COMMANDS`, #253), each behind its own write gate, including a
  dossier's name and description (`dossiers describe`, #342). Each agent run starts
  that agent's own CLI through its SDK (#251). The server itself spawns one thing:
  `npm install` of an agent SDK the repo already pins, from Settings → Agent, shown
  first and run on a press, in `ui/server/agents/install.ts`, the only server file
  `check:package` lets spawn (#344). Themes are in
  `ui/themes/` (CSS, JSON and assets only, built in only: each game theme's
  `lexicon` and agent `voice` are in its `theme.json`), explained in
  `ui/docs/themes.md`, which the site renders at `/docs/themes/`. Its fixture `execute()` and scripted
  Agent are its test harness, `toil-ui --sample`, and the app the site's showcase at `/ui/` frames.
  `ui/test/registry.test.ts` holds every call the fixture answers to the real
  registry; `npm run check:package -w ui` is its `check:pure`, and `npm run smoke
  -w ui` installs both tarballs, opens it, and holds every view in every theme at
  375, 768 and 1440px to the layout check in headless Chrome
  (`ui/scripts/layout-check.mjs`), with reduced motion, then the views where the
  theme moments play again with motion on (#419). The decisions are in
  `AGENT_DECISIONS.md`, **#206 preview**, **#228 dossier dashboard** and **#249 UI
  server**
- `functions/feedback/` — the feedback backend behind the site's form and its curl
  endpoint (an Azure Function, Node.js), its own private package like `site/`, never
  published, so the No Executables rule doesn't cover it; `infra/main.bicep` provisions
  it (`functions/feedback/README.md`, and the `automation` skill for the triage that
  follows)

An area is declared once with `defineArea({ name, connection, secrets, defaults,
fallbacks, renamed, variants, context })`: `connection` is the zod schema of what a
connection to it holds; `secrets` lists its secret keys, or maps each to `token` or
`password`; `variants` names the keys each value of one field requires (`db`'s
`engine`, `jira`'s `deployment`); and `area.envName(key)` gives a setting's env var for fix text, so no
area spells out `TOIL_<AREA>_…` by hand. Its commands come from `area.command({ ...
})`: a path, a zod input schema, whether it writes, CLI arguments and flags (each
mapped to an input field), and at least one example input. Core adds the
`connection` input (`--connection <name>`) to every area command. A write command
spreads `allowWriteField` into its input. The CLI and MCP surfaces never implement
behavior of their own; if one needs something the other lacks, the gap is in core.

**Every command has one `kind`**, which decides what core hands it and which front
doors serve it: `standalone` (`defineCommand`: no area, no config, e.g. `version`),
`area` (the default for `area.command`), `area-local` (under an area's path with no
connection or config, e.g. `jira issue schema`), `config` (`defineConfigCommand`: gets
`ctx.manage`) and `cli-only` (a config command never served over MCP).

**Context inputs** say where in the service a command acts (`--project`, `--repo`,
`--instance`). An area declares them once in `context`; a `group` input (the default)
is a flag on the area's group (`toil github --owner o pr get 7`, accepted before or
after the leaf) and a field on every one of its MCP tools, and a `command` input
belongs to the commands that list it in their own `context`, which also marks any
input `required`. Core resolves each in one order: the call's own value, then the
dossier that applies to the call, then the git remotes where the area declares how
to read them (`origin` first, then the others; the first one on the connection's host
that the area's parser accepts), then the connection's `setting`, then the area's
`default`. A dossier value held per repo that matches no repo of the dossier does not fall through to
git or the connection: a command that needs it is `INVALID_INPUT`, any other leaves it unresolved with
a `DOSSIER_REPO_UNMATCHED` warning (#540). A command that reads one from a
file the call named (an `--input-file`) reports it with `ctx.supply`, which ranks
it just below the call's own value. An input with `selectsConnection`
picks the connection (`--env staging` selects the one named `staging` or whose `env`
is `staging`), and `--connection` goes through the same chain: at each source in
turn, a named connection and a selecting input must agree. `run` reads
`ctx.context.<input>`, and `ctx.resolved` is the same report `meta.context` carries:
the connection, each input, and where each came from. `--help` and each MCP field
say where an input defaults from, in that order.

**`--env` is one concept:** "which environment", everywhere. It's the context input
on areas that have environments (`openshift`, `dynatrace`), and the dossier's
environment is the same input: an explicit `--env` wins, otherwise the dossier
supplies it through the resolver. There is no separate global `--env`. An
environment the area doesn't know is a loud `INVALID_INPUT` listing the ones it has,
never a guess.

**A write on a connection that the dossier or the git remote chose is refused** until
the user adopts that binding (`WRITE_DISABLED`, naming the connection). A dossier in
the user's own folder, `~/.toil/dossiers/`, is adopted; a checked-in, listed or loose
one isn't, and adopting it means copying it there (`toil dossiers import`, which the
fix names along with `--connection`). Reads may follow the
suggestion; once adopted, writes work normally. A connection the user named, selected
with an explicit input, or set as the default is theirs already. **A write takes its
target only from sources the user owns**, too: one whose target context inputs
(`owner`, `repo`, `project`) came from an unadopted dossier is `WRITE_DISABLED`
when the command reads one, before the write is sent, on any connection; passing them, or adopting the dossier,
clears it. Field aliases and transition pins still apply from any dossier (#302).

**Dossiers** (`docs/dossiers.md`, `src/core/dossier.ts`) are read on every call to an
area command, from `~/.toil/dossiers/`, the folders in `dossierPaths` or
`TOIL_DOSSIER_PATHS`, and `.toil/dossiers/` in the call's repository. Core adds two
inputs to every area command for them, after `connection`: `dossier` (`--dossier
<name|file>`, else `TOIL_DOSSIER`) and `cwd` (`--cwd <dir>`, else the workspace), the
folder whose repository picks the dossier and the git context. `run` never sees
either. A section supplies its area's context inputs by name, and picks the
connection by `connection` or by `host`, a selector toil compares and never
contacts. Every problem found reading one is in `meta.warnings`, by file and key path.
An area command sees a dossier only through two read-only views: `ctx.dossierFields()`,
its field aliases, for a `--field`, and `ctx.dossierView()`, its sections, for
`<area> check-dossier` (`src/core/check-dossier.ts`). Asking either consults the dossier.
Over MCP the dossier commands refuse any change that would make a section select a
connection with writes on, and any import or export of a dossier that does: a person
makes that binding on the CLI (`ConfigAccess.via` says which door).

**Cross-area credentials are paired explicitly** (*principle 9*). `defineArea({
shares: { area, keys } })` only declares which keys may be paired; core adds a
`<key>From` setting, and a connection borrows only when the user set it (a Kibana
connection with `"apiKeyFrom": "es-prod"`), and only from that connection. Between
the two, the env tier beats the file tier, and the own connection wins a tie. With
no pairing a connection uses only its own key, with one exception that keeps the contract's
env chain: the area's default connection takes the other area's default
connection's env value (`TOIL_KIBANA_API_KEY`, then `TOIL_ELASTICSEARCH_API_KEY`),
matching precedence rule 2, unless the area's `shares.fallbackWhen` refuses that
connection (Confluence takes Jira's token only from a Jira of the same deployment,
read as it resolves, `defaults.<area>` included). An explicit `<key>From` pairing is
the user's call and isn't checked. A shared key is a secret in both areas or in neither.
`meta.context.shared` names the connection, whether it was paired, and whether the
value came from env or the store, never the value.

**One product, two deployments** (#495, `src/core/deployments.ts`). `jira` and `confluence` serve Data Center
and Cloud: a connection says `"deployment": "server"` (the default) or `"cloud"`, and
each deployment keeps its own API code, written as ordinary `area.command()`s that are
never registered themselves. `area.byDeployment({ server: [...], cloud: [...] })` folds them
into one command per path, so there is one CLI path and one MCP tool: the input is the
union of what either takes (a field both take must say the same thing to a reader, or
the area's overrides say how), `run` hands the call to the implementation for the
resolved connection's `deployment`, and each implementation still validates its own call
against its own schema. A call the deployment can't serve, a command only the other one
has or a flag only the other one takes, is `UNSUPPORTED` before any request and before the
write gate, naming the connections that can. `data` is each API's own shape, and
`meta.context.connection.deployment` says which ran. A command with no connection
(`jira issue schema`) has no deployment to go by and takes it as a flag. The parity
suite runs every example against a connection of its own deployment
(`AreaFixture.deployments`).

**Aliases** add CLI paths onto a command: a word is a sibling in its group, a path
may sit in another group (`deps outdated` for `artifactory package outdated`); MCP still has
one tool per command, and `meta.command` names the command. An area's `coreAliases`
put a path in its group onto a core command fixed to that area (`jenkins instance
list` is `connections list --area jenkins`). A **routed alias** is a contract path
whose flag value picks the command (`deps frisk --source sonatype` runs `ossindex
vulns`), declared once in `ROUTED_ALIASES` in `src/registry.ts`
(`src/core/routed-alias.ts`); a route whose command isn't registered is skipped,
and calling it says so.

Request paths are built with `apiPath` (`src/core/api-path.ts`), which encodes every
interpolated id as one segment; a context input that lands in a path uses
`pathIdSchema`, so path syntax in it is refused however it arrives. Every path a call
names is checked from its text before any file call: network and device paths are
refused (`src/core/local-path.ts`, bound `files.remote`).

Local files go through `ctx.files` (`src/core/files.ts`), never `node:fs`: input
files, uploads, downloads and CSV reports resolve inside the workspace on both
front doors (**Bounds**), `-` means stdin only on the CLI (over MCP stdin carries
the protocol, and on an interactive terminal it refuses at once rather than wait), saved paths in output are absolute with forward slashes, and tests
get an in-memory copy. It also answers `exists`, `stat`, a `.gitignore`-respecting
`list` and `findUp`, streams a file of any size with `readStream`, and writes CSV with `writeCsv`. git runs only through `ctx.git` (`src/core/git.ts`). HTTP to a REST API
goes through `apiRequest` in `src/core/api.ts`, built from the area's
`defineArea({ request })` hook, on `restRequest` in `src/core/rest.ts`. Together they
turn failures into `AUTH`, `NOT_FOUND`, `HTTP` or `NETWORK` errors with the server's
own message, retry a 429, keep a base URL's context path, and keep credentials on the
connection's host: a redirect elsewhere is refused, unless a GET opts into following a
signed download URL with every header dropped. argv is typed from the schema by the
same rule env vars follow (`fromText` in `src/core/schema.ts`): numbers, `true` and
`false`, enums, JSON for an object, and an array field's flag is repeatable with each
value typed as its element. A union stays text, which is how Jira keeps the
`parseInt` reading of `jira issue search --limit` that the contract records.

**`<area> api` is the raw passthrough** (`src/core/passthrough.ts`): an HTTP area
exports `apiCommand(area, { service, examplePath, examples })` with its commands, and
gets `toil <area> api <METHOD> <path>` (`<area>_api` over MCP) on the same request
hook, so it can't drift from the wrapped commands. The path stays under `baseUrl`
(a scheme, `//host` or a leading backslash is `INVALID_INPUT`), the method decides
the write gate (`writesWhen`), a `DELETE` is refused over MCP (`offMcpWhen`), JSON
comes back parsed, text as text and binary as base64 (with `API_BINARY`), up to 1 MB, and `meta.response` carries
the status and content type. Non-HTTP areas (`db`, `git`) don't have one.

**Commands never read config or env.** `run` gets `ctx.connection`, the one
connection this call resolved, plus any setting from a connection the user paired
it with, resolved by core, validated and typed from the area's schema, and a
context with no `config` and no `env` (which carries every `TOIL_*` credential and
every CI token on the runner), so no area can reach another area's or another
connection's credentials on its own. ESLint bans importing config, the credential store
(`core/keychain`) and the prompter (`core/prompt`) under `src/areas/`, and
`process.env` stays out of area code for the same reason. The store and the
prompter are withheld from the context too. The only commands that see the whole config are the
`toil connections` commands, defined with `defineConfigCommand`, which get
`ctx.manage` (config, store, prompter); no area command can.

A `cli-only` command is never an MCP tool: it prompts on a terminal (stdin is
the protocol under MCP) or changes connections, which an agent does only for
`connections add --area … --set key=value` and `connections import … --save`, each on
the person's yes (principle 2): its
prompts, every secret and turning `writes` on stay the person's. It has no
time limit, since it may be waiting on someone typing. An area command that must
stay off MCP but keeps its connection and time limit, a delete, sets `mcp: false`.
A command whose input decides whether it writes (the passthrough's method) sets
`writesWhen`; it stays `writes: false`, so its reads are free and it's served with
writes off, and execute() gates each call that writes. One with some calls MCP must
not make sets `offMcpWhen`, which execute() refuses over MCP before anything runs.

## Bounds

A bound is a limit every command is held to, whoever drives it: the file
workspace, toil's own files, credentials only to their host, secrets only in the
store or env, CLI-only commands, time limits, read-only commands staying read-only,
and spawning only git and the programs the OS ships to hand over what it already holds (the credential store, Windows authentication). `docs/bounds.md` lists each one,
what it protects, where it's enforced, its error and whether it can be relaxed;
`src/core/bounds.ts` is the same list in code, and `test/bounds.test.ts` keeps them
in step. A new bound, or a change to one, updates both. Only a setting in the user's
own config file relaxes a bound (today only `"bounds": { "files": "unbounded" }`),
security-class bounds never, and every envelope says so in `meta.warnings` while
one is relaxed. The documented exceptions are reading git metadata above the
workspace, `--output-file`, the shell profile `toil setup alias` edits, and another
tool's connection file `toil connections import` reads (`docs/bounds.md`).

**The file workspace.** Every path a command reads or writes resolves inside one
folder: `--workspace <dir>`, else `TOIL_WORKSPACE`, else the CLI's working
directory, else the MCP client's single root; with none, file commands refuse with
`NOT_CONFIGURED`. It's checked after realpath, like the rule below.

**The file service refuses toil's own config and credentials.** `ctx.files` won't
read or write anything at or under `~/.toil/` or the `--config` file, resolved
through realpath (so `..`, symlinks and junctions don't get round it) and compared
case-insensitively on Windows. A command handed a path by an agent would otherwise
send every connection's token to its own host. For the same reason it refuses
anything under `/proc/` and `/sys/`, where `/proc/<pid>/environ` holds the env vars
that carry tokens.

## Build & Test

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # ESLint
npm test            # Vitest
npm run build       # tsup → dist/toil-lib.js, one bundle, plus the thin dist/toil.js and dist/api.js
npm run check:pure  # the No Executables gate (after build)
npm run smoke       # install the tarball with scripts off; drive CLI and MCP; run a clone (after build)
```

All six pass before a PR opens. A PR that touches `ui/` also passes Toil UI's gate
(the same commands with `-w ui`, plus `check:package` and `check:lockfile`) and then
`npm run verify:ui`, adding `-- --ask` when it changes the agent: one command that
checks Toil UI on sample and real data and writes `ui/.verify/report.md`, whose table
goes in the PR, so the work is verified before the review bot sees it (`ui/README.md`,
Verify before you open a PR). On a PR and on `main`, CI (`ci.yml`) runs them on
Linux on Node 24.22.1, as two jobs side by side, toil's gate and Toil UI's. Its `CI ok`
job passes only when both passed, along with the database integration job and the
`dist/` guard (below), and it's the one check `main`'s ruleset requires, so nothing
merges on a red gate. Windows, macOS and Node 26 run in `platforms.yml`: daily, on
demand, and on the release PR, whose merger checks it passed, so a platform break
shows within a day and is looked at before a release. A failed daily run files a `platforms-failure` issue (#376).
Principle 8 still holds: a platform failure gets fixed like any other, it just
doesn't hold every PR behind macOS and Windows runners. Other checks stay optional:
the review job (approval is required separately, and it skips the release PR), the
platforms run, and path-filtered jobs, which would block PRs they never run on.

**`dist/toil.js` and the bundle it runs, `dist/toil-lib.js`, are committed and are
the last released toil** (the maintainer's decision, 2026-10-17), so a clone runs
`node dist/toil.js` with no `npm install`. A PR never changes them: the `dist/` guard in CI (`node scripts/check-dist.mjs --untouched`) fails any PR
that touches `dist/` unless it is release-please's own (`release-please--…`). The
release workflow rebuilds both on the release PR and commits them there, and
`npm run check:dist` verifies them on that PR on every OS. The version is in
`dist/toil-lib.js`, which release-please's `extra-files` names. What's committed
before the first release, and clearing an untracked `dist/toil-lib.js` after a local
build, are in `README.md`, Running from a clone.

## Output Contract

Every command writes exactly one JSON envelope to stdout: `{ ok, data, error, meta }`.
Errors are a `ToilError` with a code and a fix the user can act on, never a raw
stack trace. Logs and progress go to stderr. Removing or renaming a field in `data` is
a breaking change.

- **`meta.contractVersion`** is on every envelope and in `toil version`: `CONTRACT_VERSION`
  in `src/core/envelope.ts`, equal to `contractVersion` in `docs/command-contract.json`
  (a test holds them together). It goes up by one with every breaking change to the
  contract and never for an additive one. The alphas all report 1, the first beta
  ships 1, and every breaking change from then on raises it (principle 7;
  `docs/command-contract.md`, The contract version).
- **Three front doors, one `execute()`.** The CLI, MCP, and `@imagile-dev/toil/api`
  (`via: 'api'`, `src/api.ts`), which sends MCP's fields and is held to MCP's rules:
  it serves what MCP serves, applies `offMcpWhen`, words input errors in field names,
  and is refused what the dossier commands refuse over MCP. Its `readOnly` option
  refuses any call that changes anything before anything resolves: `writes` /
  `writesWhen`, and `writesLocal` / `writesLocalWhen` for a local write (toil's config,
  the store, dossiers, a skills folder, a profile, a workspace file). Every `config`
  and `cli-only` command must declare `writesLocal` (`defineConfigCommand` requires
  it, since they write with node:fs); any other command's `ctx.files` writes are
  refused under readOnly as a backstop, and the parity suite runs every example under
  readOnly to prove each is refused or changes nothing. It also skips the skill's upkeep; its `caller` label is checked
  (`CALLER_LABEL` in `src/core/audit.ts`) and recorded on the audit line.
  `CallOptions` in `src/core/run.ts` carries both, and is where a later `actor` goes.
- **Progress events** (`src/core/progress.ts`): `execute()` runs each command under
  an AsyncLocalStorage listener, and core's own machinery reports to it, so no area
  does: every request (`instrumentFetch`), every page (`paginate()`), every 429 retry
  (`restResponse`). The CLI writes every retry to stderr, piped or not (a minute's
  silent wait looks hung), and pages only on a terminal (`cliProgress`), MCP sends them as progress notifications when the call has a progress
  token, and the API hands every event to `onProgress`. A listener that throws loses
  its events, never the command (`PROGRESS_LISTENER_FAILED`). An area that pages or
  retries outside those helpers reports nothing, which is a reason to use them.

- **Usage errors are envelopes too.** An unknown command or flag, or a missing
  argument, gets an `INVALID_INPUT` envelope on stdout (`runProgram` in
  `src/program.ts`). Only `--help` and `--version` print plain text.
- **`--verbose` adds `meta.requests`**: method, URL as sent with credential
  parameters and userinfo redacted (`redactUrl` fails closed on credential-shaped
  names, and leaves identifiers such as `projectKey` and `componentKeys`), status and timing for every request. It never includes headers or bodies.
- `--verbose` lives in core: `execute()` hands every command an instrumented
  `ctx.fetch`, so no command implements it and no front door can forget it. Commands
  under `src/areas/` may not call `fetch` directly, and ESLint enforces it.
- **Every call `execute()` runs appends one line to the audit log**,
  `~/.toil/audit/<yyyy-mm>.jsonl` (`src/core/audit.ts`): front door (and an API
  caller's label and the actor it names), command,
  area, connection, whether it wrote and had `--allow-write`, outcome, duration,
  the input and every request's method, redacted URL and status, `--verbose` or
  not. Never a header, body or row. Input goes through `--verbose`'s name rule,
  `redactUrl` and a token-shape check, and a command's `auditInput` drops a field
  or keeps only its SHA-256 (`db` hashes its SQL). One write per line to a file
  opened for append keeps concurrent writers apart; a failed write is an
  `AUDIT_WRITE_FAILED` warning, never a failed command. Months older than
  `"audit": { "keepMonths" }` (default 6) are deleted as it writes, and
  `"audit": { "enabled": false }` turns it off, read only from
  `~/.toil/config.json`: never a flag, env var, MCP field or `--config` file.
  A call refused by the CLI's argument parser, or whose config couldn't load,
  never reaches `execute()` and isn't recorded.
- **Input is strict.** `execute()` parses with the schema's `.strict()`, so an
  unknown or misspelt field is `INVALID_INPUT` through MCP exactly as an unknown flag
  is on the CLI. Never silently ignore a field.
- **`--select <expression>`** (`select` in every MCP tool's input) is core's, on every
  command: a JMESPath expression `execute()` compiles before anything runs and
  applies to `data` after `run`, leaving `meta` alone. The language lives in
  `src/core/query/`, built in rather than a dependency, and passes the official
  compliance suite (`test/fixtures/jmespath/`). A bad expression, or one nested more
  than 500 levels deep, is `INVALID_INPUT` with its position in the fix, and so is
  any failure applying it, including building more than the `query.size` bound
  allows (`docs/bounds.md`); one that selects nothing is `data: null` plus a
  `SELECT_EMPTY` warning. No command may declare a `select` field.
- **`--output-format` and `--summary-file`** (`outputFormat` and `summaryFile` in every
  MCP tool's input) are core's too, in `src/core/output/`: `runCommand()` takes them
  off the input and shapes the envelope after `--select`, so `toil wait` and all
  three front doors get them with no per-area code. `toon` encodes only `data` (built
  in, TOON 4.4, held to the spec's fixtures in `test/fixtures/toon/`) and sets
  `meta.format`; `summaryFile` writes the whole of `data` as JSON through `ctx.files`
  and puts a summary chosen by fixed rules in `data`, said in `meta.summary`
  (`skills/toil/core.md`, **Big results**). Without them the output is byte for byte
  what it was. No command may declare either field.
- **`meta.warnings`** carries things worth saying that aren't failures (a reserved
  config key, a truncated result), from config loading or a command's `ctx.warn()`.
  **`meta.page`** is `{ nextCursor, limit }`, set with `ctx.setPage()` by any command
  that pages. Both are absent when empty. **`meta.response`** is `{ status,
  contentType }`, set with `ctx.setResponse()` by `<area> api`, whose `data` is the
  body as the service sent it. **`meta.transition`** is `{ intent, transition,
  toStatus, resolvedBy }`, set with `ctx.setTransition()` by a transition asked for
  by intent (`--to review`, `src/core/transition-intent.ts`). **`meta.lint`** is
  `{ engine, rules }`, set with `ctx.setLint()` by the `db` commands that run caller
  SQL (the `databases` skill).
- **`meta.context`**, on area commands only, says where the call acted: `{ dossier,
  connection, inputs, shared }`. `dossier`, when one applied, names it, where it
  lives, what chose it and how the folder matched it. `connection` and each of `inputs` is `{ value, source }`
  (`connection` also carries `deployment` for an area whose `variants` are keyed on it), the
  source one of `input`, `file` (a value the command read from a file the call
  named, through `ctx.supply`), `dossier`, `git`, `connection` or `default`, plus `via` (the
  input that selected the connection), `host` (the dossier's host selector that did)
  or `default` (`named`, `area-name` or `only`).
  `shared` lists settings taken from another area's connection, with where each
  lived, never the value. It's set on a failure too, as far as resolution got.
- **Every command has a time limit and can be cancelled.** `execute()` aborts at
  `TOIL_TIMEOUT_MS` (default 120 s, or a longer `timeLimitMs` the command declares;
  `TOIL_TIMEOUT_MS`, when set, overrides both) with `TIMEOUT`, and on Ctrl+C or an
  MCP cancel with `CANCELLED`. Commands pass `ctx.signal` to anything long-running that isn't
  `ctx.fetch` (which already carries it). A request that must still go out after
  the abort (asking a server to stop a statement, closing a session the command
  opened) uses `ctx.cleanupFetch`: the same recorded fetch without the signal, each
  request with a timeout of its own. Aborting stops toil waiting, not the
  server: for a write command both errors say the change may already have been
  applied, and to check before retrying. Never word them as "stopped" for a write.
  `toil mcp` exits on the first Ctrl+C. **`toil wait`** is the one command whose
  limit is its own `--timeout` (default 30 m, or `TOIL_TIMEOUT_MS`), capped by
  `"wait": { "maxTimeout" }` in config (default 1 h); it repeats only reads, at
  least 5 s apart, and each attempt is its own `execute()` with its own audit line.
- **Error codes are an open set.** New codes may appear in any release; callers
  branch on the ones they know and treat the rest as a generic failure. Removing or
  repurposing a code is breaking.
- **There is no `--dry-run`.** It was dropped as low value for its complexity: it
  could only intercept HTTP writes, and showed only the first of several. Writes
  are governed by the two-step gate under **Writes** and nothing else.

## Configuration Precedence

Config is a set of named **connections**, each one instance of an area's service
(`"corp-jira": { "area": "jira", "baseUrl": ... }`), plus per-area **defaults**
(`"defaults": { "jira": { "connection": "corp-jira", ... } }`): `connection` names
the area's default connection, and any other key is shared by every connection to
that area. A value on a connection resolves from, highest first:

1. `TOIL_CONN_<NAME>_<KEY>`, for that connection
2. `TOIL_<AREA>_<KEY>`, for the area's default connection only
3. A well-known CI-provided variable the area declares (`fallbacks`), for its default
   connection, only where the service's own tooling treats it as canonical
   (`GITHUB_TOKEN`, `SYSTEM_ACCESSTOKEN`). Never invent one. Where one deployment of an area
   shouldn't take it, the area says so (`fallbackWhen`): Azure Pipelines' job token fits Azure
   DevOps Server, and an Azure DevOps Services default never reads it.
4. The connection in `~/.toil/config.json`, or the file passed with `--config`. A
   secret there must be a `keychain:<ref>` reference to the OS credential store,
   read when the connection is resolved; a plaintext secret in a file is refused
   (**Secrets**)
5. `defaults.<area>` in that file
6. The area's provider defaults (`defineArea({ defaults })`, e.g. a port)

Each call uses one connection: `--connection`, otherwise the area's default (named in
`defaults`, else the one named after the area, else the only one). Several and no
default is an `INVALID_INPUT` with a fix, never a guess. `TOIL_CONN_<NAME>_AREA`
creates a connection with no file at all, which is how CI defines one; an area with
no connection gets one named after it from `TOIL_<AREA>_*`. Connection names are
lowercase letters, digits and single hyphens, so each maps to exactly one env form;
variables match the longest connection name first, and one naming no connection is
a warning, as is a connection for an area toil doesn't have. Env-only connections are
created before an area's default is chosen, so `TOIL_CONN_CI_AREA=jira` plus
`TOIL_JIRA_TOKEN` is one connection. Env values stay strings until the area's schema types them (`"5432"` to a number,
`"true"` to a boolean only where the schema says boolean), keys
an area doesn't declare are dropped with a warning, and renamed keys still work, with
one; with both names set, the higher tier wins (an old env var over a new name in the
file), and the new name wins a tie.

CI must be able to override anything without editing files. Lowering env-var priority
for any field is a breaking change. Anything that rewrites the global config carries
through keys it did not prompt for.

**There is no repository-level config file, and there won't be one.** Anyone who
can push to a repo, or an agent editing the working tree, could use such a file to
switch on writes or send the user's credentials to a host of its choosing
(*principles 2 and 9*). Hosts to talk to, credentials and `writes` come only from env
vars and the user's own config.

Knowledge about a body of work (its repos, Jira keys and fields, boards,
environments) belongs in **dossiers** (`docs/dossiers.md`). A dossier holds no secret
and no `writes`, and it can't create a connection: it only selects among the reader's
own connections, by name or by a host that toil uses purely as a selector and never
contacts. That's why a dossier may be checked into a repository when config may not.

Env var names map onto areas through the registry, using the longest match, so
`TOIL_FOO_BAR_TOKEN` is `foo-bar.token`, not `foo.barToken`. The
names of an area that was folded into another (`TOIL_JIRA_CLOUD_*`, `TOIL_CONFLUENCE_CLOUD_*`, `TOIL_BITBUCKET_CLOUD_*`, `TOIL_ADO_CLOUD_*`, `TOIL_CONN_<NAME>_AREA=jira-cloud`)
are refused with `CONFIG_INVALID` naming the new form (`TOIL_JIRA_*` with
`TOIL_JIRA_DEPLOYMENT=cloud`), never mapped and never ignored (`src/core/renamed-areas.ts`). A `TOIL_*` name
that matches no registered area is ignored, never guessed at, so a variable can't
change meaning when an area is added. `envName()` and `parseEnvName()` in
`src/core/config.ts` are the only places the mapping lives. These names are reserved
and never map onto an area: `TOIL_CONN_*`, `TOIL_DOSSIER*`, `TOIL_ENV`, `TOIL_CONFIG*`,
`TOIL_TIMEOUT_MS`, `TOIL_WORKSPACE`, `TOIL_FEEDBACK_URL`, `TOIL_THEME`, `TOIL_STRICT_ENV`.

**The config file is versioned.** `"version"` is a whole number; a file without one
is version 1. Every format change adds a step to `migrateConfig()` with a test, so an
old file always loads. A file from a newer toil is refused with an upgrade fix rather
than half-read. Version 1 is a map of area to settings and reads as one connection
per area, named after it and set as its default. Version 2 holds `connections` and
`defaults`; using them needs `"version": 2`. Version 3 (#495) folds `jira-cloud` into `jira`, `confluence-cloud` into `confluence`, `bitbucket-cloud` into `bitbucket` and `ado-cloud` into `ado`:
a connection with `"area": "jira-cloud"` reads as `"area": "jira", "deployment": "cloud"` (likewise confluence, bitbucket and ado)
and `defaults.jira-cloud` folds into `defaults.jira`. The fold runs for every version and is idempotent, so a version 3 file that still names a folded area (written before that area was folded) folds too, with a `CONFIG_RENAMED_AREA` warning; an older file is migrated on load and
rewritten as version 3 by the commands that save config. Standalone and area-local commands
(`version`, `jira issue schema`) don't load config at all, so a broken or newer file can't stop a user finding out which
toil they have.

## Writes

*Principle 2.* Every command that changes something outside the local machine —
creating or transitioning an issue, commenting on a PR, writing a row — needs both:

1. `writes: true` on the connection the call resolves, set by a human, and
2. `--allow-write` on the call.

Without either, the command fails with a `ToilError` naming the missing one and the
connection. `writes` is per connection, so writes can be on for a sandbox and off
for production; it is never read from `defaults.<area>`. Env vars can enable writes
for CI (`TOIL_CONN_<NAME>_WRITES=true`, or `TOIL_<AREA>_WRITES=true` for the
default connection), following normal precedence.
Deletes are never exposed through MCP: a delete command sets `mcp: false`, and the
raw passthrough refuses a `DELETE` over MCP (`offMcpWhen`). A delete is a command
that sends an HTTP `DELETE`; a removal the service takes another way (Jira removes a
label with a `PUT`) is a write like any other, so the same verb (`unlabel`) can be on
MCP in one area and off it in another.

Writing files on this machine outside toil's own config counts as a write too: the
`skills` commands that install into or switch plugins in an agent's skills folder
need `writes: true` on the marketplace's connection and `--allow-write`. A CLI-only
write (`skills marketplace add`, which clones) has no connection yet, so it needs
`--allow-write` alone. CLI only isn't human only: an agent with a shell can run it,
so `add` leaves writes off and installs nothing. Writes go on the way every
connection's do (`docs/bounds.md`, `skills.folders`).

The one exception to "`add` installs nothing" is `toil skill install` (the
maintainer's decision on #205): CLI only, with `--allow-write` alone, it installs
the toil skill into one agent's skills folder. That is safe to allow without a
connection's standing opt-in because its contents are fixed, the files embedded in
the bundle, with no third-party code, and it replaces only a `toil/` folder recorded
as `bundled`; any other folder of that name is refused.

toil writes outside a command's own gate in exactly two places, both the
maintainer's decisions:

1. **The welcome menu's game save.** toil's own config file is written only by the
   commands that manage it, except that the game saves its progress under the
   reserved `"game"` key (`src/welcome/rogue/save.ts`), keeping every other key as it
   was, and touching nothing else.
2. **The bundled toil skill's rewrite** (#205, `src/skills/bundled.ts`). It writes
   only a `toil/` folder recorded as `bundled` in an agent's skills folder, never a
   marketplace or untracked skill; only when the config file changed during the
   command, or the bundled copy was written by another toil version; from any
   command that loads config, on the CLI or over MCP, with no `--allow-write`. It's
   safe because the contents are fixed, the files embedded in the bundle; the only
   generated part, the description, holds area and engine names checked against the
   registry and `^[a-z0-9-]+$`, never a host or a credential; and a failure is a
   warning, never a failed command.

No other code writes outside a command's gate; a third exception needs this rule
changed first.

**`toil feedback` is the one write to a service with no connection** (#265). It
sends a bug report or feature request to Imagile's feedback endpoint, which files a
public GitHub issue, so it has no connection to hold `writes: true`. Its gate is the
approval of each report: `--consent`, or `yes` typed at a terminal after the report
and the disclaimer are shown; without one it sends nothing and returns the report.
It is CLI only, runs through the API only for a `person` whose `yes` approves it
(never a `consent` field, and only a preview under `readOnly`), sends only what the
caller typed plus toil's version and commit, and goes nowhere but the endpoint in
`src/feedback/consent.ts` or a loopback `TOIL_FEEDBACK_URL`. The bounds are
`docs/bounds.md`, `feedback.send`; the agent's steps (scrub, show, ask, then send)
are `skills/toil/core.md`, **Feedback**. The user-facing statement of the exceptions, with how to avoid each,
is `skills/toil/core.md`, **Writes**.

Anything toil encrypts says what the encryption protects against, in the code and
the docs: the game's save is sealed against tampering, not kept secret, and says so.

## The command contract

*Principles 4 and 7.* `docs/command-contract.json` is toil's record of every
integration command: its path and aliases, positional arguments, flags with their
values and defaults, and the field names of the `data` it returns
(`docs/command-contract.md`). With each area's brief, issue, docs and tests, it is the
specification: the requests a command sends, whether a call succeeds or fails, the
error, and the `data` it returns. Toil's unit suite has never met a real server, so
an integration that "fixes" what looks wrong is guessing, and it silently breaks
callers who rely on the recorded result.

- **The behavior is recorded; the surface is toil's** (*principle 10*). An
  area reshaped to the command shape records its new paths, arguments and flags in
  the contract, in the same change, and keeps every recorded request, result, error
  and `data` field. A path or flag the contract recorded before the reshape is gone, not
  aliased, and needs no divergence entry. The area's entries may be rebuilt from the
  registry only in its reshape PR, before the first beta, and that PR
  carries the old-to-new table of every path and flag for review: a contract rebuilt
  from the code can't catch what the code dropped, so the table is the check. From
  the first beta on, a reshape changes paths users rely on, so it's a breaking change
  under principle 7: declared, and with the old path kept, with a deprecation
  warning, for at least one beta where practical.
- **Implement the recorded behavior exactly, bugs included,** until a live instance
  proves otherwise. That covers validation, defaults, paging, id-or-name detection,
  encoding and error messages too, not just the happy path.
- **Suspected bugs are recorded, not fixed.** Each integration has one issue labelled
  `suspected-bug` (`Suspected bugs to verify: <name> (`<area>`)`). The integration appends
  anything new it finds there, with where, what, why, confidence, the observable
  change if fixed, and a live check. Tests pin the recorded behavior and say it's
  a suspected bug.
- **A divergence is a documented difference from the contract.** Each one is an
  entry in `docs/divergences/<area>.json`: what the contract records (`old`), what
  toil does instead (`toil`), why, and the principle that requires it.
  `test/contract.test.ts` checks every registered command against the contract and
  fails on any difference no entry allows.
- **Two kinds of change are allowed.** One is a change another principle or the
  Output Contract requires, such as a credential reaching a host the user didn't
  configure, or a path an agent passes reaching toil's own credentials. It's made at
  once and listed as a divergence, naming the principle.
  The other is additive output the contract already allows (a new `data` field,
  `meta.warnings`, `meta.page`).
- **The first live run checks every item** in the area's issue. A confirmed bug is
  fixed as a declared change (`fix:` or `feat:`, and `feat!:` when it changes a
  contract principle 7 lists, per Delivery) and listed as a divergence; a refuted one is closed.
- **A work-item integration's change inspects its Open Work Item mapping in the same
  PR** (`integrations` skill, **Open Work Items**).

## Testing

Tests never need the network: a developer offline gets the same result as CI.

Repository hygiene has its own suite, `test/repo-hygiene.test.ts` (see Delivery).

- **Mock HTTP with `fakeFetch`** (`test/harness/fake-fetch.ts`), injected through
  `Context.fetch`. Routes match on the method and the full URL, or on the method,
  `path` and `query` (in any order). A request with no route throws, so a test can't pass against a
  real server by accident. Every integration test asserts both sides: the exact
  request toil sent (method, URL, headers, body) and how the canned response was
  reshaped. Build contexts with `testContext()` (with `secrets: fakeStore()` and
  `prompt: scriptedPrompter()` for commands that use them); run the real CLI in-process with
  `runCli()`; connect a real MCP client over an in-memory transport with
  `connectMcp()`.
- **Canned responses are shaped like the real API**, captured from a live instance
  where possible and sanitized to placeholders (see **Placeholders**). A response
  invented from the docs is labelled as such in the fixture.
- **The CLI and MCP stay 1:1 because `test/parity.test.ts` proves it.** It walks
  every registered command, one suite per area, and checks:
  - one tool per command, with an identical, strict JSON Schema
  - every input field reachable from the CLI and vice versa, and set by at least
    one example
  - for every example, identical envelopes, HTTP requests and operations (the log
    of traced non-HTTP calls, such as the db area's provider) through both front
    doors; only GET/HEAD/OPTIONS from a command that doesn't write (plus POST from
    a read marked `queryByPost`, such as a search whose query may be too long for
    a URL), and no traced write operation. A token exchange core makes for the
    area (`watchTokenExchanges` in `src/core/token.ts`) doesn't count against a
    read, and the token cache is cleared before each CLI and MCP run, so both
    exchange and send the same requests
  - an unknown field refused as `INVALID_INPUT` on both sides before any request
  - a config failure building the context gives the same envelope on both sides
  - per area with a command that takes a connection, `--connection <name>` and
    MCP's `connection` field selecting the same connection, and an unknown
    connection refused the same way
  - for every write command, the write gate holding on both sides

  New commands are covered on registration; never add a command without examples,
  and never exempt one from this suite. The only exclusion is `cli-only` commands,
  which aren't MCP tools; the suite finds them by their `kind` and proves MCP never
  serves them. Every alias is run against its command's MCP tool too. When changing the harness, prove the suite
  still bites: break the mapping on purpose and watch it fail.
- **Each area has a fixture**, `test/fixtures/<area>.fixture.ts`, exporting
  `defineFixture({ area, routes, config })`: canned responses for every request its
  examples send, a config keyed by area (read as one connection named after the
  area, as if set by `TOIL_<AREA>_*` env vars) with credentials set and writes on,
  and any local `files` the examples read. Local state (a seeded database) is made in
  `setup` and removed in `teardown`, never at import, and an area that isn't HTTP
  names what to `trace` for the operations log. The suite finds a fixture by file
  name and fails when a registered area has none.
- **Four more suites cover every area with no per-area code:** `test/contract.test.ts`
  (the command contract's commands, flags and output field names, see the
  `integrations` skill), `test/skills.test.ts` (a `skills/toil/<area>.md` with
  frontmatter, naming every command, every env var, every CI fallback and the area's
  supported versions; and across the whole skill, every `toil …` it shows and every
  flag in a command table row is real), `test/fallbacks.test.ts` (each declared CI fallback in its
  precedence position, through the real config loader), and
  `test/site-commands.test.ts`, which writes `site/src/data/commands/<area>.json` and
  `site/src/data/settings/<area>.json` for the docs pages (`npx vitest run -u` after
  changing a command or a connection key) and checks the board's
  `site/src/data/integrations/<area>.json` and the levels in
  `site/src/data/levels.json`.
- **`test/util-docs.test.ts`** holds `skills/toil/util.md`, which `/docs/utilities/` renders, to the registry: a `util` command added or changed updates it in the same PR (`docs/util.md`). **`test/site-docs.test.ts`** fails when a docs page carries reference prose that isn't rendered from `skills/toil/`.
- **No file every integration edits.** Each area has its own fixture, skill file, divergence
  file, board entry and command list; the lists that span areas (the registry, the
  areas in `SKILL.md`, the CLI-only commands) are derived or generic. A change that
  makes parallel integrations edit one shared file is a review finding.
- `test/fixtures/demo-commands.ts` holds test-only commands (a read and a write
  against a fake API) that exercise the harness before real integrations exist, and
  `demo-context-commands.ts` a test-only area that uses context inputs, a setting
  shared from `demo`, a cross-group alias and every typed flag. They're never
  registered in the shipped CLI.
- Database testing, including the local Docker run every provider PR needs, is in
  the `databases` skill.
- Fixtures use placeholder hosts.

## Code Comments

Comments explain *why*, and they're also the one place toil is allowed to be funny.
The voice is deadpan bureaucratic satire: the flat, mock-official tone of a compliance
notice, aimed at the paperwork toil exists to route around. For example:

```ts
// Approval to spawn a process requires a change ticket, a CAB slot and a
// sponsor who has since left the company. We skipped the queue by never asking.
```

- **The explanation comes first and stands alone.** Delete the joke and the comment
  still tells the next engineer what they need. A joke never replaces a reason.
- **Aim at the bureaucracy, never at people.** Not at users, their employers, a real
  company or vendor, a colleague, or the reader. Stand-ups, CAB, RACI matrices,
  spreadsheets of record and tickets about tickets are all fair game.
- **One dry line, not a bit.** Understatement over exclamation marks; no emoji, no
  "lol". Most comments have no joke, but **every new module carries at least one**,
  usually in its header comment or beside the decision most worth explaining. A
  module that ships without one is a review finding.
- **Comments only.** None of it goes on the site, in `--help` text, error messages,
  `fix` hints, the JSON envelope, MCP tool descriptions, docs, skills, commit
  messages or PR descriptions. Those are read by people mid-task, or by models
  choosing a tool, and both deserve a straight answer. The site keeps its own,
  gentler register (see the `site` skill).

## Placeholders

Never commit a real hostname, tenant ID, account, or connection string from any
environment — not in code, tests, docs, issues, or PRs. Self-hosted services use
`<service>.imagile.dev`; SaaS keeps the vendor domain with `imagile` as tenant, unless
the vendor answers for every subdomain (Atlassian, Dynatrace), where any tenant name is
a real host someone could register: those use `<service>.imagile.dev` too; opaque
IDs use `abc12345` or `abc12345-0000-0000-0000-000000000000`; email uses
`you@example.com`. Never add wildcard DNS to `imagile.dev`.

## Delivery

- Conventional Commits: `fix:`, `feat:`, `feat!:` with a `BREAKING CHANGE:` footer
  that says why and how to migrate. release-please builds the changelog from them.
  **From the first beta on, a change to a contract principle 7 lists is a `feat!:`
  with a `BREAKING CHANGE:` footer** (but see principle 7 on fixes while there are no
  CI users), and, where practical, keeps the old name
  working with a deprecation warning for at least one beta before removing it.
  The alphas used a plain `feat:` or `fix:` for contract changes, and their
  changelog entries stay as they are. Toil UI's screens and HTTP API and the
  welcome menu's look aren't contracts, so a change to them is a plain `feat:` or
  `fix:`.
- **Every major item starts with a GitHub issue, created before the branch.** Keep it
  concise: a short paragraph on what and why, and one "Done when" line.
  - **What counts as a major item:** the foundation, the site, the gateway,
    dossiers, **each integration area** (labelled `integration`) and **each database
    provider** (labelled `database`).
  - **What never gets its own issue:** individual commands or features inside an
    area. They're part of their area's issue, never sub-issues.
  - **Data Center/Cloud products** are one area with a `deployment` connection field,
    so one issue (Jira, Confluence, Bitbucket and Azure DevOps are all folded, and no
    `-cloud` area remains); `data-center` and `cloud` label work that touches only one
    deployment.
  - **Product labels, on every issue a person or agent files here:** `cli` for the
    published toil package (the CLI, the MCP server, `./api`, `skills/toil/`), `ui`
    for Toil UI (`ui/`), and both when it changes both. Repository tooling, the site,
    `functions/`, `infra/` and docs alone carry neither. Issues filed by the feedback
    backend (`from-website`, `from-terminal`) can't know which product they are
    about, so they're filed without one; whoever picks the issue up adds it.
  - **`deferred`** goes on any issue the maintainer calls "later" or "much later".
    A deferred issue records the problem and isn't planned in detail.
  - **PR links:** many PRs can serve one issue. They use `Refs #n`, and the PR that
    finishes it uses `Closes #n`.
- Branches: `kolatts/<issue#>-<description>`.
- **No npm release until every integration is built.** The release job is off until
  a maintainer sets the repository variable `TOIL_RELEASES` to `on`; until then
  there's no release PR, tag or publish. Turning it on is a human's call, made once
  the last integration merges. release-please then opens one release PR covering every
  commit since the start.
- **Releases** come from release-please (`.github/workflows/release.yml`): Conventional
  Commits on `main` become a release PR, and merging it, which is always a human's
  call, tags, publishes `@imagile-dev/toil` to npm with provenance, attaches the
  tarball to the GitHub release, and posts to Discord, loudly if the publish fails or
  a merged release PR is skipped and nothing is tagged (#536).
  Publishing uses the `NPM_TOKEN` secret until npm trusted publishing is configured
  for the package, then OIDC with no token. The release PR is opened by the Imagile
  Bot App, not `GITHUB_TOKEN`, so CI runs on it. The agent review skips it, because
  the App can't review its own PR; the human who merges it is the review.
- **Toil UI never releases ahead of the toil it needs.** Its tests run against toil
  from source, and `npm run verify:ui` and `ui/scripts/dev-real.mjs` run it on toil
  built from the checkout into `.scratch/toil` (#332), so `ui/` on `main` may already
  use commands the pinned toil doesn't have. A `toil-ui-v…` release goes out with or after the toil release that has them,
  and bumps `ui/package.json`'s exact pin in the same release PR. That PR can't point
  `package-lock.json` at a toil npm doesn't serve yet, so once toil publishes, the
  release workflow's `lockfile` job opens a PR that does; until it merges,
  `check:lockfile` fails other PRs and names the fix (#299).
- **Until 1.0, every release is a beta prerelease** (`0.1.0-beta.1`, then
  `-beta.2` …; the alphas, `0.1.0-alpha.N`, came before), marked as a prerelease on
  GitHub and published under npm's `beta` dist-tag. Until a stable release exists,
  `latest` also follows the newest beta, so a plain `npm install @imagile-dev/toil`
  gets the current beta rather than a stale first one; once 1.0 ships, prereleases
  only move their own tag. Going to 1.0 is a deliberate change to
  `release-please-config.json`, made by a human. A one-time `release-as` there
  forces a version; once that version is released, `test/release-workflow.test.ts`
  fails every run but the release PR's and the lockfile PR's until the override is
  removed, so the lockfile PR merges first and the removal after it.
- PRs are vertical slices (core → CLI → MCP → tests → skill doc), sized large enough
  to avoid process overhead, fully verified before opening. Use the `ship` skill, which
  reviews locally, fixes, turns on auto-merge where principle 2 allows it, and watches
  the PR until it merges or is ready for a human to merge.
- **Commit only what the change needs.** Before every commit, read `git status` and
  the staged file list, and leave out what's accidental: an empty file a shell
  redirect made (`{}`, `nul`), scratch scripts, logs, screenshots, local config.
  Scratch work goes in a temp folder outside the repo, never at its root.
  `test/repo-hygiene.test.ts` fails on an empty tracked file or an unexpected
  top-level entry. A new top-level file goes on its allowlist on purpose.
- From the first beta on, before changing behavior users rely on, check config
  already on disk, existing flags, the envelope, and precedence, and say what you
  checked in the PR.
- **Decisions an agent makes by default go in `docs/decisions/<issue#>-<slug>.md`**,
  one file per PR named after its branch, with what, why and where, so the maintainer
  can review or overturn them (`docs/decisions/README.md`). A PR writes only its own
  file, so no two PRs conflict on decisions. `AGENT_DECISIONS.md` is the frozen
  archive of everything before #361, still cited by code comments; never add to it
  (`test/repo-hygiene.test.ts` pins it). The maintainer's own decisions stay on the
  issues.
- **Fix every review finding in the round it arrives, non-blocking ones included**,
  with the simplest fix that is easy to understand. A finding left for later piles up
  another round; an elaborate fix makes the design harder to follow than the problem
  did. Defer one only when it's genuinely out of scope, or when fixing it would add
  complexity out of proportion to what it fixes (the maintainer's call, 2026-10-17).
  Either way, say so in its thread, and record the skip in the PR's decisions file.
- **The PR description describes the PR as it is now, not as it was opened.**
  Reviewers, the review bot and the squash commit all read it, so a description
  that lags the code misleads all three. Rewrite it (`gh pr edit --body-file`)
  after every review round you act on and every change in direction: what it
  does, what was verified and on what, test counts, and what's still open. Don't
  append a changelog of rounds; the commits and review threads already hold that.
- **Every PR carries proof a human can check of how it was verified locally**, not
  just the claim "tests pass". Include:
  - **The gate results**: the summary lines from typecheck, lint, test, build,
    `check:pure` and `smoke`, with the OS and Node version.
  - **Real runs**: the commands you ran against real things, with their output.
    That means the CLI, and the MCP server driven by a real agent client (the
    local Codex CLI), with the envelopes they returned, sanitized to placeholders.
  - **Databases**: for a database provider, its run against the engine in Docker
    (see the `databases` skill), including the image and tag.
  - **Screenshots** for anything visual: desktop and 375px (see the `site` skill).
  - **What wasn't verified**, said plainly, and why.

  Refresh the proof whenever the description is rewritten.

## Skills

CLAUDE.md holds only guidance that applies to every task: the principles and the
rules that are always relevant. Anything needed only for a particular kind of work
lives in a repo-internal skill under `.claude/skills/<name>/SKILL.md`.

- Keep the set to 4–8 skills. Fold new guidance into an existing skill before creating
  one, and split a skill only when it grows past a single coherent job.
- When a new rule arrives, decide first whether it is global (CLAUDE.md) or
  task-specific (a skill), and put it in exactly one place.
- Keep this index current: one line per skill, its name and when to use it.

| Skill | Use when |
|-------|----------|
| `integrations` | Adding or changing an enterprise integration: the command shape, the Authentication Bar, verification levels, Data Center and Cloud deployments of one area, the site docs review, Open Work Item checks for work-item areas, the command contract and its divergences |
| `databases` | Working on the `db` area, a database provider, or database tests, including the local Docker run |
| `code-intelligence` | Someone proposes code navigation or a language-analysis dependency: small pure-JS code intelligence is welcome, heavy analysis dependencies are ruled out, and what reopening that takes |
| `mcp` | Changing `toil mcp`, tool registration and descriptions, transports, or the MCP gateway |
| `secrets` | Storing, resolving, moving or logging a secret; the OS credential store |
| `automation` | Editing workflows under `.github/`: the review agent, the fix agent, issue triage and its daily cap, the feedback deploy, action pins, Discord notifications, redaction |
| `site` | Changing anything under `site/`, or the mark and wordmark it shares with the terminal splash and menu in `src/welcome/` (the site wears Plain's palette; the terminal defaults to Crate): responsive rules, palette, the mark and its motion, the wordmark, art, status honesty, screenshots |
| `ship` | Opening, updating or shepherding a PR: local reviews in parallel (gate, code, docs, principles, and screens when a screen changes), fixing all but principle findings, and the four-minute PR watch that replaces the app's Auto-fix |

## Cloud Cost

No standing cloud resources without approval. Anything this repo provisions states its
monthly cost in the PR, and trial infrastructure is torn down in the same change.
