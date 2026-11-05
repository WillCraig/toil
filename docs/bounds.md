# Bounds

A bound is a limit toil enforces on every command, whoever is driving it: a person at
a terminal, a pipeline, or an agent passing values it read somewhere. Each one exists
because a command handed the wrong value would otherwise do something nobody asked
for: send a credential to the wrong host, read a file it was never given, change what
it was only meant to read.

This page is the list. `src/core/bounds.ts` is the same list in code, and
`test/bounds.test.ts` fails when the two disagree: a bound in code with no row here,
a row here with no bound in code, or a row whose enforcement, errors or setting
don't match.

## Relaxing a bound

Only by a setting in the config file toil loads (`~/.toil/config.json`, or the one
`--config` names). No env var, flag, toil project or repository file sets a bound's
value, so neither a tool input nor a checked-in file can loosen what constrains
an agent (*principle 2*). Today one bound can be relaxed:

```json
{ "version": 2, "connections": {}, "bounds": { "files": "unbounded" } }
```

Any other key under `bounds` is `CONFIG_INVALID`, so a typo can't look like it
worked. While a bound is relaxed, every envelope carries a `BOUND_RELAXED` warning in
`meta.warnings` naming the setting and the file. `config check` will show it too,
once that command exists. **Security-class bounds can't be relaxed at all.**

## The bounds

