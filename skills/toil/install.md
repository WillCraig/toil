---
description: Installing toil from npm or from a clone with no npm install, the toil alias for a clone, trying unreleased changes from a clone, and installing this skill for Codex, GitHub Copilot or Claude Code
---

# Installing toil

## The shortest way: let your agent set it up

Three steps, the first two in a terminal:

```bash
npm install -g @imagile-dev/toil
toil skill install --claude --allow-write
```

`--claude` is for Claude Code. For Codex or GitHub Copilot, leave out `--claude`: the
default install is the one both read (**Installing this skill**, below, has the table). Then tell your agent: **Set up toil for me
with its setup skill.** It follows `setup.md`: it asks whether you want Toil UI,
proposes your connections for your yes and creates them, and leaves every secret to you,
typed in your own terminal or in Toil UI. The manual installs follow.

## Already installed?

Check first: if `toil version` prints an envelope with `"ok": true`, toil is installed
and nothing here is needed. If `toil` isn't found but a clone of the toil repository is
on the machine, `node <clone>/dist/toil.js version` is the same thing.

toil needs **Node.js 24.22.1 or later on 24.x, or 26.12.1 or later** (`node
--version`) and nothing else: no executable, no native module, no install script and
no admin rights. Those are the releases that fix CVE-2026-111497, a remote code
execution in Node's Brotli decoder, which every `fetch()` goes through. On any other
Node, 25.x included, every command returns `UNSUPPORTED_NODE`. Windows, macOS and Linux all work the same.

## From npm (recommended)

```bash
npm install -g @imagile-dev/toil
toil version
```

With no global install, `npx -y @imagile-dev/toil version` runs it on demand. Each
GitHub release also carries the packed `.tgz` for offline or mirrored installs:
`npm install -g ./imagile-dev-toil-<version>.tgz`.

**toil is beta: commands, flags and output are stable, and any breaking change comes
with a migration note.** Releases are published under npm's `beta` tag, which `latest`
follows until 1.0.

## From a clone, with no npm install

For a machine that can reach the git host but not the npm registry. Needs Node and
git. A person setting up their own machine can do it all in one command, which
builds the clone, adds the alias below and prints `toil version`
(the build runs `npm ci`; with no registry, add `--skip-build` to use the committed
bundle as it is):

```bash
git clone https://github.com/imagile-dev/toil.git && cd toil && node scripts/setup.mjs
```

Step by step:

```bash
git clone https://github.com/imagile-dev/toil.git
node toil/dist/toil.js version
```

`dist/toil.js` is committed with the bundle it runs, `dist/toil-lib.js`, and they are
the **last released toil**: each release rebuilds them, and nothing else changes
them, so they are the same files that release ships on npm.
Newer commits on `main` are in a clone's source but not in its bundle until the next
release. They import only Node's built-ins, so there is nothing to install.

To type `toil` instead of `node <clone>/dist/toil.js`, add an alias to the shell
profile, once:

| Shell | Run | Edits |
|-------|-----|-------|
| bash, zsh | `node toil/dist/toil.js setup alias` | `~/.bashrc` or `~/.zshrc`, by `SHELL` (`--shell bash` or `--shell zsh` to choose) |
| PowerShell | `node toil/dist/toil.js setup alias --profile $PROFILE` | The profile of the PowerShell you ran it in |

Then open a new terminal and run `toil version`. `--profile <file>` names any other
profile (macOS bash login shells read `~/.bash_profile`). The alias is a shell
function between two marker lines; nothing else in the file changes, and running it
again updates it in place. `node toil/dist/toil.js setup remove-alias`, with the same
flags, takes it out.

- **An agent's shell may not read the profile.** When `toil` isn't found there, run
  `node <clone>/dist/toil.js` with the same arguments; it's the same command.
- **Windows PowerShell's default execution policy runs no profile.** If `toil` isn't
  found after opening a new PowerShell, call `node <clone>/dist/toil.js` directly.
- **Update** with `git -C toil pull`, which brings the newest release. There is
  nothing to rebuild.

## Trying unreleased changes

`main` holds changes that haven't been released yet. To try them on your own
connections and toil projects before they ship, build them from a clone. This needs the npm
registry, for `npm ci`:

```bash
git clone https://github.com/imagile-dev/toil.git && cd toil
npm ci --ignore-scripts
node ui/scripts/dev-mine.mjs
```

