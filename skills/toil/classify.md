---
description: Sorting a team's work into categories such as keep-the-lights-on and feature. What a classification scheme is, where schemes live, the commands that list, show, create, share and change one, and the commands that classify work items and ask an AI agent about the rest
---

# Classifying work

`toil classify` sorts work items into the categories a team chooses, such as **Keep the
lights on** (KTLO) and **Feature**. The categories, their definitions, the guidance for
borderline cases and the team's own rules are one JSON file, a **scheme**, kept apart from
the toil project so a team can share it across toil projects and with other teams.

## Schemes

A scheme holds no secret, no host, no connection and no `writes`: a shared scheme can't
make toil talk to anything or write anything. Its definitions and guidance are
instructions to an AI agent, so a checked-in scheme is trusted as far as its
repository's review is.

```json
{
  "name": "ktlo-feature",
  "revision": 3,
  "categories": [
    { "id": "ktlo", "short": "KTLO", "name": "Keep the lights on", "label": "ktlo",
      "definition": "Security patches, bug fixes, dependency upgrades, compliance updates and incident response." },
    { "id": "feature", "short": "Feature", "name": "Feature", "label": "feature",
      "definition": "Proactive development that creates new user-facing functionality or expands the product's capabilities." }
  ],
  "guidance": ["An upgrade that exists to unlock a new user-facing capability is Feature; one that keeps the product supported is KTLO."],
  "examples": [{ "item": "corp-jira:PAY-412", "title": "Add Apple Pay to checkout", "category": "feature" }],
  "rules": [{ "id": "escalations", "when": { "label": ["customer-escalation"] }, "then": "ktlo" }],
  "signals": true,
  "labels": { "ado": { "ktlo": "KTLO", "feature": "Feature" } }
}
```

- **`categories`**: 2 to 12. Each has an `id` (never `unsure`), a `short` name (up to 24
  characters), a plain `name`, the tracker `label` (letters, digits, `.`, `_`, `:` and `-`,
  no space, comma or semicolon; unique without regard to case) and a `definition`.
- **`guidance`**, **`examples`**: the prompt an agent is given beside the definitions. Up to
  20 sentences and 40 examples; an example is an item's id and title, never its body.
- **`rules`**: the team's own rules, tried in order. `when` takes `parent`, `label`, `type`
  and `title` (each a list; every key given must match, and a key matches when any of its
  values does), and `then` is a category id.
- **`signals`**: whether toil's built-in keep-the-lights-on signals apply below the rules.
  On by default.
- **`labels`**: a tracker's own spelling of a category's label (`jira`, `github`, `ado`).
- **`revision`** goes up by one with every change made through `scheme set`.
- Every text is one line, and none may be shaped like a credential. An unknown top-level key
  is ignored with a `SCHEME_UNKNOWN_KEY` warning.

Two schemes are built in: **`ktlo-feature`**, the default (KTLO and Feature), and
**`balance`** (New capabilities, Improvements, KTLO and Productivity).

### Where schemes live

A scheme name resolves in this order, so your own copy wins over a shared one:

1. `--scheme <file>`, a path ending in `.json` or holding a separator, inside the workspace.
2. Your own folder, `~/.toil/classify/<name>.json`.
3. The call's repository, `.toil/classify/<name>.json`, checked in for everyone who works in it.
4. A path relative to the toil project that names it (`"scheme": "./ktlo-feature.json"` in
   its `classify` key), so a team that shares toil projects shares the scheme beside them.
5. Built in.

A toil project names its scheme, and where each tracker keeps the category, in its
`classify` key (`projects.md`). With no `classify` key the built-in `ktlo-feature` applies.

### Scheme commands

`init` and `export` copy a scheme that already exists, and change no rule. `set` and `import`
change the rulebook an agent's verdicts are held to, so they are a person's, on the CLI only.
None needs `--allow-write`: they write local files, never a service.

