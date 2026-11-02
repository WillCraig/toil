---
description: One body of work, its repositories, tracker, pipelines and environments, mapped to the connections that reach them. Why dossiers exist, where they live, one field by field, and how to create, check, use and share one
---

# What is a dossier?

A **dossier** is one body of work, meaning its repositories, tracker, pipelines and
environments, mapped to the connections that reach them. It's a small JSON file that
says "for `card-payments`, Jira is project `PAY` on `jira.imagile.dev`, the code is
`payments-core` in Bitbucket, Jenkins builds the `payments-core` job, and dev runs in
the `payments-dev` namespace". It holds no secret, can't add a host and can't turn on
writes. It only chooses among connections you already have.

<!-- figure: dossier-map -->

In words: the repository you work in matches the dossier `card-payments`. The dossier
has one section per area (Jira, Bitbucket, Jenkins, and OpenShift per environment),
and each section picks one of your own connections by its host. The connection holds
the credential and is the only thing that talks to the host.

## Why it exists

- **One name instead of the same flags on every call.** Without a dossier, every
  command repeats where the work lives:
  `toil bitbucket pr list --connection corp-bitbucket --project PAY --repo payments-core`.
  With one, inside a clone of `payments-core` it's `toil bitbucket pr list`, and from
  anywhere else `toil bitbucket pr list --dossier card-payments`. A value you pass
  still wins over the dossier's.
- **Scoping for agents.** An agent working in the repository gets the right project,
  repository and connection without being told, and every envelope says where each
  value came from (`meta.context`). The dossier can't widen what the agent may do: it
  holds no credential, can't point a connection at a new host, and a write on a
  connection it chose waits until you adopt it (**Writes**, below).
- **What Toil UI shows.** Toil UI draws one dashboard per dossier, opening on its
  briefing: the stories, pull requests, builds and deployments of exactly the areas
  the dossier names.
- **Knowledge that outlives the handover.** Repositories, project keys, field ids,
  boards and namespaces are written down once, in a file a team can review, instead
  of in one person's shell history.

<!-- figure: dossier-cartoon -->

## Areas, connections and dossiers

Three words, three jobs:

- **An area** is a kind of service toil speaks to: `jira`, `bitbucket`, `jenkins`,
  `openshift`. Each has its own commands and its own file in this skill.
- **A connection** is one instance of an area, set up by a person in
  `~/.toil/config.json` or env vars: its host (`baseUrl`), its credential (in the OS
  credential store or an env var, never the file) and whether `writes` are on.
  `toil connections list` names yours. A dossier never holds any of this.
- **A dossier** is one body of work: which connection each area uses for it, and the
  keys a call needs there (a project, a repository, a namespace per environment).
  Anyone, an agent included, may build one with `toil dossiers`.

Credentials stay with connections; knowledge about the work goes in dossiers. That
split is why a dossier may be checked into a repository when config may not.

## How a call uses a dossier

<!-- figure: dossier-resolution -->

Every area command runs the same steps, on the CLI and over MCP alike:

1. **Pick the dossier.** `--dossier <name|file>` (or `TOIL_DOSSIER`) if given, else
   the one whose repository matches the folder you're in, by its path or its git
   remote. `--cwd <dir>` looks from another folder. No match means no dossier, and the
   command needs its inputs as flags, as it always would.
2. **Pick the section.** The area's section, or `environments.<env>.<area>` for the
   environment: the call's `--env` when the area has one, else the dossier's `env`.
