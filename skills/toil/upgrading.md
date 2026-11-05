---
description: Standing instructions for an agent when toil is upgraded or a retired name turns up - read what changed, then convert config, env vars, toil projects, scripts and MCP settings safely, with the user's approval
---

# Upgrading toil

Run this page when toil has changed under you. It tells you what to read, what toil
already does by itself, and what you do. A person owns their connections, credentials
and CI; you propose, they approve.

## When to run it

- `toil version` reports a version other than the last one you knew. toil rewrites
  this skill when another version runs (`SKILL_REWRITTEN`), so a changed skill is the
  same cue.
- An envelope, warning or error names a retired or renamed thing:
  - `CONFIG_INVALID` naming a retired env var (`TOIL_JIRA_CLOUD_*`), or saying a file
    "was written by a newer toil"
  - `CONFIG_RENAMED_AREA`, `CONFIG_DEFAULT_KEPT`, `TOIL_PROJECT_RENAMED_AREA`
  - `TOIL_PROJECT_DEPRECATED_NAME`, `CONFIG_RENAMED_KEY` or `TOIL_PROJECT_OLD_FOLDER`:
    what earlier versions called a dossier is now a toil project
  - `INVALID_INPUT` saying a command, area or tool "no longer exists"
  - Over MCP, the SDK's `-32602 Unknown tool: dossiers_list` (no envelope: the tool name is
    gone, so `projects_list` is the one to call), or `INVALID_INPUT` with `Unrecognized key:
    "dossier"` and a fix saying the field is now `toilProject`
  - `UNSUPPORTED`, when a flag or command belongs to the other deployment
  - `UNSUPPORTED_NODE`, when the Node on this machine is no longer supported
- A script, CI file or agent config of the user's names a path, tool, flag or variable
  from the table below, or one that uses the `dossiers` command group, passes `--dossier`, or sets
  `TOIL_DOSSIER` or `TOIL_DOSSIER_PATHS`.

## 1. Read what changed

Open `changelog.md`, beside this file (over MCP, `toil://skill/changelog`). It is
the changelog of the newest versions of this toil, newest first, with
**BREAKING CHANGES** before **Features**. Read every section between the version you
knew and `toil version`. Each breaking change says how to migrate; an area's page
has a **Moving from** section with the detail: `jira.md`, `confluence.md`,
`bitbucket.md`, `ado.md`. If the version you knew is older than the changelog goes
back, say so and read the area pages' **Moving from** sections.

Tell the user what you found before changing anything.

## 2. Convert, by kind

Never hand-edit `~/.toil/config.json`. Never print, copy, re-enter or move a secret
value; work with names only. Never add a connection, turn `writes` on or change a
credential: those are the user's.

### Config file

- toil reads an older config version in memory on every load and folds retired areas
  (`jira-cloud` into `jira` with `"deployment": "cloud"`). Nothing on disk changes.
- The file is rewritten as the current version only by a command that saves config.
  `toil connections migrate` saves it, and writes nothing if the file is already current.
  The save writes the migration toil already applies in memory: retired areas folded
  into the new area with `"deployment": "cloud"`, defaults moved as the area page
  describes, and a default set aside (`CONFIG_DEFAULT_KEPT`) dropped. Before running it,
  tell the user what it will write (the warnings name each folded area and set-aside
  default) and get their yes; no connection's host or credential changes. It then
  reports what it wrote, by name and key, and the warnings clear.
- Tell the user that an older toil, and a Toil UI pinned to an older toil, cannot read
  the newer version afterwards.
- A config file with `dossierPaths` loads in memory as `projectPaths`, with a
  `CONFIG_RENAMED_KEY` warning. `toil connections migrate` writes it as `projectPaths`
  in config version 4. Say that before running it, and get the person's yes: it is the
  same save, and the same cost (an older toil and Toil UI cannot read version 4).
- `CONFIG_DEFAULT_KEPT` means two defaults collided and one was set aside. Show the
  user which; changing the default is theirs.
- A file "written by a newer toil" is refused. Upgrade toil (`install.md`); never
  edit the version down.
- Keychain entries are untouched by every migration.

### Environment variables

An env var of a retired area is refused with `CONFIG_INVALID`. The old `TOIL_DOSSIER*` names
still work for one beta and warn. Renames:

| Retired | Now |
|---------|-----|
| `TOIL_JIRA_CLOUD_*` | `TOIL_JIRA_*` with `TOIL_JIRA_DEPLOYMENT=cloud` |
| `TOIL_CONFLUENCE_CLOUD_*` | `TOIL_CONFLUENCE_*` with `TOIL_CONFLUENCE_DEPLOYMENT=cloud` |
| `TOIL_BITBUCKET_CLOUD_*` | `TOIL_BITBUCKET_*` with `TOIL_BITBUCKET_DEPLOYMENT=cloud` |
| `TOIL_ADO_CLOUD_*` | `TOIL_ADO_*` with `TOIL_ADO_DEPLOYMENT=cloud` |
| `TOIL_CONN_<NAME>_AREA=jira-cloud` (likewise the others) | `TOIL_CONN_<NAME>_AREA=jira` with `TOIL_CONN_<NAME>_DEPLOYMENT=cloud` |
| `TOIL_DOSSIER` | `TOIL_PROJECT` |
| `TOIL_DOSSIER_PATHS` | `TOIL_PROJECT_PATHS` |

Where they live: shell profiles, CI variables, pipeline YAML. Find them by name
(search for `_CLOUD_` and `TOIL_DOSSIER`), propose the renamed names, and change them only with the user's
approval. Never move a value yourself: the user renames the secret in their CI store.
`TOIL_*` values on a default connection that is Cloud are refused unless
`TOIL_<AREA>_DEPLOYMENT` is set. For CI that should fail on an empty retired
variable, `TOIL_STRICT_ENV=true` (see `core.md`, **Configuration**).

