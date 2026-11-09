# Seamless AI helper installs and wider Toil project cards

Branch: `kolatts/ui-maintainer-updates`

- **Install also installs the vendor's CLI where npm ships one as a Node script (Copilot only).**
  What: `CLI_PACKAGES` in `ui/server/agents/tested.ts` pins `@github/copilot@1.0.100`; Install adds it to the same
  npm command as the SDK, and a global install keeps optional dependencies for it (they hold the CLI's platform
  build). Why: the maintainer asked for installs that work in one press (2026-11-05); on a machine where VS Code's
  `copilot.bat` launcher was the only `copilot` on PATH, the SDK was installed but the helper could not start, and the
  only advice was to set a path to a `copilot.exe` that did not exist. Where: `install.ts`, `runtime.ts` (`cliFor`
  falls back to the installed package's `npm-loader.js`; a path set in Settings still wins), `cli.ts` (every shim on
  PATH is tried, and a launcher script gets a fix that says to press Install).
  This widens principle 1's exception (toil UI never downloads a CLI) to one pinned, 14-day-old, shown-first,
  `--ignore-scripts` npm package pressed by a person. Claude and Codex are unchanged: their CLIs are installed by
  their vendors' own installers, and both were already found on PATH. Overturn by removing `CLI_PACKAGES`.
- **The Install button shows when the SDK is installed but the CLI is unusable and an install would supply it.**
- **Toil project cards are one size.** The lead card no longer spans two columns; the grid minimum is 24rem, so each
  card gets the room the lead card had (about 480px at 1024px wide).

Verified: installed all three helpers through the Settings dialog in a clone's scratch home and asked each one the same
question through `/api/agent/ask`; each answered from the synced cache. Not verified: `npm run verify:ui` (it stops on a
missing screenshot folder before reaching the adapters), and Copilot's install on macOS or Linux.

## Install dialog and organization registries (Artifactory)

- **The dialog says what it does.** Before anything runs it lists what will happen (each package, where it lands, the
  14-day and no-install-scripts rules), what it won't do (sign in, store a credential, change PATH or npm settings),
  and the exact command; afterwards it lists what changed and the step still the person's (signing the helper in).
- **A failed install offers a registry helper** (`ui/src/registry-help.tsx`, `ui/server/agents/npmrc.ts`,
  `POST /api/agent/npm-registry`). Many users sit behind Artifactory. It explains the symptoms (can't reach
  registry.npmjs.org, 401/403/404), takes the registry address, and on a press writes one line, `registry=<url>`, to the
  user-level npmrc (`npm_config_userconfig`, else `~/.npmrc`), keeping every other line, and shows the file and what the
  line said before. It refuses an address with a username, password, query or fragment, never reads or writes an
  `_authToken`, and tells the person to run `npm login --registry <url>` themselves (principle 2: only a person enters
  a secret). This is a second place Toil UI writes outside toil's own files, on a press; overturn by removing the route.
- Verified: unit tests for the file edit, a view test of the failure path, and the real route against a scratch npmrc
  (a credential line survived; a URL with a password was refused). Not verified: a real Artifactory.