3. **Fill the inputs.** Each context input the area declares (`--project`, `--repo`,
   `--owner`) resolves in one order: the call's own value, then the dossier, then the
   git remote, then the connection's setting, then the area's default. (A per-repo
   dossier value that no repo of the dossier matched stops there instead: see
   "Several services, one product?" below.)
   `toil <area> --help` says which inputs a dossier can fill ("defaults to your
   dossier's …").
4. **Pick the connection.** By the section's `connection` name, or by its `host`,
   which selects your connection whose `baseUrl` has that host. toil never sends
   anything to a host because a dossier named it; the host is only a selector.
5. **Send the request** with that connection's credential, and report what was used
   in `meta.context`.

A real envelope from `toil bitbucket pr list`, run in a clone of `payments-core`
(the host doesn't resolve, which is the point of a placeholder):

```json
"meta": {
  "context": {
    "dossier": { "name": "card-payments", "source": "user", "by": "folder", "match": "remote", "repo": "payments-core" },
    "connection": { "value": "corp-bitbucket", "source": "dossier", "host": "bitbucket.imagile.dev" },
    "inputs": {
      "project": { "value": "PAY", "source": "dossier" },
      "repo": { "value": "payments-core", "source": "dossier" }
    }
  }
}
```

The request it sent was
`GET https://bitbucket.imagile.dev/rest/api/1.0/projects/PAY/repos/payments-core/pull-requests`.

## A dossier, field by field

`~/.toil/dossiers/card-payments.json`, as `toil dossiers` writes it, with notes added:

```jsonc
{
  "name": "card-payments",                      // how you call it: --dossier card-payments
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
- **`description`**: for people, and for the dossier list in Toil UI.
- **`env`**: the environment calls use when they don't pass `--env`.
- **`repos`**: each has a `name`, optional `remotes` and an optional local `path`. A
  folder matches by path first, then by its `origin` remote, so a fresh clone anywhere
  still resolves. Remotes are only compared, never contacted, and toil strips any
  credential from one before storing it.
- **An area's section** (`jira`, `bitbucket`, …) holds:
  - `host` or `connection`, never both. `host` suits a shared dossier, since
    teammates name their connections differently; `connection` names one of yours.
    With neither, the area's default connection is used.
  - the area's context inputs by name (`project`, `repo`, `owner`). A value may also
    be an object of repo name to value, for a dossier with several repositories.
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
    intent**). Anything else under it fails `toil dossiers check`.
  - anything else (`jobs`, `boards`, `deployments`, an OpenShift `namespace`) is
    **reference data**: kept as written for people, agents, Toil UI and
    `check-dossier` to read, and never applied to a call. Adding one says so in
    `meta.warnings`.
- **`environments`**: per environment, sections that replace the area's own section
  when that environment applies (`--env prod`, or the dossier's `env`).
- **`people`**: the team, agents included, each with a `name`, an optional `kind`
  (`human`, the default, or `agent`), an optional `email`, and `ids`: the account each
  area knows them by, keyed by area. An identity is the user name, login or email that
  system shows (a Jira user name, a GitHub login, an Azure DevOps unique name or
  email, a Bitbucket Cloud account id); a `jira` or `ado` identity covers the Cloud
  variant too unless the dossier names it. It is never a credential: toil refuses a
  value shaped like a token, and one account can be only one person's. The `email` is
  only compared, so Toil UI can suggest which unmapped accounts are probably theirs;
  it never maps one by itself. Toil UI's People view reads this section, and an item
  assigned on the tracker to one of the dossier's agents is queued in Toil UI's Agent
  inbox, where it waits for a person to start it.
- **`wipLimit`**: how many items one person may have in progress at once, as the team
  agreed. Toil UI counts each person's work in progress against it, and `toil dossiers
  brief` flags anyone over it (**Brief**).
- **`analyze`**: how Analyze briefs the dossier: its goal, reader, lenses and what to
  watch for or leave out (**Analyze**). Absent, the standard applies.

## Where dossiers live

<!-- figure: dossier-sources -->

toil reads dossiers on every area command from three kinds of place, and every
listing says which one each came from (`source`):

1. **Your own**, `~/.toil/dossiers/<name>.json` (`user`). The commands that build a
   dossier write here.
2. **Folders you list**, in `"dossierPaths"` in your config or `TOIL_DOSSIER_PATHS`
   (`listed`): a team repository of dossiers, cloned once. toil reads only folders you
   list and never searches for others.
3. **The repository you're in**, `.toil/dossiers/*.json` at its root (`repo`). A
   service can carry its own dossier.

A file passed by path (`--dossier ./card-payments.json`) is a fourth, `file`.

**Same name in two places:** your own wins, then a listed folder, then the
repository, so you can override a teammate's copy without editing it.
`toil dossiers list` shows the one left out under `shadowedBy`, and the call warns.
**Two different dossiers that both match** the folder fail with `INVALID_INPUT` until
you pass `--dossier`. toil never guesses, and never picks the one you used last.

## Create, check, use, share

### Create

On the command line, or let an agent run the same commands:

```bash
toil repos scan
toil dossiers init card-payments --description "Card payments v2"
toil dossiers add-repo card-payments ./payments-core
toil dossiers link card-payments jira --host jira.imagile.dev --set project=PAY
toil dossiers link card-payments bitbucket --host bitbucket.imagile.dev --set project=PAY --set repo=payments-core
toil dossiers env card-payments dev openshift --host api.ocp-nonprod.imagile.dev --default
toil dossiers field card-payments jira storyPoints customfield_10002
toil dossiers person card-payments "Pat Example" --id jira=pat --id github=pat-ex --email you@example.com
toil dossiers person card-payments Claude --kind agent --id github=claude
toil dossiers wip-limit card-payments 3
toil dossiers describe card-payments --name payments-v2 --description "Card payments v2"
```

`toil dossiers person` adds a person, or more identities to one already there.
Removing a person or an identity (`--remove`) and clearing the limit
(`toil dossiers wip-limit <dossier> --clear`) are deletes, so they run on the CLI only.
`toil dossiers describe <dossier> [--name <new name>] [--description <text>]`
renames one of your own dossiers, moving its file with everything in it, or replaces
its one-line description. A name you already use is refused, and so is a checked-in
or listed dossier: import it first, then describe your copy.

Each command returns the change it made, refuses a value that's already there unless
`--replace`, and needs no `--allow-write`, since it only writes your own dossier.
The same steps are under **Settings → Dossiers** in Toil UI, where a dossier's name
and description are also edited in place on its card and dashboard, and, apart from
people, the limit and `describe`, under **Dossiers** in the menu a bare `toil` opens.
Both run these commands; neither edits the file itself.

### Check

`toil dossiers check card-payments` finds problems **without contacting any
service**: keys given twice, an unknown section, a `connection` you don't have, a
`host` that matches none of your connections or more than one, a remote with a
credential in it. Each problem names its key path:

```json
{ "level": "error", "code": "DOSSIER_HOST_UNMATCHED", "path": "sonar.host",
  "message": "Dossier card-payments uses the sonar connection on sonar.imagile.dev, and you have no sonar connection with that host." }
```

`toil jira check-dossier --dossier card-payments` goes one step further and asks the
service whether each project and field id the dossier names exists. `jira`,
`confluence`, `sonar`, `ado`, `bitbucket`, `github`, `openshift` and
`dynatrace` each have one.

### Use

Work in the repository and the dossier applies by itself, or pass
`--dossier card-payments` from anywhere. Before a call, `toil dossiers context` says
which dossier the folder resolves to and why, and `toil dossiers show card-payments`
says, per area, the connection a call would use, whether writes are on for it, the
environment and the inputs it supplies. For an area with Data Center and Cloud
deployments (`jira`, `confluence`) the connection also carries `deployment`
(`server` or `cloud`); other areas, `db` included, have no such field.

### Brief

`toil dossiers brief card-payments` says what needs a person in the dossier's work,
and what to do first. It reads the work items and pull requests you pass it as Open
Work Items, and contacts no service: read each tracker and code host with its own
command, map it, and pipe it in.

```bash
toil jira issue search --dossier card-payments --jql "project = PAY AND statusCategory != Done" --fields "summary,status,assignee,updated,issuelinks,Sprint,Story Points" | toil util owi map > items.owi.json
toil bitbucket pr get 311 --dossier card-payments --include reviews,checks | toil util owi map --key-pattern "PAY-{n}=corp-jira" > prs.owi.json
cat items.owi.json prs.owi.json > work.owi.json
toil dossiers brief card-payments --file work.owi.json
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
| Over the WIP limit | Someone has more items in progress than the dossier's `wipLimit` |
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

The menu a bare `toil` opens does all of this for you: **Dossiers**, a dossier,
**Brief this dossier** runs each read (an Azure DevOps project's work items as a WIQL
search, then one `work-item get-many` for them, the newest 1000 when there are more), the dossier's open pull
requests in full (up to 20), the map and the brief, showing every command as it goes,
then the briefing, with any read that failed or was cut short named at its top. Each
key on it opens its ticket where the terminal draws links (Windows Terminal, VS Code,
iTerm2, WezTerm, Ghostty, and VTE terminals such as GNOME Terminal from 0.50), and
its URL is printed under it anywhere else.

### Analyze

The briefing by code finds what's wrong; Analyze, run by an agent, weighs it and
writes what to do. A dossier tunes how, starting from one standard:

```bash
toil dossiers analyze set card-payments --goal "Card payments v2 live for all merchants by 31 Oct." --threshold waiting=3 --off stale
toil dossiers analyze show card-payments
toil dossiers analyze prompt card-payments
```

`set` takes a goal, the reader (`--audience lead`, `engineer` or `stakeholder`), the
lens order (`--order blocked,failing`), lenses turned `--on` or `--off`, a lens's
`--threshold id=n`, and words for the agent, `--watch-for` and `--leave-out`, up to
1000 characters each. Anything you don't set follows the standard, and `brief`
applies the same order, lenses and thresholds. A value already there needs
`--replace`; `--clear <setting>` and `--reset` go back to the standard, on the CLI
only. They're stored under `"analyze"` in the dossier file, so a team that shares
the dossier shares them.

`prompt` prints the prompt an agent runs: how to read the dossier with toil's tools
and brief it, the method with the dossier's lenses, its focus, and how to answer,
with every work item and pull request as a Markdown link to its tracker. `toil mcp`
serves the same prompt as `analyze`, so an agent client lists it with its prompts.
A focus from a dossier you haven't adopted (one checked into a repository) still
applies, and the prompt says where it came from and that you haven't adopted it.
The agent is told to list anything `--leave-out` hid, so nothing drops off the
briefing unsaid.

### Share

A dossier a team shares selects each area's connection by `host`, because teammates
name their connections differently. toil makes that the default:

- `toil dossiers init card-payments --shared` creates it in the repository's
  `.toil/dossiers/` (`--repo <root>` for another working tree).
- `toil dossiers link` or `env` with `--connection` on a checked-in or listed dossier
  records that connection's host instead. On a terminal it asks first, and you may
  keep the name; anywhere else it records the host and warns `DOSSIER_HOST_RECORDED`.
- `toil dossiers check` warns `DOSSIER_CONNECTION_SHARED` for a checked-in dossier
  that names a connection, and shows the `host` to use instead.

`toil dossiers export card-payments --repo .` writes a copy of one of your own into
the repository's `.toil/dossiers/`, with host selectors and no local paths. Commit it
yourself; toil never commits. A teammate with a clone gets it with no setup beyond
their own connections: `toil dossiers onboard` (below) sets those up. `toil dossiers
import .toil/dossiers/card-payments.json` copies it into their own folder instead,
listing any connection they still need under `toSetUp`.

### Writes

A write on a connection the dossier chose waits for you. A dossier in your own folder
is yours, so its choices are too. A checked-in, listed or loose one isn't: a write
through it fails with `WRITE_DISABLED` until you pass `--connection` yourself, or
adopt the dossier with `toil dossiers import`. The same holds for where the write
lands: a write whose owner, repo or project came from a dossier you haven't adopted
fails with `WRITE_DISABLED`, even on your default connection, until you adopt it or
pass `--owner`, `--repo` or `--project` yourself. Reads, field aliases and transition
pins follow any dossier straight away. Writes still need `writes: true` on
the connection and `--allow-write` on the call, as everywhere. Over MCP, and in Toil
UI, the dossier commands refuse to point a dossier at a connection with writes on; a
person makes that link on the command line.

## Onboarding to a repo that has a dossier

<!-- figure: dossier-onboard -->

Clone a repository with a dossier in `.toil/dossiers/`, then run one command in it:

```bash
toil dossiers onboard
```

For each area the dossier covers, it looks for your connection the way a call would:

- **One matches** the section's `host` (or its `connection` name, or your default):
  it says so, and uses it.
- **None matches:** it offers to add one through `toil connections add`, with a base
  URL on that host already offered (`https://api.github.com` for `github.com`) and the
  token typed hidden, straight into your OS credential store. A base URL on another
  host is refused before anything is saved.
- **Several match:** it asks which one, and pins it in your own copy,
  `~/.toil/dossiers/<name>.json`. That copy then applies wherever the checked-in one
  does, and since it is yours, writes may follow it.

It ends with `toil dossiers check` and one test read per connection (the same read
`toil connections test` sends), and the CLI exits 1 unless every area resolved and
read. `--pin <area>=<connection>` answers the several-match question without asking,
for every section of the area; `--pin environments.prod.github=<connection>` pins one
section apart from the rest.
With no terminal, or with `--plan`, it asks nothing and adds no connection: each area
says what it needs and the command that sets it up (a `--pin` still applies).

It asks for tokens, so it is CLI only, and Toil UI runs it as a person's command
(**Settings → Dossiers**, Set up this repo); it is never an MCP tool. The menu a bare
`toil` opens has it under **Dossiers** too.

## One dossier, three views

<!-- figure: dossier-views -->

The same file reaches each reader its own way: `toil dossiers show` on the command
line; for an agent, the `dossiers_show` tool, the `toil://dossiers/<name>` resource and
`meta.context` on every call it makes; and a dashboard per dossier in Toil UI.

## FAQ

- **Do I need a dossier?** No. Without one, commands take their inputs as flags or
  from the connection, exactly as before.
- **Is it safe to commit one?** Yes, that's what it's for. It holds no secret and no
  `writes`, and can only choose among connections each reader already has.
- **Does toil contact the hosts in it?** Never because a dossier named them. A host
  is compared with your connections' hosts, nothing more.
- **Several services, one product?** One dossier, several `repos`, and per-repo values
  where they differ (`"repo": { "payments-core": "payments-core", "ledger": "ledger-svc" }`).
  From a folder that is none of those repos, a call that needs a per-repo value fails
  (`INVALID_INPUT`, naming the repos) rather than use git's or the connection's: use
  `--cwd` inside one of them, or pass the flag (passing another per-repo input, such
  as `--repo`, lets the rest resolve as usual, with a warning naming where each came from). A call that doesn't strictly need it
  carries a `DOSSIER_REPO_UNMATCHED` warning instead, and a later "could not
  determine" error is that warning's consequence.
- **One service in several products?** Put a dossier in each, and pass `--dossier`
  when the folder matches both.
- **Edits while `toil mcp` runs?** Dossiers are read on every call, so an edit applies
  from the next one.

## Common mistakes

- **A `host` with no connection behind it.** `dossiers check` reports
  `DOSSIER_HOST_UNMATCHED`; the call fails with `NOT_CONFIGURED` and names the
  command to add one. It never falls back to the default connection.
- **Expecting reference data to fill a flag.** Only an area's context inputs fill
  flags. The warning when you add a key says which it is.
- **Two dossiers for one folder.** The call fails until you pass `--dossier`. Merge
  them, or keep one in another repository.
- **A write through a teammate's dossier.** `WRITE_DISABLED`, by design: adopt it with
  `toil dossiers import`, or pass `--connection` and the target flags (`--owner`,
  `--repo`, `--project`) yourself. Over MCP, ask the user to adopt it.
- **A token in a remote.** toil strips userinfo before storing a remote, and
  `dossiers check` fails a hand-edited file that still has one
  (`DOSSIER_REMOTE_USERINFO`).
- **Editing the JSON by hand and giving a key twice.** JSON parsers keep the last one
  quietly; toil reports `DOSSIER_DUPLICATE_KEY` with its path instead.
