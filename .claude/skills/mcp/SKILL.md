---
name: mcp
description: Rules for `toil mcp`, the stdio MCP server in src/mcp/, and for the separate MCP gateway package (docs/mcp-gateway.md). Use when changing how tools are generated or registered, the `--areas` filter, MCP tool descriptions, which tools are exposed (write tools, deletes), transports, or anything that would make toil listen on a network port.
---

# MCP Server

The CLI is the primary interface; MCP is the alternative for clients that prefer
tools. `toil mcp` ships in the same package and runs in-process on the same core.
It never shells out to the CLI, so connections and exchanged tokens stay warm across
calls. Neither surface has a capability the other lacks.

`toil mcp` serves over stdio. `--areas jira,confluence` limits it to those areas, so
an agent sees a small, focused tool list and one config entry stands in for one vendor
server. With no `--areas`, it serves every area that has config, plus commands outside any area (`version`, `connections list`). Write tools are not
registered at all unless at least one of the area's connections has writes
enabled (see **Writes** in CLAUDE.md), so an agent cannot discover them, let alone call them.
Listing grants nothing: every call is still gated against the connection it
resolves.

A command of kind `cli-only` (`connections add`, `login`, `remove`) is never a tool,
whatever `--areas` says: it prompts on a terminal, and under MCP stdin is the
protocol, or it changes connections, which an agent never does. The MCP context
never carries a prompter either. Nor is an area command marked `mcp: false`, which
keeps its connection and its time limit on the CLI: deletes, which are never exposed
through MCP. The parity suite finds both by their definition (`servedOverMcp`),
proves MCP doesn't serve them, and runs the area ones' examples and write gate on the
CLI; keep those two the only exclusions. A served tool can still refuse one kind
of call: `offMcpWhen` (a `DELETE` through `<area>_api`), which execute() checks
for MCP calls only, through `runCommand`'s `via`. A command
with no connection (`standalone`, `config`, `area-local` such as `jira issue schema`), or
one marked `connectionOptional`, is served without `--areas` whether or not its area
is set up. Context inputs are fixed
fields on each tool, the same inputs the CLI takes as flags; aliases are CLI paths
only, never extra tools.

The server is built on the SDK's low-level `Server`, not `McpServer.registerTool`,
because `registerTool` validates arguments before our code runs: it drops unknown
fields and answers a missing one with plain text. toil advertises each tool's strict
JSON Schema and passes raw arguments to `execute()`, which is the only validator, so
bad input gets the same envelope through MCP as on the CLI. The server takes a
context *factory*, called per tool call with the command and that call's cancel
signal; never share one context across calls. Both front doors run commands through
`runCommand()`, which turns a failure building the context (config that broke while
the server was up) into an envelope too. The MCP server passes `'mcp'` to it, and
an `INVALID_INPUT` envelope then names each of the command's flags as its field
(`--updated-since` becomes `updatedSince`) in the message and fix, so areas word their
input errors once, for the CLI, and nothing else changes. A quoted command line
(`toil …` in backticks, or plain text up to the end of its clause) keeps its flags,
since it's something to run on the CLI. Tool descriptions are written for a model
choosing between tools: what it returns, when to use it, and which sibling tool to use
instead. A field's description is the same text on both front doors, so it never names a
CLI-only flag (`--output-file`, `--config`). Every tool also takes core's `select`
(`--select` on the CLI): `inputSchemaFor` adds it to each schema and `execute()` takes it
off before the command's own strict parse, so no command declares it. `outputFormat`
and `summaryFile` (`--output-format`, `--summary-file`) are core's the same way
(`CORE_OUTPUT_PROPERTIES`), taken off by `runCommand()` and applied to the envelope
after `select` (`src/core/output/`), so `wait` gets them too.

**`wait` and resources.** `wait` (`src/core/wait.ts`) is served whenever a read tool
is, and repeats only the tools this server serves; it sends `notifications/progress`
after each attempt when the call carried a progress token, and every tool call with a
token also gets the call's page and retry progress events (`src/core/progress.ts`),
numbered from one counter per call so `progress` only goes up. `runCommand()` hands it
the server's tool list as its targets. Resources (`src/mcp/resources.ts`) are
descriptions, never data: `toil://connections` (name, area, default, writes, never a
host or secret), `toil://projects[/<name>]` through the toil projects commands, served
when those tools are, and `toil://skill/<area>` for each area served. A resource
never reads from a service or a database, and follows `--areas` as the tools do. The
one prompt, `analyze` (#494), is the `projects_analyze_prompt` tool's answer, run
through `runCommand()` and served exactly when that tool is; a new prompt follows the
same rule, a tool's answer and never text the server writes itself.

**The base package never opens a port** (*principle 1*: a listening socket is the
other thing locked-down machines block). Stdio is the only transport in
`@imagile-dev/toil`. A shared, network-reachable endpoint is a separate alternative,
the **MCP gateway** (`docs/mcp-gateway.md`, issue #4): its own opt-in package on the
same core, Streamable HTTP, and mandatory authentication. Don't add an HTTP transport
to the base package; that work belongs to the gateway.

## The workspace over MCP

Under `toil mcp` the file workspace (`docs/bounds.md`) is `--workspace <dir>` in the
server's args, else `TOIL_WORKSPACE`, else the client's root when it shares exactly
one. The server's own working directory is never used. `createMcpServer` asks the
client for its roots (`roots/list`) when it advertises the capability, caches the
answer until `notifications/roots/list_changed`, and hands the roots to the context
factory, so the CLI and MCP resolve the workspace through the same function
(`resolveWorkspace` in `src/core/files.ts`). With no root or several, a command that
touches a file returns `NOT_CONFIGURED` with a fix; commands that touch no file are
unaffected.

## Toil project context over MCP

A stdio server's own working directory means nothing, because it's wherever the
client launched it. Every area command takes a `cwd` input on both front doors,
which chooses the toil project (`docs/projects.md`) and the git context. Left out, it's
the workspace: on the CLI the working directory, under MCP the client's root when the
client reports exactly one, converted from its `file://` URI with Node's URL
handling. A relative `cwd` resolves against the CLI's working directory, or the
workspace under MCP. A toil project file is an explicit input too (`toilProject`), so the two
doors stay 1:1, and `meta.context.toilProject.folder` says which default applied. A path
that doesn't exist on the server's side is `INVALID_INPUT` saying so, never a
silent "no toil project".

## Verifying with a real client

The in-memory parity suite and `smoke` don't prove a real agent can use the server.
Any change to `toil mcp` is also driven by the local Codex CLI before the PR opens,
with overrides so the user's own Codex config is untouched:

```bash
codex exec --skip-git-repo-check -s read-only -c 'mcp_servers.toil.command="node"' -c 'mcp_servers.toil.args=["<repo>/dist/toil.js","mcp"]' "List every toil tool, call <tool>, and print the raw JSON it returned."
```

The PR shows the tool list and the envelope that came back.
