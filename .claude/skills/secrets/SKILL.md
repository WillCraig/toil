---
name: secrets
description: Rules for how toil stores, resolves and moves secrets (API tokens, passwords, connection strings, any credential). Use when changing `toil connections add`, `login`, `list` or `remove`, `keychain:` references, the OS credential store in src/core/keychain.ts (macOS `security`, Windows PowerShell advapi32, Linux `secret-tool`), the plaintext-secret check in connection resolution, the terminal prompter, or any code that reads, writes, migrates or logs a secret. Also when changing `connections import`, which carries no secret, or adding `config init` or `config set`, which follow the same rules.
---

# Secrets

**A secret comes from the OS credential store or an env var, never from a file.**
A secret key on a connection (one an area lists in `defineArea({ secrets })`)
resolves from, highest first: its env var (`TOIL_CONN_<NAME>_<KEY>`,
`TOIL_<AREA>_<KEY>`, or a CI fallback), then a `keychain:<ref>` reference in the
config file. A plaintext value in the file is refused with `CONFIG_INVALID`; see
**Rules**. Config therefore holds nothing worth stealing, so a command that reads
or uploads files can't leak a credential through `~/.toil/config.json`.

`toil connections add <name>` and `toil connections login <name>` read the secret
hidden (one `•` per character, never the characters; **Reading a secret** below)
and put it in the store, writing only `keychain:<connection>.<key>`
to the config file. There is no `--plaintext`. Env vars are the path for CI,
containers and machines with no store (headless Linux without `secret-tool`).
Anything added later that writes secrets (`config init`, `config set`) does the
same, and a future `config import` must move every token it reads into the store.

## The store

`src/core/keychain.ts` is one of the few modules in toil allowed to spawn a
process, the reviewed list in `scripts/spawners.mjs` (**No Executables** in
CLAUDE.md); the others are git's, `src/core/git.ts`, and Windows authentication's
SSPI helper, `src/os/windows-sspi.ts`, which receives a domain account's password
from this store on stdin, never argv.
It runs only what the OS ships, each behind a platform check, under the service
`toil` with the reference name as the account:

| Platform | Program | Store |
|----------|---------|-------|
| macOS | `security` (`-i`, secret hex-encoded on stdin), run with `HOME` set to the account's home from the user database, since it finds keychains under `$HOME/Library` | login Keychain |
| Windows | `powershell.exe` (`pwsh` if absent), a constant script calling advapi32 `CredRead`/`CredWrite`/`CredDelete`, request as JSON on stdin | Credential Manager, target `toil:<ref>` |
| Linux | `secret-tool` | Secret Service (GNOME Keyring, KWallet) |

- Secrets travel to the store's process on stdin, never argv. Nothing is spawned
  through a shell; arguments are an array of fixed strings and a reference name
  checked against a strict pattern first.
- The store is asynchronous and takes the command's signal. A read happens inside
  `execute()`, under the same time limit and cancel as the command, and never
  blocks the event loop, so a hung store can't freeze `toil mcp`.
- The real spawner is not exported. The only way `keychain.ts` spawns is a store
  from `createSecretStore`, which runs a fixed program; a general-purpose spawner in
  `keychain.ts` would let any module spawn while the gate still passes.
- The spawner is injectable (`createSecretStore({ platform, spawn })`). Unit tests
  stub it for every platform, and `test/harness/fake-store.ts` stands in for the
  store in command tests. **No test in `npm test` touches a real store**; the
  one suite that does lives in `test/live/` and runs only on its own (below).
- `testOnlyProgram` runs Node in place of the store's program through the real
  spawner, so tests prove the secret arrives on stdin byte for byte, arguments
  arrive literally with no shell, and an abort ends a hung child as `CANCELLED`.
  `src/cli.ts` never passes it.
- Area code can't import `core/keychain` or `core/prompt` (ESLint); it gets secrets
  already resolved on `ctx.connection`.
- Where no store is available, a write fails with a `CREDENTIAL_STORE` error whose
  fix names `TOIL_CONN_<NAME>_<KEY>`.

## Rules

- **A plaintext secret in a config file is refused.** `resolveConnection`
  (`src/core/connection.ts`, `refusePlaintextSecrets`) checks it, because that's
  the first point where the area's `secrets` are known; the loader doesn't know
  area schemas. A value counts as from the file unless `config.sources` says `env`
  or `ci`, so connection keys, `defaults.<area>` and renamed (old-name) keys are
  all covered. The error is `CONFIG_INVALID`, its fix names
  `toil connections login <name>` and the `TOIL_CONN_<NAME>_<KEY>` /
  `TOIL_<AREA>_<KEY>` variables, and it never echoes the value. Non-secret keys may
  be plain text. `toil connections login` reads the raw file, so it is the way to
  move a plaintext secret left in an old file into the store.

- An unresolvable reference is treated as unset, never sent as a literal. The area
  then reports the key as missing, and `meta.warnings` carries
  `CONFIG_SECRET_UNRESOLVED` naming `toil connections login <name>` and the env var.
- Env vars still win (**Configuration Precedence** in CLAUDE.md): an env var replaces
  the stored value before references resolve, so the store isn't even asked. CI
  runners, containers and machines with no store configure entirely through env
  vars, which may hold plaintext because they never sit in a file.