| Bound | Protects | Enforced in | Errors | Relaxed by | Security class |
|-------|----------|-------------|--------|------------|----------------|
| `files.workspace` | Files outside the folder the user chose. Every path a command reads, writes, lists or stats resolves inside one workspace, checked after realpath so `..`, symlinks and junctions can't leave it. | `src/core/files.ts` | `INVALID_INPUT` (outside the workspace), `NOT_CONFIGURED` (no workspace) | `"bounds": { "files": "unbounded" }` | No |
| `files.own` | toil's own config and credentials: `~/.toil/` and the `--config` file. A command handed that path would otherwise send every connection's token to its own host. Holds with the workspace bound relaxed, for `--output-file`, for git metadata read above the workspace, and for a toil project file a call names (only `~/.toil/projects/`, and the old `~/.toil/dossiers/`, are open to that). | `src/core/files.ts`, `src/node-context.ts`, `src/core/git-config.ts`, `src/core/toil-project.ts` | `INVALID_INPUT` | No | Yes |
| `files.system` | `/proc` and `/sys`, where `/proc/<pid>/environ` holds the env vars that carry tokens. Holds everywhere `files.own` does. | `src/core/files.ts`, `src/core/git-config.ts`, `src/core/toil-project.ts` | `INVALID_INPUT` | No | Yes |
| `files.remote` | Other machines, reached through a path. A path a call names (a file, a folder, `cwd`, a toil project file) that starts with two slashes of either kind, a network (UNC) path such as `\\host\share\x`, or a Windows device path (`\\?\`, `\\.\`, `\??\`), is refused from its text alone, as typed and as resolved, before any file call: on Windows, even checking whether such a file exists opens a connection to that host. Holds with the workspace bound relaxed and for `--output-file`. The one network path allowed is one inside a workspace that is itself on a share; a device path never is. The same text is refused on every OS. | `src/core/local-path.ts`, `src/core/files.ts`, `src/core/toil-project.ts` | `INVALID_INPUT` | No | Yes |
| `files.no-overwrite` | Files already on disk. A write to an existing file is refused, bound relaxed or not; a read-only command's file name often comes from whoever uploaded it. A path segment Windows would read as another file is refused on every platform: a device name (`CON`, `NUL`, `COM1`, with any extension), a `:` (a stream inside an existing file), or a trailing dot or space. The `*download` commands save such a name as one that's safe (`_CON`, `notes.md` for `notes.md:hidden`), so the check sees the file the write lands on. | `src/core/files.ts` | `INVALID_INPUT` | No | Yes |
| `credentials.host` | Credentials reaching a host the user didn't configure. Every request is built from the area's request hook and the connection's `baseUrl`; a URL on another origin is refused before anything is sent. A redirect to another origin is refused, whatever the auth header; a GET may opt into following a signed download URL with every header dropped. A server-supplied URL on another host is re-pointed at the configured one with `repointUrl`, with a warning. A token exchange goes only to the connection's origin, or over HTTPS to a host under the vendor domain the area names in its code. A raw API call (`<area> api`) takes only a path: a full URL, a scheme, `//host` or a leading backslash is refused before anything is sent. | `src/core/api.ts`, `src/core/rest.ts`, `src/core/passthrough.ts` | `HTTP` (another origin, a redirect away), `AUTH` (a token host off the connection), `INVALID_INPUT` (a raw API path that names a host) | No | Yes |
| `requests.path` | The endpoint a command names. A request path with a `.` or `..` segment, in any spelling the URL parser collapses (`%2e`, or one a tab, newline or trailing control character or space hides, which the parser drops first, or a `;params` suffix such as `..;x`, which servlet containers like Tomcat and Jetty strip before resolving dots), is refused before anything is sent, so an id of `..` can't turn `items/<id>/delete` into a request to another endpoint on the same host. A dot inside a segment (`v1.2`), or a `;` after anything else (`v1;rev=2`), is left alone. An encoded slash (`%2f`, `%5c`, either case) ends a segment for this check. Areas build paths with `apiPath`, which encodes every id as one segment, and context inputs that land in a path refuse `/`, `\`, `?`, `#`, `%` and control characters however they arrive; as a backstop, a relative path holding a `#`, or a `?` when the request also has query parameters, is refused before anything is sent. | `src/core/api.ts`, `src/core/rest.ts`, `src/core/api-path.ts` | `INVALID_INPUT` | No | Yes |
| `secrets.storage` | Secrets sitting in a file. A secret comes from the OS credential store or an env var; a plaintext one in config is refused. | `src/core/connection.ts` | `CONFIG_INVALID` | No | Yes |
| `commands.cli-only` | Commands that prompt a person or change connections, and area commands marked `mcp: false` (deletes). They're never MCP tools, so an agent can't call them, and `execute()` from `@imagile-dev/toil/api` refuses them too, except the five connections commands and `toil projects onboard`, which a program runs for a person it passes as `person`, whose answers that person typed in the program's own interface (`connections add`, `login`, `remove`, `writes`, `default`; turning writes on still needs the typed name; `toil projects onboard` adds a connection only through `connections add`'s own questions). An agent's shell may run `connections add --area … --set key=value` on the person's yes: it asks nothing, refuses a secret key, stores no secret and leaves `writes` off (#516); and `connections import … --save` likewise, which creates only `db` connections, never over an existing name, drops every password it finds and names `connections login` for each (#520). A call that a served tool marks CLI only (`offMcpWhen`: a `DELETE` through `<area> api`) is refused over MCP and the API before anything resolves or is sent. | `src/mcp/server.ts`, `src/api.ts`, `src/core/run.ts` | None (not listed); `INVALID_INPUT` (a CLI-only call to a served tool, or through the API) | No | Yes |
| `commands.time-limit` | A caller waiting forever. Every command stops at `TOIL_TIMEOUT_MS` (default 120 s, or a longer `timeLimitMs` the command declares) and on Ctrl+C or an MCP cancel. `toil wait` stops at its own `--timeout` (default 30 m, or `TOIL_TIMEOUT_MS`), which may be no longer than `"wait": { "maxTimeout" }` in config (default 1 h, at most 24 h), and its attempts are at least 5 s apart. The limit can be set, not removed. | `src/core/run.ts`, `src/core/wait.ts` | `TIMEOUT`, `CANCELLED` | No | No |
| `commands.read-only` | Data a read was never meant to change. A write needs `writes: true` on the connection and `--allow-write` on the call (a CLI-only write, which is never an MCP tool and has no connection yet to hold one, needs `--allow-write`); reads send only GET/HEAD/OPTIONS (the parity suite checks); a database read runs read-only at the engine, and where the engine can't refuse a write (SQL Server; Teradata, whose Query Service takes every statement as a POST; and Hive and Impala, which have no read-only mode at all), `db query` relies on the read-only login or user the `db` skill page requires, and toil doesn't parse the SQL to decide whether it writes: SQL Server and Teradata roll every read back, and on Hive and Impala there is nothing to roll back; a command whose input decides (`writesWhen`, the raw API passthrough's method) is gated call by call; `toil wait` refuses to repeat a write, so a wait never makes a change twice; a write takes its connection and its target context inputs (owner, repo, project) only from a source the user owns, never from a toil project they haven't adopted (`docs/projects.md`, Writes ask once); git runs with optional index writes off; and an API call made with `readOnly` is refused before anything resolves if it would write at all, whatever the config says, a `summaryFile` included. `--summary-file` (`summaryFile`) on a read writes one new file, inside the workspace, through the same file service, and changes nothing else. The welcome menu runs every command it offers, its Services module included, through the CLI's own path, so the same gate holds there. | `src/core/run.ts`, `src/core/wait.ts`, `src/core/git.ts` | `WRITE_DISABLED`, `INVALID_INPUT` (a write named to toil wait) | No | Yes |
| `query.size` | Memory and time on the machine running toil. An expression for `--select` or `toil wait --until` may build at most 16 MiB of JSON plus four times the size of the data it was given, counted as each array, object and string is built, so one that doubles what it has at every step stops with an error before it can fill memory. Values it only passes along (`@`, a field) aren't counted. | `src/core/query/interpreter.ts` | `INVALID_INPUT` | No | No |
| `projects.size` | Every call's start-up time. A toil project file larger than 1 MiB isn't read or parsed: a named one fails the call, and one found in a folder is reported as broken. | `src/core/toil-project.ts` | `CONFIG_INVALID` (a toil project the call names), `TOIL_PROJECT_INVALID` (in toil projects check, and as a warning) | No | No |
| `gitignore.line` | The time a folder walk takes. A `.gitignore` or `info/exclude` line longer than 4096 characters isn't compiled; it's skipped with a warning quoting its start, and the rest of the file still applies. Compiling any shorter line takes time linear in its length. | `src/core/gitignore.ts`, `src/core/wildmatch.ts` | `GITIGNORE_LINE_SKIPPED` (a warning, not an error) | No | No |
| `process.spawn` | The machine's other programs. toil runs only git (#68 decision 1) and programs the OS ships to hand over what it already holds for the user: the OS credential store, and Windows PowerShell for SQL Server's Windows authentication (#49). Absolute path found by toil, no shell, fixed argv, scripts and secrets on stdin, the repository-config hooks that run code turned off. The modules allowed to spawn are the reviewed list in `scripts/spawners.mjs`. | `src/core/git.ts`, `src/core/keychain.ts`, `src/os/windows-sspi.ts`, `scripts/spawners.mjs`, `scripts/check-pure.mjs` | `GIT_NOT_FOUND` | No | Yes |

## Exceptions

| Exception | To bound | Enforced in | What it allows |
|-----------|----------|-------------|----------------|
| `git.read-up` | `files.workspace` | `src/core/git-repo.ts`, `src/core/git-config.ts`, `src/core/files.ts` | Reading git metadata above or beside the workspace, to find the repository root, branch and remotes, and what a listing skips. Anything under `~/.toil`, the `--config` file, `/proc` or `/sys` is refused: a global config or `include`/`includeIf` naming one is skipped with a `GIT_INCLUDE_REFUSED` warning in `meta.warnings`, and a `gitdir:` pointing at one is not a repository. |
| `output-file` | `files.workspace` | `src/node-context.ts`, `src/program.ts` | The global `--output-file` flag writing the envelope outside the workspace. |
| `shell-profile` | `files.workspace` | `src/core/shell-profile.ts`, `src/setup/commands.ts` | `toil setup alias` and `remove-alias` reading and writing the shell profile they name, outside the workspace. |
| `shell-profile.edit` | `files.no-overwrite` | `src/core/shell-profile.ts` | Those two commands changing that existing file, only between their own marker lines. |
| `skills.folders` | `files.workspace` | `src/skills/folders.ts`, `src/skills/marketplace.ts`, `src/skills/bundled.ts` | The `skills` and `skill` commands reading and writing the agent hosts' skills folders and marketplace clones, which live outside the workspace, and toil keeping the toil skill it installed current. Only fixed places, listed below; never anything under `~/.toil`. |
| `skills.reinstall` | `files.no-overwrite` | `src/skills/folders.ts`, `src/skills/bundled.ts` | `skills marketplace add` and `sync` replacing a skill folder that toil itself installed from the same marketplace and plugin, which is what refreshing it means, and `skill install` and the automatic rewrite replacing the `toil` folder toil recorded as `bundled`. Any other folder is left as found. |
| `projects.read` | `files.workspace` | `src/core/toil-project.ts` | Reading toil project files (`docs/projects.md`) from your own folder (`~/.toil/projects/`), the folders you list in `projectPaths` or `TOIL_PROJECT_PATHS`, and `.toil/projects/` at the root of the repository the call's folder is in. A toil project file named on the call (`--toil-project <file>`) must be one of those, or inside the workspace. |
| `projects.write` | `files.workspace` | `src/core/toil-project.ts` | The `toil projects` commands writing a toil project to your own folder, a listed folder, or `.toil/projects/` at the root of a git working tree (`export --repo`). Anywhere else, the file must be inside the workspace. |
| `projects.replace` | `files.no-overwrite` | `src/core/toil-project.ts` | Rewriting a toil project: an edit (`link`, `field`, `add-repo`, `env`) rewrites the file it read, and `export`/`import` with `--replace` replace one. Only a file that is already a valid toil project is ever replaced. |
| `connections.import` | `files.workspace` | `src/connections/import-command.ts` | `toil connections import` reading one other tool's connection list (DBeaver's `data-sources.json`, a `.regsrvr`, `servers.json`, `pg_service.conf`, ...) from that tool's default location on this OS, or from a path the person names, outside the workspace. Bounded below. |
| `db.tls-ca-file` | `files.workspace` | `src/core/db/tls.ts` | A `db` connection's `tlsCaFile` (with `"ssl": true`) reading one PEM file of CA certificates, named by an absolute path in the connection's own settings (config or env), never by a command's input, so it may sit outside the workspace. The person sets it, or an agent proposes it through `connections add --set` and the person approves it (principle 2). Bounded below. |
| `feedback.send` | `commands.read-only` | `src/feedback/command.ts`, `src/api.ts` | `toil feedback` sending one report to Imagile's feedback endpoint, which files it as a public GitHub issue, with no connection holding `writes: true` and no `--allow-write`. Its gate is the approval of that exact report instead, and it is the one request toil makes to a host the user didn't configure. Bounded below. |

`connections.import` is one read, of a file, plus with `--save` a write to toil's own config, and nothing else (CLAUDE.md, principle 2 and **Secrets**; #520):

1. **What.** One file, read as text and parsed, never executed: at most 4 MB, XML nested at most 64 levels
   with at most 200,000 XML elements, at most 1000 connections, a tnsnames.ora nested at most 32
   parentheses deep, JSON read with `JSON.parse` after comments are stripped, so a `__proto__` key is only a key. It is the
   tool's own connection list (the formats are the registry in `src/connections/import/index.ts`),
   found at the tool's default location for the OS (built from `os.homedir()`, `%APPDATA%` or
   `XDG_*`) or at the path the person typed.
2. **What it still refuses.** Network (UNC) and device paths, anything under `~/.toil` or the `--config`
   file, and `/proc` and `/sys`, all checked after realpath. It never reads `.pgpass`, DBeaver's
   `credentials-config.json`, or any credential store, and a password found in a file it does read is
   dropped and reported, never returned or written.
3. **What it writes.** Only with `--save`, only new `db` connections in toil's own config through
   `writeConfigFile`, never over a name that exists, and never `writes: true`. Without `--save` it
   writes nothing. It is CLI only: never an MCP tool.

`db.tls-ca-file` is one read, of one file, and nothing else (#520):

1. **What.** One regular file at the absolute path in the connection's `tlsCaFile` (on Windows, with a drive
   letter), at most 1 MB, read through its descriptor with the cap enforced as it reads, so a pipe or device
   can't be read without limit. Only the `-----BEGIN CERTIFICATE-----` blocks are used, each checked with `crypto.X509Certificate`. A file with
   none, or one Node can't parse, is `CONFIG_INVALID`, so pointing it at any other file (a config, a key)
   reads it and refuses it without quoting a byte. Relative and `~` paths, root-relative paths on Windows, and
   network (UNC) and device paths (`files.remote`, from the text alone, before any file call) are refused
   before anything is opened. After realpath it also refuses anything at or under `~/.toil`, the `--config`
   file, `/proc` and `/sys`, the bounds `files.own` and `files.system`, which nothing relaxes.
2. **What protects it.** The certificates become trust anchors for that one connection's socket and go
   nowhere else: not to an envelope, a log, a debug line (which names the path and the count) or a host.
   They add to the CAs the connection trusts (Node's, `NODE_EXTRA_CA_CERTS`, the OS store); they never replace
   them and never loosen the chain or name check. A person's own file adding trust to their own connection
   is the same trust `NODE_EXTRA_CA_CERTS` already gives.
3. **What it never does.** It is read only when a call connects, not when config loads, so a missing file
   never blocks `connections list` or `remove`. It is never written, and it is named only by the connection's
   settings, never by a command's input (`ctx.files`).

`feedback.send` is one request, to one fixed place, and only on approval (CLAUDE.md,
principle 9 and **Writes**; #265):

1. **Where.** `https://func-toil-feedback.azurewebsites.net/api/report`, written once
   in `src/feedback/consent.ts`. `TOIL_FEEDBACK_URL` may replace it only with a
   loopback `http://` address (`http://127.0.0.1:7071`), for testing a local copy of
   the function; any other value is `CONFIG_INVALID`, before anything is sent.
2. **When.** Only with `--consent` on the call, or `yes` typed at a terminal after the
   report and the disclaimer are shown. Without either it sends nothing and returns
   the report it would send. It is CLI only, never an MCP tool. Through
   `@imagile-dev/toil/api` it runs only for a `person`, whose `yes` to the `consent`
   question is the approval: the `consent` field is refused there, and a `readOnly`
   call asks nothing and only previews.
3. **What.** The kind, title, body and email the caller gave, plus toil's version,
   commit and the disclaimer's version. Never config, a connection name, a host, a
   token or anything else toil holds. The audit line keeps the title and body only as
   hashes, and drops the email.

What it doesn't stop, said plainly: there is no standing opt-in in config, as a
connection's `writes: true` is for other writes. An agent with a shell can pass
`--consent` itself, so the agent's steps in `skills/toil/core.md`, **Feedback** (send
only when asked, scrub, show the report, get the user's yes) are what stand between a
prompt injection and a public issue. Whether to add a config opt-in, or to ask on a
terminal even with `--consent`, is open for the maintainer (#270).

`git.read-up` is metadata only, and read only. It covers exactly these, and nothing
else:

1. **`.git`**: the `.git` folder or file found by walking up from the workspace, and
   the folders it points at (`gitdir:` and `commondir`, so a linked worktree's
   metadata in another checkout). Inside it: `HEAD`, refs, `packed-refs`, `config`,
   `config.worktree`, `index` and `info/exclude`.
2. **The global git config and its includes**: `~/.gitconfig` and
   `$XDG_CONFIG_HOME/git/config` (or `GIT_CONFIG_GLOBAL` alone), and every file
   those and the repository's config pull in with `include` or `includeIf`.
3. **Parent `.gitignore` files**: those between the repository's top and the
   workspace.

Every one of these, after realpath, passes the same checks as a file a command is
handed: nothing under `~/.toil`, the `--config` file, `/proc` or `/sys`. A refused
include or global config is skipped with a `GIT_INCLUDE_REFUSED` warning, and a
`gitdir:` pointing at one is not a repository. git's global excludes file
(`core.excludesFile`) isn't on the list, so a listing doesn't apply it. Nothing read
this way is returned as file content: it yields a root path, a branch name, remote
URLs, and the decision to skip a path. The files a command reads or writes stay
inside the workspace (#68 decision 2).

`shell-profile` is how a clone gets a `toil` command with no npm install. `toil setup
alias` and `toil setup remove-alias` are CLI only, never MCP tools, and the person
running them names the shell or the file (`--shell`, `--profile`; the default is
`~/.bashrc` or `~/.zshrc`). They touch only the lines between `# >>> toil alias >>>`
and `# <<< toil alias <<<`, leave every other byte of the file as it was, and write
through a symlink rather than replacing it. A profile with an unmatched marker, or
saved as UTF-16, is refused rather than guessed at. They still refuse toil's own files
and `/proc` and `/sys`.

`skills.folders` covers exactly these, and nothing else:

1. **The agent skills folders**: `~/.agents/skills`, `~/.copilot/skills` and
   `~/.claude/skills` at user scope, and `.agents/skills`, `.github/skills` and
   `.claude/skills` under the repository root of the workspace (or the workspace
   outside one) at project scope. A command picks one with `--agent` and `--scope`;
   no input names any other folder. Inside one, toil writes its index
   (`.toil-installed.json`), the skills it installs, and the `.toil-disabled` stash.
2. **A marketplace's clone**: the connection's `localPath`, from the user's config
   or env, or the folder a person passed to the CLI-only `skills marketplace add`,
   else `~/.agents/marketplaces/<repo-name>`. One under `~/.toil` is refused by every
   skills command; `add`, which knows the config file, also refuses one holding the
   `--config` file. `sync` can't see that file's path (area commands never see config),
   and the clone folder it uses comes from the user's own config or env.

Skills are copied without symlinks, and a skill name that would leave its folder
(`..`, a separator) is refused. These writes are writes: `sync`, `enable` and
`disable` need `"writes": true` on the marketplace's connection and `--allow-write`,
and `add`, which is CLI only and only clones, needs `--allow-write` and leaves writes off on the marketplace it adds, so adding one grants nothing.

`skill install`, which writes the toil skill toil carries into one of these folders as
`toil/`, is CLI only too and needs `--allow-write`; there is no connection to hold a
standing opt-in, so that install is the opt-in. Both it and the rewrite below are
exceptions recorded in CLAUDE.md, **Writes**, and explained for users in
`skills/toil/core.md`, **Writes**. From then on toil rewrites that
folder itself, and only that folder: after a command that changed the config file,
and on any run that finds it was written by another toil version, reported in
`meta.warnings` as `SKILL_REWRITTEN` (or `SKILL_REWRITE_FAILED`, never a failed
command). It writes the new copy beside the old one and swaps it in with one
rename. A `toil` folder that toil didn't record as `bundled` (made by hand, or
installed from a marketplace) is never rewritten, and `skill install` refuses to
replace it. A call with `--config` never rewrites it, since the skill describes the
user's own config.

`output-file` is the one global flag that writes outside the workspace. `--output-file` is a CLI
flag, never an MCP input, so the person running the command chose the path. It may
write anywhere except toil's own files and `/proc` and `/sys`, and it never
overwrites a file. The path is checked before the command runs, so a refused path
means nothing ran; the error envelope goes to stdout, with exit code 1. If the write
still fails afterwards, a write command's error says it ran and the change may
already have been applied.

`projects.write` and `projects.replace` write only toil projects, in the JSON toil itself
reads back. Each file is validated before it's written, and written alongside the old
one, then renamed into place. The file must end in `.json`, and it may never be under
`~/.toil` outside `~/.toil/projects/`, the `--config` file, `/proc` or `/sys`. A file
that isn't already a valid toil project is never replaced, and an existing one needs
`--replace` (except the one an edit read). Files in your own folder are written as
user-only (`0600`, in a `0700` folder). A toil project holds no secret, and writing one
contacts nothing.

`projects.read` is read only, and only of toil project files: JSON that toil validates as a
toil project before using or showing any of it. A toil project holds no secret and can't add a
host or a credential (`docs/projects.md`), so reading one from a shared folder can't
change where anything is sent. A file named on the call, by an agent or a person, must
end in `.json` and be in one of the toil project folders or inside the workspace (anywhere,
with the workspace bound relaxed). It may never be under `~/.toil` outside
`~/.toil/projects/`, the `--config` file, `/proc` or `/sys`. A file that fails to parse
or validate is reported by key path and position, never by its content. `cwd` only
chooses which repository's toil projects and git context apply; it never widens what a
command may read or write.

Over MCP, the config file, and so any relaxed bound, is the one `toil mcp` was
started with (`toil mcp --config <file>` in the MCP client's settings, written by a
person). No tool input can name a config file: input is strict, so a `config`
field is `INVALID_INPUT`.

Two things this doesn't cover, said plainly:

- **git itself sees the whole repository.** A command that runs git runs it in the
  workspace, but git answers for the repository it finds there: a revision such as
  `HEAD:../other/file`, or `git log -p` from a subfolder, can show content from
  outside the workspace. The git area's commands decide which pathspecs and
  revisions they accept; nothing in core confines them yet.
- **Clean and smudge filters still run, and a repository can bring its own.** The
  spawner turns off what repository config can make git run on a read (fsmonitor,
  external diff, textconv, signature checks, the pager), but not filter drivers. A
  `filter.<name>.clean` command can be set in the repository's own `.git/config`,
  and a `.gitattributes` in the tree selects it, so `git status` and `git diff` in a
  workspace that arrived with its `.git` folder (an archive of a checkout, a CI
  artifact, a vendored folder) run whatever program that config names. The `-c`
  overrides can't name every filter. git 2.40's `--attr-source` could point
  attributes at an empty tree and switch them all off, but that's above the 2.24
  floor, so for now this is a known risk of running a git command in a repository
  you didn't clone yourself.

## Which folder is the workspace

In order:

1. `--workspace <dir>`
2. `TOIL_WORKSPACE`
3. On the CLI, the working directory
4. Under `toil mcp`, the client's root, when it shares exactly one

Otherwise there is none, and any command that touches a file refuses with
`NOT_CONFIGURED` and says how to set one. `toil mcp` never falls back to its own
working directory: an MCP client starts the server wherever it likes, often the
user's home folder, and that isn't a decision anyone made about what an agent may
read. Relative paths resolve against the workspace, and every saved path in output is
absolute, with forward slashes.
