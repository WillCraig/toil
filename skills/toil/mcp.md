---
description: Running toil as an MCP server over stdio, the tools and resources it serves, and registering it with Claude Code, Codex, VS Code and other clients
---

# toil as an MCP server

`toil mcp` serves every toil command as an MCP tool over stdio. It's the same core as
the CLI, with the same inputs and the same envelope. A tool's name is its command path
with underscores: `toil jira issue get` is `jira_issue_get`. It never opens a network
port.

- **`--areas jira,confluence`** serves exactly those areas, so an agent sees a short
  tool list and one server entry stands in for one vendor's server. Commands outside
  an area are areas of their own here: add `version` or `connections` to the list to
  serve them too. Without `--areas`, toil serves every area that has a connection set
  up, plus every command that needs none (`version`, `connections list`,
  `jira issue schema`).
- **Writes**: a write tool is listed only when one of its area's connections has
  `writes: true`, and every call still needs `allowWrite: true`. Deletes, and the
  commands that prompt or change connections (`connections add`, `setup alias`), are
  never tools.
- **Big results**: every tool takes `outputFormat` (`"toon"` writes `data` as compact
  TOON text) and `summaryFile` (the whole of `data` goes to that file in the
  workspace, and a summary comes back in its place), as `core.md`, **Big results**,
  describes.
- **Files**: a command that reads or writes a file needs a workspace: `--workspace
  <dir>` in the server's args, else `TOIL_WORKSPACE`, else the client's root when it
  shares exactly one. With none, it returns `NOT_CONFIGURED`.
- **`wait`**: the `wait` tool repeats one read tool until a condition over its data
  holds (`SKILL.md` describes it). It's served whenever a read tool is, `--areas` or
  not, and repeats only the tools the server serves. After every attempt that doesn't
  end the wait it sends a progress notification when the call carried a progress
  token, so a client that resets its tool-call timeout on progress keeps a long wait
  alive. The notifications are checked with the MCP TypeScript SDK's client
  (`resetTimeoutOnProgress`), and the Codex CLI ran a one-minute wait to its end.
  Whether Claude Code, Codex or other clients reset their own tool-call timeout on
  progress hasn't been checked, so with those keep `timeout` under the client's
  tool-call limit.
- **Progress**: any tool call that carried a progress token also gets a progress
  notification for each page a listing reads and each rate-limited (429) request
  toil waits to retry, with the same message the CLI writes to stderr
  (`core.md`, **Progress**). The envelope is the same either way.
- **Prompts**: `analyze` briefs one toil project (its one argument, `toilProject`, defaults to
  the one the folder matches): what needs a person, why, and what to do first, read
  through toil's tools, with every work item and pull request linked. It's what the
  `projects_analyze_prompt` tool returns, served when that tool is (`projects.md`,
  **Analyze**).
- **Resources**: besides tools, the server serves read-only resources that describe
  toil's own context, so a client can read it without a tool call. None reads from a
  service, and none holds a secret. They follow `--areas` as the tools do.
  - `toil://connections`: each connection's `name`, `area`, `isDefault` and
    `writes`, for the areas served. Never a host or a credential.
  - `toil://projects` and `toil://projects/<name>`: what the `projects_list` and
    `projects_show` tools return, served when those tools are.
  - `toil://skill/<area>`: this skill's page for each area served, such as
    `toil://skill/jira` for `jira.md`.
  - `toil://skill/workflows/<job>`: the workflow pages (`review`, `ship`,
    `map-codebase`) and their `README`, whatever `--areas` says, since a job spans areas.
- **Config**: the server reads `~/.toil/config.json`, or `--config <file>` in its args,
  and the `TOIL_*` env vars it is started with. Keep tokens in the OS credential
  store (`toil connections add`, run once on a terminal) rather than in the client's
  `env` block, which is a file someone may share or commit.

## Registering it

The examples use `toil` on PATH and the Jira area; change `--areas` to what the task
needs.

**Claude Code**

```bash
claude mcp add toil -- toil mcp --areas jira
```

**Codex**

```bash
codex mcp add toil -- toil mcp --areas jira
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.toil]
command = "toil"
args = ["mcp", "--areas", "jira"]
```

**VS Code and GitHub Copilot**, in `.vscode/mcp.json`:

```json
{ "servers": { "toil": { "type": "stdio", "command": "toil", "args": ["mcp", "--areas", "jira"] } } }
```

**Claude Desktop, Cursor and other clients with an `mcpServers` file**:

```json
{ "mcpServers": { "toil": { "command": "toil", "args": ["mcp", "--areas", "jira"] } } }
```

## When `toil` isn't on PATH

MCP clients start servers without a shell, so they don't read shell profiles and a
`toil` alias doesn't apply. Use one of these as the command and its args instead:

| Installed | `command` | `args` |
|-----------|-----------|--------|
| From a clone | `node` | `["<clone>/dist/toil.js", "mcp", "--areas", "jira"]`, with the clone's absolute path |
| Not at all, once toil is on npm | `npx` | `["-y", "@imagile-dev/toil", "mcp", "--areas", "jira"]` |
| From npm, on Windows | `cmd` | `["/c", "toil", "mcp", "--areas", "jira"]`, because npm's `toil.cmd` needs a shell to start |

In JSON and TOML, write a Windows path with forward slashes
(`C:/Users/you/toil/dist/toil.js`), which Node accepts.

## Checking it works

Ask the agent to list toil's tools and call one that needs no connection: `version`
(served when `--areas` is left out or names `version`) returns the same envelope as
`toil version`, `{ "ok": true, "data": { "version": … } }`. A tool that isn't listed
is in an area `--areas` leaves out, in an area with no connection set up (without
`--areas`), or a write tool on a connection without `writes: true`.
