---
description: One body of work, its repositories, tracker, pipelines and environments, mapped to the connections that reach them. Why toil projects exist, where they live, one field by field, and how to create, check, use and share one
---

# What is a toil project?

A **toil project** is one body of work, meaning its repositories, tracker, pipelines and
environments, mapped to the connections that reach them. It's a small JSON file that
says "for `card-payments`, Jira is project `PAY` on `jira.imagile.dev`, the code is
`payments-core` in Bitbucket, Jenkins builds the `payments-core` job, and dev runs in
the `payments-dev` namespace". It holds no secret, can't add a host and can't turn on
writes. It only chooses among connections you already have.

A toil project is what earlier versions called a dossier. Searching for the old word
lands here: the commands, flags, folders, variables and warnings that carried it have
new names, listed under **Moving from dossiers**, below.

<!-- figure: toil-project-map -->

In words: the repository you work in matches the toil project `card-payments`. The toil project
has one section per area (Jira, Bitbucket, Jenkins, and OpenShift per environment),
and each section picks one of your own connections by its host. The connection holds
the credential and is the only thing that talks to the host.

## Why it exists

- **One name instead of the same flags on every call.** Without a toil project, every
  command repeats where the work lives:
  `toil bitbucket pr list --connection corp-bitbucket --project PAY --repo payments-core`.
  With one, inside a clone of `payments-core` it's `toil bitbucket pr list`, and from
  anywhere else `toil bitbucket pr list --toil-project card-payments`. A value you pass
  still wins over the toil project's.
- **Scoping for agents.** An agent working in the repository gets the right project,
  repository and connection without being told, and every envelope says where each
  value came from (`meta.context`). The toil project can't widen what the agent may do: it
  holds no credential, can't point a connection at a new host, and a write on a
  connection it chose waits until you adopt it (**Writes**, below).
- **What Toil UI shows.** Toil UI draws one dashboard per toil project, opening on its
  briefing: the stories, pull requests, builds and deployments of exactly the areas
  the toil project names.
- **Knowledge that outlives the handover.** Repositories, project keys, field ids,
  boards and namespaces are written down once, in a file a team can review, instead
  of in one person's shell history.

<!-- figure: toil-project-cartoon -->

## Areas, connections and toil projects

Three words, three jobs:

- **An area** is a kind of service toil speaks to: `jira`, `bitbucket`, `jenkins`,
  `openshift`. Each has its own commands and its own file in this skill.
- **A connection** is one instance of an area, set up by a person in
  `~/.toil/config.json` or env vars: its host (`baseUrl`), its credential (in the OS
  credential store or an env var, never the file) and whether `writes` are on.
  `toil connections list` names yours. A toil project never holds any of this.
- **A toil project** is one body of work: which connection each area uses for it, and the
  keys a call needs there (a project, a repository, a namespace per environment).
  Anyone, an agent included, may build one with `toil projects`.

Credentials stay with connections; knowledge about the work goes in toil projects. That
split is why a toil project may be checked into a repository when config may not.

## How a call uses a toil project

<!-- figure: toil-project-resolution -->

Every area command runs the same steps, on the CLI and over MCP alike:

1. **Pick the toil project.** `--toil-project <name|file>` (or `TOIL_PROJECT`) if given, else
   the one whose repository matches the folder you're in, by its path or its git
   remote. `--cwd <dir>` looks from another folder. No match means no toil project, and the
   command needs its inputs as flags, as it always would.
2. **Pick the section.** The area's section, or `environments.<env>.<area>` for the
   environment: the call's `--env` when the area has one, else the toil project's `env`.