### Toil projects

What earlier versions called a dossier is a toil project, and its folders were renamed.
toil still reads the old folders, `~/.toil/dossiers/` and `.toil/dossiers/` in a
repository, and warns `TOIL_PROJECT_OLD_FOLDER`. When the same name is in both, the
`projects/` folder wins.

- **The user's own folder.** `toil projects migrate` moves `~/.toil/dossiers/*.json` to
  `~/.toil/projects/`. It asks for the person's `yes` (`--yes` skips the question), never
  overwrites a file already in `projects/`, and reports each file by name. Tell the
  person what it will move and get their yes first.
- **A repository's `.toil/dossiers/`.** `toil projects migrate` does not move it, because it
  is the repository's, in its history. Offer the person the command and let them run it
  in that repository, then commit: `git mv .toil/dossiers .toil/projects`. Do not run it
  yourself. A repository that is not theirs gets a proposed change for its owners.
- **A listed folder** (`projectPaths` or `TOIL_PROJECT_PATHS`): the person moves its files
  the same way, or lists the new folder.

A `jira-cloud`, `confluence-cloud`, `bitbucket-cloud` or `ado-cloud` section is read as
the new area with a `TOIL_PROJECT_RENAMED_AREA` warning, which names the file. Rename the
section to `jira`, `confluence`, `bitbucket` or `ado` (transition pins are
`ado.transitions`). If both exist, the new one wins and the old is ignored: merge
what you need, then remove the old.

- In the user's own folder (`~/.toil/projects/`, or `~/.toil/dossiers/` before it is
  moved): propose the edit, or make it with approval.
- Checked into a repository, or in a listed folder: propose a change in that repository
  for its owners; do not edit it unprompted.

Warning codes: every `DOSSIER_*` is now `TOIL_PROJECT_*` (`DOSSIER_RENAMED_AREA` is
`TOIL_PROJECT_RENAMED_AREA`, `DOSSIER_REPO_UNMATCHED` is `TOIL_PROJECT_REPO_UNMATCHED`,
and so on), and `meta.context.dossier` is `meta.context.toilProject`. Update anything
that matches on them.

### Commands, MCP tools and flags

- The command path `jira-cloud` is `jira`, likewise the other three. Pick the Cloud
  connection with `--connection`, or ask the user to make it the default.
- MCP tools `<area>_cloud_*` are `<area>_*`; `bitbucket_cloud_pr_request_changes` is
  `bitbucket_pr_needs_work` (`pr request-changes` is an alias of `pr needs-work`).
- `toil mcp --areas jira-cloud` is `--areas jira`. The MCP entry lives in the agent's
  config (`mcp.md`): propose the edit.
- Warning codes `ADO_CLOUD_WORK_ITEMS_MISSING`, `ADO_CLOUD_TYPE_UNKNOWN` and
  `ADO_CLOUD_DEFAULT_TEAM` are `ADO_WORK_ITEMS_MISSING`, `ADO_TYPE_UNKNOWN` and
  `ADO_DEFAULT_TEAM`; update anything that matches on them.
- Scripts and CI files: the `dossiers` command group is `projects`, `--dossier` is
  `--toil-project`, and `<area> check-dossier` is `<area> check-toil-project`. The old
  CLI forms still work for one beta and warn `TOIL_PROJECT_DEPRECATED_NAME`.
- MCP tools and settings: `dossiers_*` is `projects_*`, `<area>_check_dossier` is
  `<area>_check_toil_project`, the input `dossier` is `toilProject`, and the resources
  `toil://dossiers` and `toil://dossiers/<name>` are `toil://projects` and
  `toil://projects/<name>`. Over MCP and the API the old names are gone, with no alias,
  so a call to `dossiers_list` fails with the SDK's `-32602 Unknown tool` error, and a call
  that still sends `dossier` fails with `INVALID_INPUT` (`Unrecognized key: "dossier"`, its fix
  naming `toilProject`). `toil mcp --areas` is
  unaffected.
- An agent's allowed-tools list (for example `mcp__toil__dossiers_list` in a Claude Code
  settings file) must be renamed (`mcp__toil__projects_list`) or the agent loses access
  to the tool. Search the agent's settings by `dossier`, propose each renamed entry,
  and change it only with the person's approval.
- Update scripts and agent configs with approval, one file at a time.

### Secrets and the keychain

Migrations never touch them. Do not re-enter, export or move a credential to make an
upgrade work; if a connection fails with `AUTH` afterwards, that is a separate problem
for the user to fix with `toil connections login <name>`.

## 3. Verify

1. `toil connections list`: every connection shows its area as expected.
2. `toil connections test <name>` for each connection you touched or that a changed
   area uses.
3. One read on each touched area (for example `toil jira issue search --limit 1`).
4. Re-run the command that warned: no `CONFIG_RENAMED_AREA`, `TOIL_PROJECT_RENAMED_AREA`,
   `TOIL_PROJECT_DEPRECATED_NAME`, `CONFIG_RENAMED_KEY`, `TOIL_PROJECT_OLD_FOLDER`,
   `CONFIG_DEFAULT_KEPT` or retired-name error is left. `toil projects list` shows each
   toil project under `~/.toil/projects/`.

## 4. Report

Say what changed (files, variables and sections, by name) and what is left for the
user: anything in their terminal, their CI settings, a repository they own, or that
needs their approval. If you could not verify a connection, say which and why.
