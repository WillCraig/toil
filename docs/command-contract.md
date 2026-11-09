# Command contract

`command-contract.json` is toil's hand-maintained record of its command surface: every
command path and alias, each command's positional arguments and flags with their
accepted values and defaults, and the field names of the `data` each command returns. It holds 486
commands, 369 of them leaves. `test/contract.test.ts` checks the registered CLI against
it on every run, so a command, flag or output field can't change or disappear without
someone noticing. Each difference toil makes on purpose is a divergence, listed with its
reason (below).

How integrations are held to it is **The command contract** in `CLAUDE.md`, and the
working rules are **Compatibility** in the `integrations` skill
(`.claude/skills/integrations/SKILL.md`).

## What the contract records

For every command in scope:

- the command path (`jira issue get`, `ado pr list`, `dynatrace entity list`) and its
  aliases
- the positional arguments, in order
- the long and short flags, their accepted values and their defaults
- group-level flags (`bitbucket --project --repo`, `github --owner --repo`,
  `ado --collection --organization --project --repo`, `jenkins --instance`,
  `openshift --env --instance`, `dynatrace --env`)
- the global flags `--pretty`, `--verbose`, `--debug`, `--config <path>`,
  `--output-file <path>`, `-v/--version`
- the JSON envelope, with the `data` field names each command returns
- env var names, each with the `TOIL_` prefix, and config keys

toil may add commands, flags and output fields; anything the contract records that toil
changes or drops is a divergence.

## Scope