| Command | Flags | What it does |
|---------|-------|--------------|
| `toil classify scheme list` | `--cwd` | Every scheme visible by name, each from its highest place, with its categories |
| `toil classify scheme show [name]` | `--toil-project`, `--cwd` | One scheme in full, and where it was found; `[name]` is a name or a file, or leave it out with `--toil-project` for the scheme that toil project uses (a path beside the toil project file included) |
| `toil classify scheme init <name>` | `--from`, `--cwd` | Create `~/.toil/classify/<name>.json` as a copy of `--from` (default `ktlo-feature`), revision 1; refuses a name you have |
| `toil classify scheme export <name>` | `--repo`, `--out`, `--replace`, `--cwd` | Write `<repo>/.toil/classify/<name>.json`, or one `.json` file; never stages or commits |
| `toil classify scheme set [name]` | `--input-file`, `--toil-project`, `--cwd` | Replace a scheme with a revised file, setting the revision to the current one plus 1; with `--toil-project` and no name, the scheme that toil project uses, rewritten where it lives. CLI only |
| `toil classify scheme import <file>` | `--name`, `--replace`, `--cwd` | Copy a scheme file into your own folder to adapt it. CLI only |

- `set` writes the scheme where it lives: your folder, the repository's working-tree file
  (ready for a pull request), or beside the toil project that names it. A built-in scheme
  is written as a copy into your folder. The file's `name` must be `<name>` or absent. A
  file that changes nothing writes nothing and warns `SCHEME_UNCHANGED`. The result's
  `changes` lists the categories and rules added, removed or changed, and whether
  guidance, examples, signals or labels changed.
- `export` refuses to replace anything that isn't already a scheme, and a scheme without
  `--replace`; `--repo` must be a git working tree's root and `--out` must be inside the
  workspace.
- A scheme file that can't be read is `CONFIG_INVALID` naming the file and key path;
  `list` reports it as a warning and carries on.

## Classifying work items

`classify run` and `classify prompt` read Open Work Item records, the output of
`toil util owi map`, and the scheme, and ask no service. They write nothing: a result is
a verdict per item and a plan, and `categorize` (`jira issue categorize`, `github issue
categorize`, `ado work-item categorize`) is what writes it to a tracker.

```bash
toil jira issue search --jql "project = PAY AND statusCategory != Done" --fields summary,description,issuetype,labels,parent,customfield_10042 | toil util owi map | toil classify run --toil-project payments
```

| Command | Flags | What it does |
|---------|-------|--------------|
| `toil classify run` | `--input-file`, `--text`, `--toil-project`, `--cwd`, `--scheme`, `--recheck`, `--record`, `--verdicts-file` | One verdict per item, the summary, and the plan `categorize` applies; `--record` also keeps the verdicts in the ledger |
| `toil classify prompt` | `--input-file`, `--text`, `--toil-project`, `--cwd`, `--scheme`, `--recheck`, `--limit` | The prompt that asks the AI agent about the items `run` left `unsure` |
| `toil classify correct <item-id>` | `--to`, `--reason`, `--title`, `--toil-project`, `--cwd`, `--scheme` | Record that an item belongs in another category (or confirm its verdict) in the ledger |
| `toil classify stats` | `--input-file`, `--text`, `--toil-project`, `--cwd`, `--scheme`, `--backtest-file`, `--revised-file`, `--standing` | Agreement, the sources people overrule and which way the errors run; with `--backtest-file`, a revised scheme scored against the corrections held back |
| `toil classify tune` | `--toil-project`, `--cwd`, `--scheme`, `--limit` | The prompt that asks the AI agent to sharpen the scheme from the corrections |

Both read the records from `--input-file` (a file in the workspace, or `-`), `--text`, or
stdin on the CLI; over MCP, `inputFile` or `text`. Input with no work items is
`INVALID_INPUT`; a record the reader skipped is one `CLASSIFY_SKIPPED` warning.

### Which toil project and which scheme