- Commands never see the store. Only `defineConfigCommand` commands get it, through
  `ctx.manage`; an area command gets its resolved connection and nothing else.
- Anything that moves a secret leaves it in at least one place at every step:
  store it and read it back (`storeVerified`), then rewrite config, and only then
  remove the old copy (a plaintext value left in an old file goes with the
  rewrite; an old store entry is deleted after it, and only when nothing else in
  config refers to it).
- Config writes go through `writeConfigFile`: the current version (`CONFIG_VERSION`, 3), every key not prompted for
  carried through, written alongside and renamed into place, mode 0600 in a 0700
  folder where the platform has POSIX modes.
- `toil connections list` never prints a value except the host. It reports where
  each value came from: `env`, `ci`, `file`, `store` or `defaults`.
- The audit log (`src/core/audit.ts`) records every call's input and requests, so
  it redacts harder than `--verbose`: field names by the same rule `redactUrl` uses
  for parameters (except a bare `key`), every URL in a value through `redactUrl`, and
  every token-shaped run in any string. Those rules are `src/core/secret-shapes.ts`,
  toil's one definition of a secret: `redactText` hides what they match, and
  `findSecrets` reports where, so redacting and finding can't disagree. The token
  shapes themselves live in `src/core/token-shapes.mjs`, plain JavaScript, because the
  redactor for issues filed from outside (`scripts/triage/redact.mjs`, run by the
  feedback function and by triage) reads the same list. A new shape goes there, with
  a planted example in `src/core/secret-shapes.test.ts`, `src/areas/util/secrets.test.ts`
  and the `SAMPLES` in `test/triage.test.ts`; each fails until it has one. A field a command can't afford to keep goes
  in its `auditInput` (`drop`, or `hash` for SHA-256 only). `test/audit.test.ts`
  sends a token-shaped value through every input of every registered command and
  fails on any line that still holds it; keep it passing when adding a field.

## Prompting

Only the setup commands prompt, and only on a terminal (stdin and stderr both
TTYs); prompts go to stderr so stdout stays one envelope. Without a terminal they
fail with a fix naming the `TOIL_CONN_<NAME>_*` variables. They ask for exactly the
keys the area declares, secrets hidden, so a token area is never asked for a
username and password (the Authentication Bar in the `integrations` skill).
Setup commands are of kind `cli-only`: never MCP tools, since stdin is the protocol
there. An agent never enters or moves a secret or turns writes on; it may create a
connection with `connections add --area … --set key=value` on the person's yes, which
asks nothing, refuses a secret key in `--set`, stores nothing and names
`connections login <name>` for the person to run (#516), and import database connections
with `connections import … --save` the same way (#520). Where an area declares
`shares.offer`, `add` and `login` ask `borrow:<key>`: a yes writes `<key>From`, stores
nothing, and on `login` drops the connection's own reference, deleting the store entry
only when nothing else refers to it (#635). A secret an area declares as a
`password` (`defineArea({ secrets: { password: 'password' } })`) is asked for as one;
every other secret is a token.

`connections import` carries no secret: a password found in an imported file or URL is dropped and reported as `SECRET_NOT_IMPORTED`, and `.pgpass`, DBeaver's `credentials-config.json` and SSMS's encrypted passwords are never read.

**Reading a secret (#358).** The terminal prompter (`src/core/prompt.ts`) reads a
secret in raw mode with `HiddenLine`, not readline, and draws one `•` per character:
Backspace removes one, Ctrl+U clears the line, Ctrl+C cancels, and bracketed paste
is turned on so a pasted line break arrives as text, not Enter (a line break with
more text after it in one chunk is a paste too, for terminals that don't bracket;
one at a chunk's end is Enter).
The value is never echoed, logged, put in argv or written anywhere but the store.
Every secret then goes through `askCheckedSecret()` and `checkSecret()` in
`src/core/secret-input.ts`, the one definition of the paste checks, which the API's
`person` path and Toil UI's form use too, so they say the same words:

- surrounding whitespace is trimmed, and `Received N characters (removed …).` says
  so; the line gives the length only, never a prefix or suffix
- quotes, or a `Bearer ` / `token ` prefix, are asked about (`unwrap:<key>`), never
  removed silently
- a line break in the middle, or a space or tab in a token (a password may hold
  spaces), is refused: asked again on a terminal, `INVALID_INPUT` for a `person`
- an empty answer asks again where the secret is required (`add`), and says
  `Kept the existing secret.` where `login` keeps the stored one

## Verifying

The unit suite proves the invocations. `test/live/keychain.live.test.ts` proves
them against the real store: it logs a throwaway `demo` connection in through
the real CLI program, resolves its token from the store into a request, removes
it, and checks each side with the OS's own tool (`security find-generic-password`,
`secret-tool lookup`). `npm run test:keychain-live` runs it on your machine;
`.github/workflows/keychain-live.yml` runs it on macOS and Linux runners on every
PR that touches the store, connection resolution or `src/connections/`, and on
`workflow_dispatch` (`scripts/keychain-live.sh` starts the Linux keyring). Windows
isn't in it. Quote its `[keychain-live]` log lines in the PR.

A change to `keychain.ts` also needs a live round trip on the platform you're on, in the PR: add a throwaway connection with a
fake token against a temp `--config`, show the entry in the store and only the
reference in config, use it, remove it, and show the store is clean. Say which
platforms were not run.