3. **Fill the inputs.** Each context input the area declares (`--project`, `--repo`,
   `--owner`) resolves in one order: the call's own value, then the toil project, then the
   git remote, then the connection's setting, then the area's default. (A per-repo
   toil project value that no repo of the toil project matched stops there instead: see
   "Several services, one product?" below.)
   `toil <area> --help` says which inputs a toil project can fill ("defaults to your
   toil project's …").
4. **Pick the connection.** By the section's `connection` name, or by its `host`,
   which selects your connection whose `baseUrl` has that host. toil never sends
   anything to a host because a toil project named it; the host is only a selector.
5. **Send the request** with that connection's credential, and report what was used
   in `meta.context`.

A real envelope from `toil bitbucket pr list`, run in a clone of `payments-core`
(the host doesn't resolve, which is the point of a placeholder):

```json
"meta": {
  "context": {
    "toilProject": { "name": "card-payments", "source": "user", "by": "folder", "match": "remote", "repo": "payments-core" },
    "connection": { "value": "corp-bitbucket", "source": "toil-project", "host": "bitbucket.imagile.dev" },
    "inputs": {
      "project": { "value": "PAY", "source": "toil-project" },
      "repo": { "value": "payments-core", "source": "toil-project" }
    }
  }
}
```

The request it sent was
`GET https://bitbucket.imagile.dev/rest/api/1.0/projects/PAY/repos/payments-core/pull-requests`.

## A toil project, field by field

`~/.toil/projects/card-payments.json`, as `toil projects` writes it, with notes added:

```jsonc
{
  "name": "card-payments",                      // how you call it: --toil-project card-payments
  "description": "Card payments v2: tokenised cards at the edge.",
  "env": "dev",                                 // the default environment; a key of "environments"
  "repos": [                                    // how toil knows you're in this work
    { "name": "payments-core",
      "remotes": ["ssh://git@bitbucket.imagile.dev:7999/pay/payments-core.git"] }
  ],
  "jira": {                                     // one section per area
    "host": "jira.imagile.dev",                 // selects your Jira connection on this host
    "project": "PAY",                           // a context input: fills --project
    "fields": { "storyPoints": "customfield_10002" },  // so --field storyPoints=5 works
    "transitions": { "Story": { "review": "Peer Review" } }   // so --to review finds it
  },
  "bitbucket": { "host": "bitbucket.imagile.dev", "project": "PAY", "repo": "payments-core" },
  "jenkins": { "host": "jenkins.imagile.dev", "jobs": ["payments-core"] },   // "jobs": reference data
  "environments": {
    "dev":  { "openshift": { "host": "api.ocp-nonprod.imagile.dev", "namespace": "payments-dev" } },
    "prod": { "openshift": { "host": "api.ocp.imagile.dev", "namespace": "payments-prod" } }
  },
  "people": [                                   // who is who in each system
    { "name": "Pat Example", "email": "you@example.com",
      "ids": { "jira": "pat", "github": "pat-ex", "ado": "you@example.com" } },
    { "name": "Claude", "kind": "agent", "ids": { "github": "claude" } }
  ],
  "wipLimit": 3                                 // items one person may have in progress at once
}
```

- **`name`**: lowercase letters, digits and single hyphens, like a connection's name.
- **`description`**: for people, and for the toil project list in Toil UI.
- **`env`**: the environment calls use when they don't pass `--env`.
- **`repos`**: each has a `name`, optional `remotes` and an optional local `path`. A
  folder matches by path first, then by its `origin` remote, so a fresh clone anywhere
  still resolves. Remotes are only compared, never contacted, and toil strips any
  credential from one before storing it.
- **An area's section** (`jira`, `bitbucket`, …) holds:
  - `host` or `connection`, never both. `host` suits a shared toil project, since
    teammates name their connections differently; `connection` names one of yours.
    With neither, the area's default connection is used.
  - the area's context inputs by name (`project`, `repo`, `owner`). A value may also
    be an object of repo name to value, for a toil project with several repositories.
  - `fields`: friendly names for custom field ids, used by `--field`.
    Toil UI also reads the Open Work Item keys there (`estimate`, `estimateUnit`,
    `priority`, `type`, `team`, `dueDate`, `iteration`) when it maps the area's work
    items, and for a GitHub repository with no board, `estimateLabel` (the label that
    holds an estimate, `{n}` for the number: `"estimateLabel": "size/{n}"`) and
    `iterationDays` (how many days each milestone runs as a sprint, as text like every
    value in `fields`: `"iterationDays": "14"`, not `14`). Without them a
    GitHub issue's milestone is its sprint and a `points: N` label its estimate.
  - `transitions`: per work item type, the transition or status each intent
    (`start`, `review`, `done`, `reopen`) means, used first by `--to` on `issue
    transition` and `work-item transition` (`core.md`, **Moving work items by
    intent**). Anything else under it fails `toil projects check`.
  - anything else (`jobs`, `boards`, `deployments`, an OpenShift `namespace`) is
    **reference data**: kept as written for people, agents, Toil UI and
    `check-toil-project` to read, and never applied to a call. Adding one says so in
    `meta.warnings`.
- **`environments`**: per environment, sections that replace the area's own section
  when that environment applies (`--env prod`, or the toil project's `env`).
- **`people`**: the team, agents included, each with a `name`, an optional `kind`
  (`human`, the default, or `agent`), an optional `email`, and `ids`: the account each
  area knows them by, keyed by area. An identity is the user name, login or email that
  system shows (a Jira user name, a GitHub login, an Azure DevOps unique name or
  email, a Bitbucket Cloud account id); a `jira` or `ado` identity covers the Cloud
  variant too unless the toil project names it. It is never a credential: toil refuses a
  value shaped like a token, and one account can be only one person's. The `email` is
  only compared, so Toil UI can suggest which unmapped accounts are probably theirs;
  it never maps one by itself. Toil UI's People view reads this section, and an item
  assigned on the tracker to one of the toil project's agents is queued in Toil UI's Agent
  inbox, where it waits for a person to start it.
- **`wipLimit`**: how many items one person may have in progress at once, as the team
  agreed. Toil UI counts each person's work in progress against it, and `toil projects
  brief` flags anyone over it (**Brief**).
- **`analyze`**: how Analyze briefs the toil project: its goal, reader, lenses and what to
  watch for or leave out (**Analyze**). Absent, the standard applies.

## Where toil projects live

<!-- figure: toil-project-sources -->

toil reads toil projects on every area command from three kinds of place, and every
listing says which one each came from (`source`):

1. **Your own**, `~/.toil/projects/<name>.json` (`user`). The commands that build a
   toil project write here.
2. **Folders you list**, in `"projectPaths"` in your config or `TOIL_PROJECT_PATHS`
   (`listed`): a team repository of toil projects, cloned once. toil reads only folders you
   list and never searches for others.
3. **The repository you're in**, `.toil/projects/*.json` at its root (`repo`). A
   service can carry its own toil project.

A file passed by path (`--toil-project ./card-payments.json`) is a fourth, `file`.

Over MCP and the API the input is `toilProject`, not `--toil-project`.

toil still reads the folders earlier versions used, `~/.toil/dossiers/` and
`.toil/dossiers/` in a repository, and warns `TOIL_PROJECT_OLD_FOLDER`. When the same
name is in both, the `projects/` folder wins.

**Same name in two places:** your own wins, then a listed folder, then the
repository, so you can override a teammate's copy without editing it.
`toil projects list` shows the one left out under `shadowedBy`, and the call warns.
**Two different toil projects that both match** the folder fail with `INVALID_INPUT` until
you pass `--toil-project`. toil never guesses, and never picks the one you used last.

## Create, check, use, share

### Create

On the command line, or let an agent run the same commands:

```bash
toil repos scan
toil projects init card-payments --description "Card payments v2"
toil projects add-repo card-payments ./payments-core
toil projects link card-payments jira --host jira.imagile.dev --set project=PAY
toil projects link card-payments bitbucket --host bitbucket.imagile.dev --set project=PAY --set repo=payments-core
toil projects env card-payments dev openshift --host api.ocp-nonprod.imagile.dev --default
toil projects field card-payments jira storyPoints customfield_10002
toil projects person card-payments "Pat Example" --id jira=pat --id github=pat-ex --email you@example.com
toil projects person card-payments Claude --kind agent --id github=claude
toil projects wip-limit card-payments 3
toil projects describe card-payments --name payments-v2 --description "Card payments v2"
```

`toil projects person` adds a person, or more identities to one already there. Besides
`--id area=identity`, `--github <login>`, `--jira <identity>`, `--ado <identity>` and
`--bitbucket <identity>` each fill in their own area, so `toil projects person card-payments
"Pat Example" --github pat-ex --jira pat --ado you@example.com` maps one person across
every work-tracking system.
Removing a person or an identity (`--remove`) and clearing the limit
(`toil projects wip-limit <toil project> --clear`) are deletes, so they run on the CLI only.
`toil projects describe <toil project> [--name <new name>] [--description <text>]`
renames one of your own toil projects, moving its file with everything in it, or replaces
its one-line description. A name you already use is refused, and so is a checked-in
or listed toil project: import it first, then describe your copy.
`toil projects archive <toil project>` puts one of your own away: it sets `archived: true`
in the file, and `toil projects unarchive <toil project>` brings it back. Nothing is
deleted, so it is not a delete and is served over MCP. `toil projects list` leaves
archived ones out and says how many (`archivedHidden`); `--all` lists everything and
`--archived` only the archived ones. Archiving only hides: a folder in one of its repos
still resolves to it, so calls keep their context, and `show` reports `archived`.

### Map accounts to people, and share the mapping

An account no person is mapped to (a GitHub login, a Jira account id, an Azure DevOps
identity, a Bitbucket user) shows up in Toil UI's People view with a **Map** button, and
in the CLI through two commands, each reading one source (the caller composes):

```sh
toil github pr list --repo imagile/payments | toil util owi map | toil projects people suggest card-payments
toil projects people save card-payments --repo .
```

- `toil projects people suggest <toil-project>` reads OWI records (the same input
  `projects brief` takes, a file, `--text` or stdin) and sets the accounts they name
  (assignee, reporter, who moved an item, pull request author and reviewers) against the
  toil project's people. It returns `suggestions` (each with the `person` it fits, or null
  for a new one, a `reason` of `email`, `name` or `login`, `because`, and the
  `projects person` `command` that applies it), `unmapped` (accounts nothing fit, to map by
  hand), `ambiguous` (why an account that fit more than one person suggests nothing) and
  `read` (how many accounts it looked at). It maps nothing and asks no service.
- `toil projects people save <toil-project> [--repo <dir>] [--replace]` writes the people
  into `<repo>/.toil/projects/<name>.json`, so teammates who clone the repository share the
  mapping, whether it is hosted on GitHub, Azure DevOps or Bitbucket: it is only a file.
  If the file is there, only its people change (a person it lists differently is refused
  unless `--replace`, and people only it lists are kept); if not, the whole toil project is
  written as a shared one, as `projects export` does. It never stages or commits, and a
  toil project holds no secret, so none is written.

Each command returns the change it made, refuses a value that's already there unless
`--replace`, and needs no `--allow-write`, since it only writes your own toil project.
The same steps are under **Settings → Toil projects** in Toil UI, where a toil project's name
and description are also edited in place on its card and dashboard, and, apart from
people, the limit and `describe`, under **Toil projects** in the menu a bare `toil` opens.
Both run these commands; neither edits the file itself.

### Check

`toil projects check card-payments` finds problems **without contacting any
service**: keys given twice, an unknown section, a `connection` you don't have, a
`host` that matches none of your connections or more than one, a remote with a
credential in it. Each problem names its key path:

```json
{ "level": "error", "code": "TOIL_PROJECT_HOST_UNMATCHED", "path": "sonar.host",
  "message": "Toil project card-payments uses the sonar connection on sonar.imagile.dev, and you have no sonar connection with that host." }
```

`toil jira check-toil-project --toil-project card-payments` goes one step further and asks the
service whether each project and field id the toil project names exists. `jira`,
`confluence`, `sonar`, `ado`, `bitbucket`, `github`, `openshift` and
`dynatrace` each have one.

### Use

Work in the repository and the toil project applies by itself, or pass
`--toil-project card-payments` from anywhere. Before a call, `toil projects context` says
which toil project the folder resolves to and why, and `toil projects show card-payments`
says, per area, the connection a call would use, whether writes are on for it, the
environment and the inputs it supplies. For an area with Data Center and Cloud
deployments (`jira`, `confluence`) the connection also carries `deployment`
(`server` or `cloud`); other areas, `db` included, have no such field.

### Brief

`toil projects brief card-payments` says what needs a person in the toil project's work,
and what to do first. It reads the work items and pull requests you pass it as Open
Work Items, and contacts no service: read each tracker and code host with its own
command, map it, and pipe it in.

```bash
toil jira issue search --toil-project card-payments --jql "project = PAY AND statusCategory != Done" --fields "summary,status,assignee,updated,issuelinks,Sprint,Story Points" | toil util owi map > items.owi.json
toil bitbucket pr get 311 --toil-project card-payments --include reviews,checks | toil util owi map --key-pattern "PAY-{n}=corp-jira" > prs.owi.json
cat items.owi.json prs.owi.json > work.owi.json
toil projects brief card-payments --file work.owi.json
```

Blocked needs `issuelinks`, and Sprint at risk needs the sprint and estimate fields.
`pr list` returns no reviews or checks, so map each open pull request's `pr get
--include reviews,checks` as well: with a list alone, failing checks and waiting on
review can't test anything, and `lenses[].note` says so. Several `util owi map`
outputs can go in together, one after another, in one file or on stdin. The lenses
apply in order, and each item goes under the first one that flags it, so it appears
once:

| Lens | Flags |
|---|---|
| Failing checks | Checks on an open pull request for an open item have failed for more than 24 hours |
| Blocked | An open item waits on another open item |
| Waiting on review | An open pull request has had no first review for more than 2 working days |
| Sprint at risk | At the pace so far, the current sprint won't finish the points in it |
| Stale | An item in progress has had no update for more than 5 days |
| Over the WIP limit | Someone has more items in progress than the toil project's `wipLimit` |
| Ticket and pull request disagree | An item is done while its pull request is open, or its pull request merged while it's still open |
| Not ready | Off, and not checked here: readiness is worked out in Toil UI |

The result has a `recommendation`, one `reasons` entry per lens that found something
(its `line` says how much it holds up), and `onTrack`, which counts what's left
rather than listing it. Each item has `why`, the `evidence` it rests on, its
`source`, what it `holds` up down a `blocks` chain, its pull requests, and `url`,
which opens it in its tracker. Sentences cite items and pull requests as
`[[<owi id>]]`, the id each one has in the result. Each lens in `lenses` says
whether it ran, how many items it couldn't test for a missing field (`untested`),
and why in `note`. `--as-of` briefs as of another moment.

The menu a bare `toil` opens does all of this for you: **Toil projects**, a toil project,
**Brief this toil project** runs each read (an Azure DevOps project's work items as a WIQL
search, then one `work-item get-many` for them, the newest 1000 when there are more), the toil project's open pull
requests in full (up to 20), the map and the brief, showing every command as it goes,
then the briefing, with any read that failed or was cut short named at its top. Each
key on it opens its ticket where the terminal draws links (Windows Terminal, VS Code,
iTerm2, WezTerm, Ghostty, and VTE terminals such as GNOME Terminal from 0.50), and
its URL is printed under it anywhere else.

### Analyze

The briefing by code finds what's wrong; Analyze, run by an agent, weighs it and
writes what to do. A toil project tunes how, starting from one standard:

```bash
toil projects analyze set card-payments --goal "Card payments v2 live for all merchants by 31 Oct." --threshold waiting=3 --off stale
toil projects analyze show card-payments
toil projects analyze prompt card-payments
```

`set` takes a goal, the reader (`--audience lead`, `engineer` or `stakeholder`), the
lens order (`--order blocked,failing`), lenses turned `--on` or `--off`, a lens's
`--threshold id=n`, and words for the agent, `--watch-for` and `--leave-out`, up to
1000 characters each. Anything you don't set follows the standard, and `brief`
applies the same order, lenses and thresholds. A value already there needs
`--replace`; `--clear <setting>` and `--reset` go back to the standard, on the CLI
only. They're stored under `"analyze"` in the toil project file, so a team that shares
the toil project shares them.

`prompt` prints the prompt an agent runs: how to read the toil project with toil's tools
and brief it, the method with the toil project's lenses, its focus, and how to answer,
with every work item and pull request as a Markdown link to its tracker. `toil mcp`
serves the same prompt as `analyze`, so an agent client lists it with its prompts.
A focus from a toil project you haven't adopted (one checked into a repository) still
applies, and the prompt says where it came from and that you haven't adopted it.
The agent is told to list anything `--leave-out` hid, so nothing drops off the
briefing unsaid.

### Share

A toil project a team shares selects each area's connection by `host`, because teammates
name their connections differently. toil makes that the default:

- `toil projects init card-payments --shared` creates it in the repository's
  `.toil/projects/` (`--repo <root>` for another working tree).
- `toil projects link` or `env` with `--connection` on a checked-in or listed toil project
  records that connection's host instead. On a terminal it asks first, and you may
  keep the name; anywhere else it records the host and warns `TOIL_PROJECT_HOST_RECORDED`.
- `toil projects check` warns `TOIL_PROJECT_CONNECTION_SHARED` for a checked-in toil project
  that names a connection, and shows the `host` to use instead.

`toil projects export card-payments --repo .` writes a copy of one of your own into
the repository's `.toil/projects/`, with host selectors and no local paths. Commit it
yourself; toil never commits. A teammate with a clone gets it with no setup beyond
their own connections: `toil projects onboard` (below) sets those up. `toil projects
import .toil/projects/card-payments.json` copies it into their own folder instead,
listing any connection they still need under `toSetUp`.

### Writes

A write on a connection the toil project chose waits for you. A toil project in your own folder
is yours, so its choices are too. A checked-in, listed or loose one isn't: a write
through it fails with `WRITE_DISABLED` until you pass `--connection` yourself, or
adopt the toil project with `toil projects import`. The same holds for where the write
lands: a write whose owner, repo or project came from a toil project you haven't adopted
fails with `WRITE_DISABLED`, even on your default connection, until you adopt it or
pass `--owner`, `--repo` or `--project` yourself. Reads, field aliases and transition
pins follow any toil project straight away. Writes still need `writes: true` on
the connection and `--allow-write` on the call, as everywhere. Over MCP, and in Toil
UI, the toil project commands refuse to point a toil project at a connection with writes on; a
person makes that link on the command line.

## Onboarding to a repo that has a toil project

<!-- figure: toil-project-onboard -->

Clone a repository with a toil project in `.toil/projects/`, then run one command in it:

```bash
toil projects onboard
```

For each area the toil project covers, it looks for your connection the way a call would:

- **One matches** the section's `host` (or its `connection` name, or your default):
  it says so, and uses it.
- **None matches:** it offers to add one through `toil connections add`, with a base
  URL on that host already offered (`https://api.github.com` for `github.com`) and the
  token typed hidden, straight into your OS credential store. A base URL on another
  host is refused before anything is saved.
- **Several match:** it asks which one, and pins it in your own copy,
  `~/.toil/projects/<name>.json`. That copy then applies wherever the checked-in one
  does, and since it is yours, writes may follow it.

It ends with `toil projects check` and one test read per connection (the same read
`toil connections test` sends), and the CLI exits 1 unless every area resolved and
read. `--pin <area>=<connection>` answers the several-match question without asking,
for every section of the area; `--pin environments.prod.github=<connection>` pins one
section apart from the rest.
With no terminal, or with `--plan`, it asks nothing and adds no connection: each area
says what it needs and the command that sets it up (a `--pin` still applies).

It asks for tokens, so it is CLI only, and Toil UI runs it as a person's command
(**Settings → Toil projects**, Set up this repo); it is never an MCP tool. The menu a bare
`toil` opens has it under **Toil projects** too.

## One toil project, three views

<!-- figure: toil-project-views -->

The same file reaches each reader its own way: `toil projects show` on the command
line; for an agent, the `projects_show` tool, the `toil://projects/<name>` resource and
`meta.context` on every call it makes; and a dashboard per toil project in Toil UI.

## Moving from dossiers

The word changed, the file did not: a toil project file has the same contents a dossier
had. What was renamed:

| Was | Now |
|-----|-----|
| the `dossiers` command group | `toil projects …` (the old path works for one beta, with `TOIL_PROJECT_DEPRECATED_NAME`) |
| `<area> check-dossier` | `<area> check-toil-project` |
| `--dossier` | `--toil-project` (one beta of the old flag) |
| MCP input `dossier` | `toilProject` |
| MCP tools `dossiers_*`, `<area>_check_dossier` | `projects_*`, `<area>_check_toil_project` (no alias) |
| `toil://dossiers`, `toil://dossiers/<name>` | `toil://projects`, `toil://projects/<name>` (no alias) |
| `TOIL_DOSSIER`, `TOIL_DOSSIER_PATHS` | `TOIL_PROJECT`, `TOIL_PROJECT_PATHS` (old names read, with a warning) |
| `dossierPaths` in config | `projectPaths` (config version 4) |
| `~/.toil/dossiers/`, `.toil/dossiers/` | `~/.toil/projects/`, `.toil/projects/` |
| warnings `DOSSIER_*` | `TOIL_PROJECT_*` |
| `meta.context.dossier` | `meta.context.toilProject` |

To convert a setup, follow `upgrading.md`: `toil connections migrate` for the config
file, `toil projects migrate` for `~/.toil/dossiers/`, and `git mv` for a repository.

## FAQ

- **Do I need a toil project?** No. Without one, commands take their inputs as flags or
  from the connection, exactly as before.
- **Is it safe to commit one?** Yes, that's what it's for. It holds no secret and no
  `writes`, and can only choose among connections each reader already has.
- **Does toil contact the hosts in it?** Never because a toil project named them. A host
  is compared with your connections' hosts, nothing more.
- **Several services, one product?** One toil project, several `repos`, and per-repo values
  where they differ (`"repo": { "payments-core": "payments-core", "ledger": "ledger-svc" }`).
  From a folder that is none of those repos, a call that needs a per-repo value fails
  (`INVALID_INPUT`, naming the repos) rather than use git's or the connection's: use
  `--cwd` inside one of them, or pass the flag (passing another per-repo input, such
  as `--repo`, lets the rest resolve as usual, with a warning naming where each came from). A call that doesn't strictly need it
  carries a `TOIL_PROJECT_REPO_UNMATCHED` warning instead, and a later "could not
  determine" error is that warning's consequence.
- **One service in several products?** Put a toil project in each, and pass `--toil-project`
  when the folder matches both.
- **Edits while `toil mcp` runs?** Toil projects are read on every call, so an edit applies
  from the next one.

## Common mistakes

- **A `host` with no connection behind it.** `toil projects check` reports
  `TOIL_PROJECT_HOST_UNMATCHED`; the call fails with `NOT_CONFIGURED` and names the
  command to add one. It never falls back to the default connection.
- **Expecting reference data to fill a flag.** Only an area's context inputs fill
  flags. The warning when you add a key says which it is.
- **Two toil projects for one folder.** The call fails until you pass `--toil-project`. Merge
  them, or keep one in another repository.
- **A write through a teammate's toil project.** `WRITE_DISABLED`, by design: adopt it with
  `toil projects import`, or pass `--connection` and the target flags (`--owner`,
  `--repo`, `--project`) yourself. Over MCP, ask the user to adopt it.
- **A token in a remote.** toil strips userinfo before storing a remote, and
  `toil projects check` fails a hand-edited file that still has one
  (`TOIL_PROJECT_REMOTE_USERINFO`).
- **Editing the JSON by hand and giving a key twice.** JSON parsers keep the last one
  quietly; toil reports `TOIL_PROJECT_DUPLICATE_KEY` with its path instead.
