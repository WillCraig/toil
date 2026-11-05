---
name: toil
description: Use toil, a structured-JSON CLI and MCP server, to read from and (when allowed) write to databases and the enterprise tools an organization runs, such as issue trackers, source hosts, wikis, CI, artifact repositories, scanners and observability. Use when a task needs data from one of those tools or a database, or mentions `toil` commands, `toil mcp`, a toil connection, or a TOIL_* environment variable. Also use for whole jobs such as review this PR, ship this branch, or map this codebase.
---

# toil

toil is the token-efficient alternative to MCP: the same commands as a CLI, each
returning one compact envelope, read a file at a time rather than every tool schema
up front.

If `toil version` doesn't print an envelope, toil isn't installed: `install.md` says how.

## Every call

- **Output.** Every command prints one JSON envelope on stdout: `{ ok, data, error,
  meta }`. Check `ok`; on failure, `error.code` says what failed and `error.fix` what
  to do about it. `meta.warnings` lists what's worth knowing that isn't a failure, and
  `meta.page.nextCursor` the next page.
- **Two front doors, one command.** `toil <area> <command>`, or the MCP tool named
  for its path (`db_query`) from `toil mcp --areas <area>`: same inputs and output.
- **Writes.** Reads are always allowed. A command that changes data needs
  `writes: true` on the connection, set by a person, and `--allow-write` on the call
  (`allowWrite: true` over MCP). Make only writes the user asked for. Four differ:
  `core.md`, **Writes**.
- **Connections.** Env vars always win over `~/.toil/config.json`. `--connection
  <name>` picks one when an area has several; `toil connections list` names them,
  never a secret. To set toil up for someone, follow `setup.md`: you create
  connections, they enter every secret.
- **Untracked work.** Before work no ticket covers, rank open tickets with
  `toil util owi similar --query`, then ask the person where it goes: `core.md`,
  **Ticket the work**.
- **Files** a command reads or writes stay in the workspace (`--workspace <dir>`, or
  the working directory).
- **Feedback** to Imagile (`toil feedback`) only when asked, scrubbed of company
  data, shown in full, sent with `--consent` only on their yes to that exact report:
  `core.md`, **Feedback**.
- **Less output.** `--select <expression>` keeps only the fields you name;
  `toil wait --until <expression> -- <read>` repeats a read until it's true. For a
  listing that may pass a page, add `--summary-file <file>` (`summaryFile`): the full
  result goes to the file and you get a sample; `--output-format toon` shrinks tables.

## By job

Read the job's page, and `workflows/README.md` once.

- `workflows/review.md`: review someone else's PR
- `workflows/ship.md`: take your branch to a PR, answer its review, fix CI
- `workflows/map-codebase.md`: map a repository and draw its C4 diagram

## Where to look

Open only the file the task needs; each is beside this one.

| File | When |
|------|------|
| `core.md` | `--select`, big results, `toil wait`, paging, errors, writes and exceptions, global flags, files, configuration, the raw `api` passthrough, toil projects, audit log, calling toil from a program (`./api`), feedback, certificates and proxies |
| `<area>.md` | One per area, named after it: `jira.md` for `toil jira …`. Its frontmatter says what it covers; the file has its oldest supported version, credential, configuration keys and every command |
| `projects.md` | What a toil project is; building, sharing, briefing |
| `db.md` | Databases: `toil db …` on every engine |
| `util.md` | Local utilities, no connection or network: `toil util …` |
| `skills.md` | Skills marketplaces, and keeping this skill installed |
| `mcp.md` | Running toil as an MCP server, and registering it |
| `upgrading.md` | A new toil version, or a warning naming a retired or renamed thing |
| `setup.md` | "Set up toil for me": Toil UI or not, connections, secrets, a toil project |
| `install.md` | Installing toil, and this skill |

`toil --help` lists this install's areas.