| Area | In scope | Notes |
|------|----------|-------|
| Every integration (`jira`, `bitbucket`, `github`, `confluence`, `sonar`, `sde`, `ado`, `jenkins`, `artifactory`, `checkmarx`, `contrast`, `sonatypeiq`, `openshift`, `dynatrace`, `logscale`, `elasticsearch`, `kibana`, `splitio`, `figma`, `alation`, `saucelabs`) | Yes | Exact match |
| `git` | Yes | Exact match, apart from the divergences in `docs/divergences/git.json`. Repository facts (root, branch, remotes) are read from `.git` in pure JS; `status`, `diff`, `log`, `branch` and `report` run the git on PATH, the one program besides the OS credential store toil may run (#68 decision 1), and return `GIT_NOT_FOUND` without it |
| `jwt` | Yes | Built as `util jwt decode`, a local utility; `jwt decode` is its alias. One divergence, in `docs/divergences/jwt.json` |
| `deps` | Yes | `scan` and `diff` are built as `util deps scan` and `util deps diff`, local utilities, with the contract's paths as aliases; `frisk`, `outdated` and `license-check` are aliases of the source commands that own them. Divergences in `docs/divergences/deps.json` |
| `config` | No | Built around the OS credential store. `config import` reads a global config file in the shape the contract records, once. |
| `skills` | Yes | Marketplace add, list, plugins, remove, sync, enable and disable, and `skills status`, matched. The rest aren't built yet, or are gone for good (`skills git-auth`); each is a divergence in `docs/divergences/skills.json` |
| `doctor` | No | Built for toil's own setup story |
| `feedback` | Yes | toil's own: a bug report or feature request to Imagile LLC, sent only with `--consent` or a terminal's `yes` (`skills/toil/core.md`, **Feedback**). CLI only |

## Divergences

Each divergence is one entry in `docs/divergences/<area>.json` (`global.json` for global
flags and behavior every area shares), one file per area so parallel integrations never edit
the same file. The contract test (`test/contract.test.ts`) loads them all and fails on
any difference none of them allows. An entry holds:

| Key | Meaning |
|-----|---------|
| `allows` | The identifiers it excuses: a command path (`git credentials`), a command and flag (`<area> <command> --<flag>`), a global flag (`--dry-run`), or a command and output field (`<area> <command> data.<field>`, such as `jira issue search data.issues[].key`). Empty for a divergence in behavior only, with the surface unchanged, so it can't excuse a missing command, flag or field. |
| `when` | Optional. Input values a call must have for the entry to apply, such as `{ "exampleOnly": true }`. The output check applies it per example, so `jira issue schema`'s fields are excused only with `--example-only`. |
| `old` | What the contract records, by its current paths: an area reshaped to the command shape names its new paths here too |
| `toil` | What toil does instead, and what to use |
| `why` | The reason, in a sentence or two |
| `principle` | The principle's number, a CLAUDE.md section (`Output Contract`), or `decision` for a deliberate product call |
| `class` | `security` when it keeps a credential or a file safe. Those are made before any live run and are never relaxed. |
| `removed` | `true` when the command paths in `allows` are gone from toil, not changed (`git credentials`). `allows` then lists only command paths. The test accepts their absence, and fails if one of them, or a path under it, is still registered. |

Every identifier must name something in the contract and sit in the file for its own
area, and the test checks both. The test covers paths, aliases, positional arguments,
flag spellings and output field names; a flag on the command's group counts for a leaf
flag of the same spelling, since the group accepts it after the leaf. For output, it runs every example in the area's
fixture and requires every required field of one of the contract's recorded shapes;
optional fields (`?` in the contract) and output the contract types as `any` can't be
checked that way, so an integration still compares those with the contract by hand.

To read them all as a table: `node scripts/divergences.mjs`.

## Changing the contract

The contract is edited by hand and changes only on purpose, in the same change as the
commands it records. Review the diff like any other contract change.

## The contract version

`contractVersion` at the top of `command-contract.json` is the version of the contract
toil keeps with its callers: the commands, flags and `data` fields recorded here, the
envelope, and the meaning of each error code. toil reports it in `toil version`
(`data.contractVersion`), on every envelope (`meta.contractVersion`) and from
`@imagile-dev/toil/api` (`contractVersion`), so a program can refuse a toil it
wasn't built for instead of misreading its output. `CONTRACT_VERSION` in
`src/core/envelope.ts` is the value in code, and `test/api.test.ts`
fails when the two differ.

It's a whole number, bumped by one, in the same change, whenever the contract breaks:
a command, flag, `data` field or envelope key is removed, renamed or repurposed, or an
error code changes meaning. Those are exactly the changes Delivery in `CLAUDE.md`
declares with `feat!:` and a `BREAKING CHANGE:` footer. An additive change (a new
command, flag, field, error code, warning or `meta` key) leaves it alone, so a
caller built against version N works with every toil that reports N.

The contract is stable from the first beta, `0.1.0-beta.1` (principle 7). The alphas
before it all report 1, the first beta ships 1, and every breaking change from then
on raises it.

### History

| Version | Change |
|---------|--------|
| 1 | The alphas and the first beta. |
| 2 | `jira-cloud` folded into `jira`, `confluence-cloud` into `confluence`, `bitbucket-cloud` into `bitbucket` and `ado-cloud` into `ado` (#495): the `jira-cloud`, `confluence-cloud`, `bitbucket-cloud` and `ado-cloud` command paths, the `jira_cloud_*`, `confluence_cloud_*`, `bitbucket_cloud_*` and `ado_cloud_*` MCP tools, `--areas` with those names, the `TOIL_JIRA_CLOUD_*`, `TOIL_CONFLUENCE_CLOUD_*`, `TOIL_BITBUCKET_CLOUD_*` and `TOIL_ADO_CLOUD_*` variables and those areas in config and toil projects are gone. A Cloud call is `toil jira …`, `toil confluence …`, `toil bitbucket …` or `toil ado …` (Azure DevOps Services) on a connection with `"deployment": "cloud"`. Bitbucket Cloud's `pr request-changes` is now an alias of `pr needs-work`. `SYSTEM_ACCESSTOKEN` is read for an `ado` Server default only. Config is version 3 and migrates on load. |
| 3 | Dossiers became toil projects (#555). Callers migrate as follows; the CLI keeps the old names for at least one beta with a `TOIL_PROJECT_DEPRECATED_NAME` warning, MCP and the API do not. **Paths:** `toil dossiers <command>` is `toil projects <command>`, and `<area> check-dossier` is `<area> check-toil-project` (the old CLI paths are retired aliases, not contract paths). **MCP tools:** `dossiers_*` are `projects_*`, and `<area>_check_dossier` is `<area>_check_toil_project`; the old names are gone, and `--areas dossiers` is `--areas projects`. **Input:** the core input `dossier` is `toilProject` (`--dossier` is `--toil-project` on the CLI; the old flag is read with a warning, and is an unknown field over MCP and the API). **Envelope:** `meta.context.dossier` is `meta.context.toilProject`, and `"dossier"` as the source of a context input or connection (`meta.context.inputs.<name>.source`, `meta.context.connection.source`, `meta.transition.resolvedBy`) is `"toil-project"`. **`data`:** the `projects` commands' fields named `dossier` / `dossiers` are `toilProject` / `toilProjects` (for example `projects list` returns `toilProjects`, and `projects show` returns `toilProject`). **Codes:** every `DOSSIER_*` warning and error code is `TOIL_PROJECT_*` (`DOSSIER_RENAMED_AREA` is `TOIL_PROJECT_RENAMED_AREA`, `DOSSIER_REPO_UNMATCHED` is `TOIL_PROJECT_REPO_UNMATCHED`). **Env:** `TOIL_DOSSIER` is `TOIL_PROJECT` and `TOIL_DOSSIER_PATHS` is `TOIL_PROJECT_PATHS`; the old names are read, the new one wins when both are set, and both are reserved. **Config:** `dossierPaths` is `projectPaths`; config is version 4, an older file loads with a `CONFIG_RENAMED_KEY` warning, and `toil connections migrate` saves it in version 4. **Folders:** `~/.toil/dossiers/` and `<repo>/.toil/dossiers/` are `projects/`; both are read, the new folder wins a name clash, and `toil projects migrate` moves your own. **MCP resources:** `toil://dossiers` and `toil://dossiers/<name>` are `toil://projects` and `toil://projects/<name>`. |

The contract's `jira` entries still record Jira Data Center. Jira Cloud's own commands and
flags (`project list`, `project get`, `user search`, `sprint get`, `sprint create`, `sprint update`, `sprint start`, `sprint complete`, `issue schema --deployment`) are additive, and a call
that the connection's deployment can't serve is `UNSUPPORTED` (`docs/divergences/jira.json`
records the one flag it spells differently, `--assignee <user>`).

The contract's `bitbucket` entries still record Bitbucket Data Center. Cloud's commands and flags (`repo list`, `branch`, `tag`, `file`, `pipeline`, `api`, `--ws`, `--query`, `--spec`) are additive, and a call that the connection's deployment can't serve is `UNSUPPORTED`. `docs/divergences/bitbucket.json` records the one argument it spells differently: `pr diff [id]` is optional, since Cloud diffs a commit spec instead.