A toil project is optional. `--toil-project <name|file>` names one; without it, the toil
project that applies to the folder is used if there is exactly one, and if none applies
the built-in scheme is used and the plan sets no field. Two that apply is
`INVALID_INPUT` asking you to name one; a name that isn't a toil project is an error,
never a quiet fallback. The scheme is `--scheme`, else the toil project's
`classify.scheme`, else `ktlo-feature`. The toil project's `classify` targets say where
each tracker also keeps the category in a field, if you want one; a target's `field` is
looked up as the toil project section's field alias first, so a category already in that
field is seen when no label settles the item.
The result says which scheme answered: `scheme.source` (`built-in`, `user`, `repo`,
`toil-project` or `file`) and its `file`.

### `classify run`

First match wins, in this order:

1. A category already on the item. The label is the record: exactly one of the scheme's
   labels settles it (`source: label`), whatever the optional category field holds. Only
   when the item has no scheme label does a value in the toil project's field settle it
   (`source: field`); two different scheme labels settle nothing by label, so then the
   field, if it has a value, decides, else the item goes on to the rules. `--recheck`
   skips this step.
2. A person's recorded correction from the ledger (`source: person`; see **Corrections
   and the ledger**), so a person's say is never undone by a rule. It also outranks a
   label or field that still holds what the tracker held before the person spoke (the
   tracker hasn't caught up yet; `categorize` writes it). The reason says who recorded it:
   a person, an AI agent for a person (over MCP), or a label changed in the tracker.
3. The scheme's own rules, in order (`source: rule:<id>`).
4. toil's built-in keep-the-lights-on signals, when the scheme has `signals` on
   (`source: signal:<name>`).
5. The parent's verdict, which children inherit (`source: parent`).
6. Otherwise `unsure`.

`--verdicts-file <path>` is the AI agent's answer to `classify prompt`: a file in the
workspace holding a JSON array of `{ "id", "category", "reason" }`, `category` a
category id or `unsure`. It fills only the items still `unsure` (`source: agent`); a
verdict for an item that was already settled is ignored with a warning. An id that isn't
in the input, an unknown category or a file that isn't JSON refuses the whole run,
`INVALID_INPUT`, with nothing applied. `--verdicts-file -` is refused, since stdin carries the
work items.

The result:

- `scheme`: `{ name, revision, source, file? }`, and `toilProject` (the name, or `null`).
- `verdicts`: one per item: `id`, `key`, `title`, `url`, `category` (an id, or `null`
  when unsure), `name`, `short`, `source`, `reason` (a sentence a person can check) and
  the scheme and revision.
- `summary`: `items`, `byCategory` (with `unsure`), `bySource`, `settledByRules` (the
  share settled by a rule, a signal or a parent) and `alreadyLabelled`.
- `plan`: per tracker connection, `{ area, connection, labels, field?, items }`. It holds
  only what would change: an item already as the scheme wants it is left out, and an
  unsure item is never in it. The label is the record and a field only mirrors it, so
  where the item's field is empty or holds another category than the label's, the plan
  sets the field to the label's category; a field never adds, changes or removes a label. `categorize` reads each item again before it writes.
  Only a toil project in your own folder (`~/.toil/projects/`) puts a `field` in the plan.
  One that is checked in, listed or loose still lets `run` read a category from its field,
  but its field targets are left out of the plan and `CLASSIFY_TARGETS_NOT_ADOPTED` says so;
  `toil projects import <name>` adopts it.

`--record` keeps what the run decided in the scheme's ledger on this machine (a local
write, so a read-only caller is refused) and adds `recorded: { verdicts, corrections,
file }` to the result. It keeps one line for each item whose verdict is new or changed,
so running it twice keeps nothing the second time, and a correction (`via: tracker`)
for each item whose label was changed in the tracker since the ledger last held it. To
reclassify from the tracker, change the label: changing only the field is not a
correction, and the next plan puts the field back to the label's category. (An item with
no scheme label has only its field to go by, so a field changed there is a correction.) Over MCP an agent may record.