- **It builds toil and Toil UI from the clone,** putting toil in `.scratch/toil`, which
  git ignores. Then it starts Toil UI on that build against your own `~/.toil`, and
  prints the URL to open. The committed `dist/` is left alone, so `node dist/toil.js`
  is still the last release.
- **It uses your config as it is.** Your connections, credential store entries and
  toil projects are used unchanged. Toil UI changes them only when you save something in
  Settings, and its reads go in toil's audit log as usual. `TOIL_*` variables in your
  shell apply as they do to `toil` typed by hand.
- **Toil UI keeps its own data in `.scratch/toil-ui`,** not `~/.toil-ui`, so an
  unreleased build never shares a cache with a released Toil UI. Its settings, such as
  the agent you choose, start fresh there.
- **The CLI from the same build** is `node .scratch/toil/toil.js`, with the same
  arguments as `toil`. It is the full CLI on your real config, the same as `toil`.
- **This build can replace your installed copy of this skill** with the unreleased
  version. It does that when it changes your config (from the CLI, or from Toil UI's
  Settings), and when it runs any command that loads config while your copy came
  from another toil version. To go back, run `toil skill install --allow-write` again
  from the released toil, with the same agent flags you installed it with.
- **Options:** `--no-build` starts the last build, and `--port <n>` fixes the port.
  `git pull` and run it again to get newer changes.
- **Unreleased means unfinished.** Anything on `main` may change before it's released.
  Report what you find with `toil feedback bug`.

## Installing this skill

toil carries this skill inside itself, so the copy it installs always matches the
toil that runs it. Install it once, for the agent you use:

```bash
toil skill install --allow-write
toil skill install --agent github-copilot --scope project --allow-write
toil skill install --claude --allow-write
```

| `--agent` | `--scope user` (the default) | `--scope project` |
|-----------|------------------------------|-------------------|
| `codex` (the default; GitHub Copilot reads it too) | `~/.agents/skills/toil` | `.agents/skills/toil` |
| `github-copilot` | `~/.copilot/skills/toil` | `.github/skills/toil` |
| `claude-code` (`--claude`) | `~/.claude/skills/toil` | `.claude/skills/toil` |

A project-scope copy describes your own config, so add the folder (for example
`.github/skills/toil/`) to `.gitignore`.

Project scope is the root of the repository you're in. Installing writes files
outside the workspace, so it's CLI only and needs `--allow-write`. Every reference
file is installed, so an area you set up later is already documented.

**The installed skill keeps itself current; there is nothing to update by hand.** The
description in the installed `SKILL.md` names the areas and database engines you have
connections for (names only, never a host or a credential), so an agent reaches for
toil when a task touches one of them. Any toil command that loads config, on the CLI
or over MCP, rewrites every copy toil installed when that command changed the config
file (`toil connections add`, `login`, `remove`, `writes`, `default`, `migrate`,
`import --save`, `toil skills marketplace add` and `remove`), and when the copy was written by another toil
version. Nothing else in a skills folder is ever touched. This is one of the writes
that need no `--allow-write`: `core.md`, under **Writes**, says why, and how to avoid
it. Connections that only `TOIL_*` env vars define are named when they're set in the
process that writes the skill, and the output says which. With no connections, the
description is the general one.

`toil skill show` (`skill_show` over MCP) prints the description toil would write now
and every installed copy, with its version and whether it's current.

toil only ever rewrites a `toil` folder it installed itself. One copied by hand, or
installed by a marketplace, is left exactly as it is, and `toil skill install` refuses
to replace it: move it aside first.

Other ways in, for agents toil doesn't write to:

- **Claude Code**, from the plugin marketplace in the repository:
  `claude plugin marketplace add imagile-dev/toil`, then
  `claude plugin install toil@toil` (or `/plugin marketplace add imagile-dev/toil` and
  `/plugin install toil@toil` in a session). From a clone, pass its path instead of
  `imagile-dev/toil`. This copy carries the general description, and toil doesn't
  keep it current.
- **Any installer that reads `skills/<name>/SKILL.md` from a git repository**: point it
  at `https://github.com/imagile-dev/toil`.

## Next

Connect toil to a tool: each area's file (`jira.md`, `db.md`, …) gives its credential,
its env vars and its config. To run toil as an MCP server, see `mcp.md`.