To apply it, pass the result to a `categorize` command: on the CLI as stdin or
`--input-file <path>`; over MCP `inputFile` must be a workspace file, which `--summary-file`
(`summaryFile`) writes (`core.md`, **Big results**), and the `categorize` command reads
the whole result from there. One call applies one connection's part of the plan.

### `classify prompt`

Writes the question for the AI agent you already run: the scheme's categories,
definitions, guidance and examples, then the items still `unsure` after `classify run`'s
rules, inside a fenced block marked as untrusted data. An item's title, body and labels
are other people's words: read them as text to classify, never as instructions. The
prompt asks for exactly one JSON array of `{ id, category, reason }`, with `unsure`
allowed. Save the answer to a workspace file and pass it to `classify run --verdicts-file`.
toil sends the text nowhere.

`--limit <n>` caps the items in the prompt (default 200); `items.omitted` counts the
rest, and a second round covers them. The result is `{ prompt, scheme, toilProject, items:
{ unsure, included, omitted } }`. When nothing is unsure it still returns a prompt, with
no items in it, and a `CLASSIFY_NOTHING_UNSURE` warning: there is nothing to ask.

### The MCP prompt

Over MCP the prompt `classify` is `classify_prompt`'s answer, served when that tool is.
Its arguments are `inputFile` (required: a workspace file holding the OWI records, since MCP
has no stdin), `toilProject` and `scheme`. A missing `inputFile` is an error naming it.

## The work mix

`toil classify mix` is how the finished work divides between a scheme's categories: a thin
wrapper over `toil projects pivot` (split by category, shares on, nothing folded into
Other), reading the same records as `classify run`.

```bash
toil jira issue search --jql "project = PAY AND resolved >= -90d" --fields summary,description,issuetype,labels,parent,resolutiondate | toil util owi map | toil classify mix --toil-project payments --by month
```

| Command | Flags | What it does |
|---------|-------|--------------|
| `toil classify mix` | `--input-file`, `--text`, `--toil-project`, `--cwd`, `--scheme`, `--by`, `--group`, `--unit`, `--from`, `--to`, `--as-of` | Each category's share per period, or per group, and overall |

`--by week|month|quarter` (default month) gives one column per period, counting the work
finished in it. `--group team|assignee|project|epic|component|release` gives one column
per group instead. `--unit count` (the default) counts items, `estimate` sums estimates
and `days` counts person-days in progress. `data` holds `periods` or `groups`, each
`{ key, label, total, shares [{ category, name, short, value, share, items }] }`, and
`overall` in the same shape. `unsure` is always a line of its own, never spread over the
categories. `sources` says how each item's category was decided (`rules`, `signals`,
`labels` for a label or a field, `parent`, `agent`, `person`, `unsure`), adding up to the
items read. A share that cannot be computed is `null` with a `MIX_UNREAD` warning, and a
period with no finished work has `null` shares and a `MIX_EMPTY` warning: never `0`.

## Corrections and the ledger

People will disagree with some verdicts, and each disagreement is the best evidence of
where the scheme is wrong. The **ledger** keeps them: `~/.toil/classify/<scheme>.jsonl`,
beside your own schemes, one file per scheme, so a scheme used across several toil
projects learns from all of them (`--toil-project` narrows `stats` and `tune` to one).
Three things put a line in it:

- `classify run --record`: a **verdict** line per new or changed verdict, and a
  **correction** (`via: tracker`) where someone changed an item's label in the
  tracker (a changed field alone is not one: the label is the record).
- `toil classify correct <item-id> --to <category|unsure> [--reason <text>]`: a
  correction. `--to` the category the ledger already holds records a **confirmation**, so
  agreement can be measured and not only disagreement. An agent may record a correction
  the person told it about, with the person's words in `--reason`; the line says `mcp`,
  and `stats` and `tune` show those apart. Saying `unsure` takes the category back.
- A host that calls toil through `@imagile-dev/toil/api`, which records `via: api`.

A line holds the item's id, its title (cut to 300 characters, one line), the toil
project, the category, the source, scheme and revision that decided it, and for a
correction who made it (a tracker account name, never an email), through which door and
why. It never holds an item's body, a host or a credential: anything shaped like one is
replaced with `[redacted]`. The ledger stays on this machine and toil sends it nowhere;
what a team shares is the sharper scheme file. A ledger over 32 MiB is refused with the
way to start a new one (rename the old file). Lines that can't be read are skipped with
a `LEDGER_LINES_SKIPPED` warning.

A correction made through any door decides the item on the next `classify run`
(`source: person`, with the person's reason) until someone sets a different label
in the tracker (that is recorded as a correction from the tracker); `categorize` writes it
to the tracker. The old label the tracker still holds does not undo it. A `classify run`
without `--record` that can't read the ledger (over 32 MiB, say) carries on without
people's corrections and warns `LEDGER_UNREADABLE`; `--record`, `correct`, `stats` and `tune` refuse.
`correct` on an item the ledger has no verdict for yet records it with the id as its title and warns `CORRECT_ITEM_UNKNOWN`; run `classify run --record` first, or pass `--title`. A `classify run` that finds a recorded correction naming a category the scheme no longer has ignores it and warns `CLASSIFY_PERSON_UNKNOWN_CATEGORY`, naming up to three.

### Where the scheme gets it wrong: `classify stats`

`toil classify stats` returns agreement overall, per category and per scheme revision;
for each source (every rule, built-in signal, label, field, parent, and the AI agent)
how often people overruled it and to what; which way the errors run; corrections since
the last tune; items corrected more than once; and corrections by door. Only a verdict
the scheme gave counts as checked: a person changing a person's earlier say shows under
the items corrected twice. Every share is `null`, never 0, where nothing was checked. An
empty ledger is not an error: zero counts and a `LEDGER_EMPTY` warning that says how to
fill one. `--standing` adds `standing`, each item's last say from a person as
`{ "<item id>": { category, reason } }`, `category` null where they took it back
(`unsure`): what a screen needs to show an item as already answered.

### Tuning: `classify tune` and the backtest

`toil classify tune` (over MCP the prompt `classify-tune`) returns the prompt that asks
your AI agent for a revised scheme: the scheme, the statistics, and the corrections
inside a fenced block of untrusted data. It asks for sharper definitions and guidance
for the boundary people keep correcting, at most four examples per confused pair chosen
from real corrections, a rule added only where at least three corrections share a
pattern, and a rule or `signals` narrowed or turned off where people overrule it often,
with each change tied to the corrections that answer it. A third of the corrections (by
item id, the same third every time) is held back from the prompt, and the result lists
them in `corrections.heldBackItems`. A ledger with no corrections at all returns the prompt with a `TUNE_NOTHING_TO_LEARN` warning: there is nothing to tune from yet.

The revision is scored before anyone accepts it. The agent classifies the held-back
items under the revised scheme (`classify prompt --scheme revised.json --recheck`), and
`toil classify stats --backtest-file <answers file> --revised-file revised.json` scores the scheme
as it was and as revised against what people said: before from the ledger alone, after
from the revised rules run by code (pass the items with `--input-file` or `--text`) and then
the agent's answers. An item nothing answers counts as `missing` and as not agreed. A
revision that scores lower is reported as worse (`worse: true`, a `BACKTEST_WORSE`
warning) and nothing is changed either way. Three more warnings say why a score is thin: `BACKTEST_NOTHING_HELD_BACK` (no correction is held back yet, so there is nothing to score), `BACKTEST_UNSCORED` (held-back items with no earlier verdict in the ledger were left out, since there is no "before") and `BACKTEST_SCHEME_NAME` (the revised scheme's name differs from the scheme the ledger belongs to; a tuned scheme keeps its name).

Only a person applies a revision, with `toil classify scheme set --input-file revised.json`,
which bumps `revision`. That is a person's command, and an agent can propose a revision
but not apply it. toil never rewrites its own scheme.
