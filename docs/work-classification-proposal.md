# Work classification proposal

A proposal for classifying a team's work items from GitHub, Jira and Azure DevOps as
**KTLO** (keep the lights on) or **Feature**, and writing the category back to the
tracker as a label and, where the team has one, a field. (As built: labels are the first-class
record and a field is an optional mirror of the label, the maintainer's call, 12 November
2026.) It also lets people reclassify
items, learns from their corrections, and analyses the mix in toil and Toil UI (#566).
Slices 1 to 3 are built: the scheme, `classify run | prompt | correct | stats | tune |
mix`, `categorize` in all three trackers, the ledger, the MCP prompts `classify` and
`classify-tune`, and in Toil UI the Work mix item in the Summary's Where the work goes and its page, the category chip, the
Classify view and the Classification editor. Slices 4 and 5 are not built. Labels and tags
were written for real on the GitHub, Jira Cloud and Azure DevOps Services test projects
on 11 November 2026; a category field, Jira Data Center and Azure DevOps Server have
not met a live tracker. Where the build departs from this text,
`docs/decisions/566-work-classification.md` says so. The maintainer settled its open
decisions on 9 November 2026; they're listed at the end, with the defaults this
proposal picked.

The two categories, as the request defines them:

- **KTLO (keep the lights on):** security patches, bug fixes, dependency upgrades,
  compliance updates and incident response.
- **Feature:** proactive development that creates new user-facing functionality or
  expands a product's capabilities, such as a new checkout flow, a dashboard widget or
  an integration with a new third-party service.

## What the research found

The full research report, with citations, is a separate file, `Engineering work
classification.md`, kept out of the repository. The findings that shape the design:

- **Nobody writes back.** None of the engineering-intelligence vendors studied (DX,
  Jellyfish, LinearB, Swarmia, Pluralsight Flow, Haystack, Waydev, Uplevel, Faros)
  documents writing a category back to Jira, GitHub or Azure DevOps. Categories live
  in each vendor's own store, and the tracker holds one only where the customer puts
  it there. Labels in the tracker are something toil can offer that they don't, and
  every tool that reads the tracker (Jira filters, ADO queries, GitHub search) gets the
  category for free. Atlassian's own engineering teams already work this way: their
  work taxonomy is applied as Jira labels (`ewt-ctb-feature`), copied from each epic to
  its children by Jira Automation.
- **DX's own split is the one requested.** DX publishes no fixed taxonomy beyond "new
  capabilities" against everything else (plus bug fixes for its quality metric). Its
  Core 4 Impact metric is the share of time on new capabilities: a median of about
  55–59% across 500+ companies, with the 75th percentile (about 58–62%) suggested as a
  target. DX gets that number three ways (tracker rules, AI on pull requests, a
  survey), and the three use different units, so they don't compare directly.
- **Rule engines are all the same.** Every vendor ships ordered, first-match-wins rules
  on issue type, labels, epic or parent, custom fields, title and team. Children
  inherit their parent's category, and what matches nothing goes to an uncategorized
  bucket. Swarmia advises getting more than 80% of work categorized by rules.
- **AI goes on what the rules leave.** Swarmia (since February 2026) runs rules first,
  then AI on the top-level items still uncategorized, marks AI results with an icon,
  and lets a manual choice win. "The better your category descriptions, the better the
  results." Uplevel's model has a 60% confidence threshold and reports about 70%
  agreement with manual labels.
- **Corrections stay in the vendor.** Swarmia and Span let a person override a
  category, and the override wins, but the research found no vendor that documents
  feeding overrides back into its rules or prompt. A loop where AI suggests, a person
  corrects, and the classifier improves from the corrections is open ground.
- **The tracker's own types are noisy.** Herzig et al. found 33.8% of 7,000+ issue
  reports misclassified, mostly as bugs that weren't. Fine-tuned models reach about
  0.83–0.89 F1 on bug/feature/question; zero-shot GPT-4o with a bare one-word prompt
  reached 0.655, so definitions and examples in the prompt matter. Ahmed et al. (MSR
  2025) found 3–4 labelled examples work best. No study measures how often people
  agree on KTLO vs feature, so a team should measure that on its own backlog before
  trusting any automation.
- **Effort has three units.** Ticket count, estimate (points), and effort inferred from
  activity (LinearB splits each person's day across their active issues; DX counts
  time in progress, at most a week per five weekdays per person; Swarmia splits an
  FTE-month across the tasks a developer touched). Each is a different answer.
- **Published targets.** Swarmia: KTLO under 30%, about 60% on new work and
  improvements. Jellyfish measured roadmap work at 36% (2020 report) and 44% (2021).
  Gartner: "Run" no more than 65% of the IT budget.
- **Capitalization is near, but not the same.** KTLO vs Feature roughly tracks expensed
  vs capitalized software cost, but novel feature work under significant uncertainty
  is expensed, and upgrades that add functionality are capitalized. FASB's ASU 2025-06
  replaces the project-stage model from annual periods beginning after 15 December
  2027. US tax treats R&E separately (Section 174A). This is a dimension of its own,
  later.

## What toil already has

| Building block | Where | Gap for this feature |
|---|---|---|
| Open Work Items: one shape for Jira, ADO and GitHub items, with `type`, `labels`, `parent`, `body` | `src/core/owi/`, `util owi map` | The tracker type "Feature" maps to `OTHER` on purpose (`src/core/owi/common.ts`); the category and the tracker type share a word, so the UI has to keep them apart |
| Label and tag writes | `github issue label`/`unlabel`, `jira issue label`/`unlabel`, `ado work-item tag`/`untag` | One item per call. `github issue unlabel` is off MCP (an HTTP `DELETE`). ADO `tag`/`untag` exist for Server only, and read then write with no revision check; Services can only replace every tag through `work-item update` (since #627, Services has both, with a revision check) |
| Field writes | `jira issue update --field`, `ado work-item update` | One item per call. No command sets a GitHub issue field; the GitHub area already sends GraphQL (Projects, reviews) |
| Backlog reads | `jira issue search`, `ado work-item search` then `get-many`, `github issue list`/`search` | `jira issue search`'s default fields leave out `description`, `parent` and `issuelinks` (`STANDARD_SEARCH_FIELDS`, `src/areas/jira/server/client.ts:316`). Toil UI's sync passes no `--fields` (`ui/src/load.ts:373`), so its Jira items appear to carry no body; read from the code, not confirmed at runtime |
| Commands that read OWI on stdin | `projects brief` (`src/projects/brief.ts`), `projects analyze set | show | prompt` | The model to follow; nothing classifies |
| Toil project knowledge | `src/core/toil-project.ts`: field aliases, `analyze`, reference data only Toil UI reads (`readiness`, `authorKinds`) | Nowhere to keep categories, definitions, examples or rules, and no way to share them apart from a whole toil project |
| Person's commands over the API | `personCommands` in `src/api.ts` (`projects onboard`, `feedback`) | The pattern for a change only a person may make, which Toil UI runs on a press |
| Toil UI | Insights (Aging, Carried over, Added mid-sprint), flow charts, the Summary tab's numbers, proposals applied by a press, the AI agents (Claude, Copilot, Codex on the person's own subscription, read-only) | No work mix, no review queue, nowhere to reclassify |

Nothing in the repository classifies work today, and the CLI never calls a model: it
hands an agent a prompt (`projects analyze prompt`, the MCP prompt `analyze`), and
repeated decisions keep judgments "by code, not a model" (`util owi similar`,
readiness, decision 304).

## Design

### Principles that shape it

- **No model inside toil** (principles 1 and 9). toil classifies what rules can settle,
  by code, and hands the rest to the AI agent the person already pays for (Claude
  Code, Copilot or Codex over MCP, or Toil UI's AI agents) as a prompt. The agent's
  verdicts come back as data toil checks. Tuning the prompt works the same way.
- **The caller composes** (principle 3). Read the backlog from one tracker, map it,
  classify it locally, then write the category to that one tracker. No command asks
  several trackers at once.
- **Writes stay gated** (principle 2). Labels and fields go back through the
  connection's `writes: true` and `--allow-write`, on a person's yes. A tuned scheme
  changes only when a person applies it.
- **Every verdict says where it came from** (principle 4): the team's rule, a built-in
  signal, the AI agent and the scheme revision it ran under, a person, or a label or
  field already on the item. Unsure is a result, not a failure.
- **The scheme travels on its own.** A team's categories and rules are worth sharing
  across toil projects and teams, so they are a file of their own, and a toil project
  only names the one it uses.

### The classification scheme: a file of its own

A scheme holds the categories with their definitions, plus the guidance, examples,
rules and label names: everything the classifier runs on. It is its own JSON file, so a
team can share it across its toil projects, or with other teams, without sharing a toil
project.

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
  "guidance": [
    "An upgrade that exists to unlock a new user-facing capability is Feature; one that keeps the product supported is KTLO."
  ],
  "examples": [
    { "item": "corp-jira:PAY-412", "title": "Add Apple Pay to checkout", "category": "feature" },
    { "item": "corp-jira:PAY-388", "title": "Upgrade Spring Boot to 3.4 for end of support", "category": "ktlo",
      "why": "Corrected from feature: no new capability" }
  ],
  "rules": [
    { "id": "roadmap-epic", "when": { "parent": ["PAY-100"] }, "then": "feature" },
    { "id": "escalations", "when": { "label": ["customer-escalation"] }, "then": "ktlo" }
  ],
  "signals": true,
  "labels": { "ado": { "ktlo": "KTLO", "feature": "Feature" } }
}
```

- `definition`, `guidance` and `examples` are the classifier prompt. They start as the
  request's words and get sharper as people correct verdicts (Step 4). `revision` goes
  up by one with every change, and every verdict records the scheme and revision it ran
  under.
- Labels are `ktlo` and `feature` by default: plain words with no space, which Jira
  labels can't hold. An area may name its own (`labels.ado`). `feature` is a common
  label already, and a label already on an item counts as a verdict, so the first run's
  summary says how many items already carried each label. The workflow page says to
  rename the scheme's label where `feature` already means something else in that
  tracker.
- `signals` turns the built-in signals (Step 1) on or off; they are on by default.
- Two schemes are built in: `ktlo-feature`, the two categories above and the default,
  and `balance`, the Balance framework's New / Improve / KTLO / Productivity, which
  Swarmia and Haystack recommend, as a preset to start from.

**Where schemes live.** A scheme name resolves in this order, so your own copy wins over
a shared one of the same name, as a toil project's does:

1. `--scheme <file>`, on any `classify` command.
2. Your own folder, `~/.toil/classify/<name>.json`.
3. The call's repository, `.toil/classify/<name>.json`, checked in for everyone who
   works in it.
4. A path relative to the toil project that names it (`"scheme": "./ktlo-feature.json"`),
   so a team that shares toil projects through a listed folder (`projectPaths`) shares
   the scheme beside them.
5. Built in.

**Sharing** works the way it does for toil projects:

- `toil classify scheme export <name> --repo <dir>` writes `.toil/classify/<name>.json`
  into that working tree, and `--file <path>` writes a single file. toil writes the file
  and stops; it never stages or commits. The bounds are `projects export`'s: `--repo`
  must be a git root, `--file` must end in `.json` and sit inside the workspace, and
  neither replaces a file that isn't a valid scheme, or an existing scheme without
  `--replace`.
- `toil classify scheme import <file> [--name <new>]` copies a scheme into your own
  folder to adapt it.
- `toil classify scheme init <name> [--from ktlo-feature|balance|<name>]`, `list`,
  `show` and `set --from <file>` create, list, show and change one. `set` writes the
  scheme where it lives: your folder, or the repository's `.toil/classify/` in the
  working tree, ready for a pull request. Changing a built-in scheme writes a copy into
  your folder.

**What a scheme can't do.** It holds no secret, no host, no connection and no `writes`,
so a shared scheme can't make toil talk to anything or write anything. Labels and fields
still go through each connection's write gate, on a plan the person sees first. Its
definitions and guidance are instructions to the AI agent, so a checked-in scheme is
trusted as far as its repository's review is. Items' own text always goes into prompts
fenced off as untrusted data.

**The toil project names its scheme, and where the category goes** in each tracker.
The field's id stays where toil already keeps field ids: an alias in the tracker's own
section, set with the existing `projects field` command:

```bash
toil projects field payments jira workCategory customfield_10042
toil projects field payments ado workCategory Custom.WorkCategory
```

`toil jira field discover` (Data Center and Cloud, served over MCP) suggests field ids
from a sample of issues. It returns ids and names, not option values.

The `classify` key then names the scheme and the target in each tracker:

```json
"classify": {
  "scheme": "ktlo-feature",
  "targets": {
    "jira": { "field": "workCategory" },
    "ado": { "field": "workCategory" },
    "github": { "project": "imagile/7", "field": "Category", "values": { "ktlo": "Keep the lights on" } }
  }
}
```

- For Jira and ADO, `field` names the alias in that tracker's own section. For GitHub,
  it names the field on the GitHub Project (see Step 3).
- Field ids belong to one Jira instance or ADO organization, so they live in the toil
  project, not in the scheme a team shares.
- A field's values default to each category's `short` ("KTLO", "Feature"); `values` maps
  them where an admin named the options differently.
- A toil project with no `classify` key uses the built-in `ktlo-feature` scheme and
  writes labels only.
- `classify` holds `scheme` and `targets` and nothing a tracker section checks
  (`connection`, `host`, `fields`, `transitions`), so an older toil can still load the
  file (see the compatibility note below).

### How the category is named

Toil UI shows the category in plain words, "Keep the lights on", and "KTLO" is one hover
away. That is principle 11's rule for words a person acts on, and the maintainer's call of
9 November 2026. Trackers keep the short form, and the CLI gives both names:

- Every category carries `name` ("Keep the lights on") and `short` ("KTLO"), and every
  command's output carries both.
- In Toil UI, everything a person reads to act shows `name`: the chip, the Work mix item in the Summary's Where the work goes
  and legend, headings, filters and the Classify view's choices. Hovering any of them
  gives "KTLO", the definition and a Read more link.
- Typing either word finds the category, in a filter, the search box or the command
  palette, so someone who knows it as KTLO isn't lost.
- Labels stay `ktlo` and `feature`. A label or a field's value on an item is shown as
  the tracker holds it, since that is the item's data.
- On GitHub, when `categorize` creates a label that's missing, it gives the label a
  description: the category's name and the start of its definition, within GitHub's
  100-character limit. Creating the label is a write in the plan like any other, and
  toil never edits an existing label.
- Jira labels and ADO tags have no description. The docs suggest naming a field's option
  "KTLO (keep the lights on)" where the team uses a field. The workflow page, the skill
  docs and the site spell it out on first use.

### Step 1: rules, by code (`toil classify run`)

Like `projects brief`, it reads Open Work Items (stdin, a file, or MCP's `text`) and the
scheme, asks no service, and returns one verdict per item.

```bash
toil jira issue search --jql "project = PAY AND statusCategory != Done" --fields summary,description,issuetype,labels,parent,customfield_10042 \
  | toil util owi map \
  | toil classify run --toil-project payments
```

- The search asks for the category field by its id (`customfield_10042` here), so
  `run` can see a category already in it. The default `jira issue search` returns the
  standard fields plus the connection's `customFields`, and a toil project's alias isn't
  added to them.

- The scheme is the one `--scheme` names, else the one the toil project names, else the
  built-in `ktlo-feature`.
- First match wins. An item that already carries one of the scheme's labels, or a value
  in its field, keeps it (unless `--recheck`; as built, the label is the record and a field settles an item only where no single scheme label does). Then come the team's own rules, then the
  built-in signals, then the parent's verdict, which children inherit. Anything left is
  `unsure`. (As built: a person's say, from the
  ledger, comes after labels and fields and before the rules, except that a person's say
  outranks a label or field that still holds what the tracker held before they spoke.)
- **Built-in KTLO signals**, on by default and ranked below the team's rules:
  - type `BUG` or `INCIDENT`;
  - a CVE or GHSA id in the title or body;
  - a link to an incident;
  - a dependency bot as author (Dependabot, Renovate, or `authorKinds` `BOT`);
  - labels such as `security`, `dependencies`, `compliance`, `incident` or `hotfix`;
  - titles that open "Bump", "Upgrade" or "Patch".

  Because tracker types are noisy, a team's rule beats a signal, `stats` shows which
  signals people overrule (Step 4), and a scheme can turn them off.
- Each verdict carries:
  - `category`;
  - `source`: `label`, `field`, `rule:<id>`, `signal:<name>`, `parent`, `agent`,
    `person` or `unsure`;
  - `reason`;
  - the scheme and revision;
  - the change it implies. On labels it adds this category's label, removes only the
    scheme's other labels, and touches nothing else. On the field it sets this
    category's value.
- `data` ends with a summary: counts per category and per source, the share settled by
  rules, and how many items already carried each label.
- `--record` adds the verdicts to the ledger (Step 4). That's a local write
  (`writesLocalWhen`), so a plain run changes nothing and is free under `readOnly`.

### Step 2: the AI agent decides the rest (`toil classify prompt`)

`toil classify prompt` and the MCP prompt `classify` give the AI agent the scheme's
definitions, guidance and examples, plus the `unsure` items fenced off as untrusted
data. They ask for `{ id, category, reason }` per item, with `unsure` allowed. The
agent's answer goes back through `toil classify run --verdicts <file>`, which checks
every id and category and records `source: agent` with the scheme revision. toil never
sends the text anywhere: the agent the person already runs does the judging, on their
own subscription.

### Step 3: write the category back (`categorize`)

`run` writes a plan: each verdict's label and field changes, grouped by connection. One
new command per tracker, with the same verb in all three (principle 10), applies the
plan to the items on the connection it resolves:

```bash
toil jira issue categorize --from plan.json --allow-write
toil github issue categorize --from plan.json --allow-write
toil ado work-item categorize --from plan.json --allow-write
```

- **One command, one connection.** Plan entries for other connections are skipped with a
  warning naming them.
- **Labels and fields both ship in slice 1.** (As built: the label is the record and the field an optional mirror, the maintainer's call, 12 November 2026: see Decisions, 5.) Before it writes anything, the command
  reads the field's definition. It refuses the whole plan, still before any write, if
  the field or one of its values doesn't exist, naming what's missing and saying that an
  admin creates it. toil never creates a field. Where the option ids come from:
  - Jira: `jira issue fields --discover --project <key>`, whose `allowedValues` come from
    createmeta (as built: `editmeta`). `jira field discover` gives field ids only.
  - GitHub: `github project fields`, whose single-select fields list `options { id name }`.
  - Azure DevOps: no command lists a picklist's values. `ado work-item fields` is Server
    only and returns a `picklistId`, not the values, and Services has no fields command.
    So `ado work-item categorize` reads the picklist itself (the process lists API)
    before writing, on both Server and Services, to make this check. (As built: it reads
    each work item type's own definition.)
- **Running it twice changes nothing.** An item that already has the right labels and
  field value sends nothing.
- **Jira** (Data Center and Cloud): one `PUT` per issue carries `update.labels` add and
  remove, and the field's option in `fields`. A select field is sent as `{ "id": ... }`
  or `{ "value": ... }`, the way toil's `formatFieldValue` writes one, because Jira
  refuses a raw string. A field given by name resolves to its id the way `--field` does,
  through the toil project's field aliases or `jira issue fields`.
- **ADO** (Server and Services): one JSON Patch per item. It holds a `test /rev`
  guard, `System.Tags` read, merged and replaced, and the field set, with
  notifications suppressed. If the revision moved between the read and the write, toil
  retries once with fresh tags, then reports the item. Because `categorize` does its own
  merge with the revision check, it doesn't depend on `tag | untag`, which stay
  Server-only.
- **GitHub:**
  - Labels are added with `POST` and removed with `DELETE`. A missing label is created
    first, with its description. (As built: `github issue categorize` adds with `POST`
    and, to take one of the scheme's other labels off, replaces the issue's labels with
    one `PUT`, never a `DELETE`, so it is served over MCP like the other two.)
  - The category goes into a single-select field on a GitHub Project (v2), named in
    `classify.targets.github` (`project` and `field`). `categorize` reuses `github
    project status`'s GraphQL write with the field's name as a parameter. That write is
    two requests: it reads the item, then calls `updateProjectV2ItemFieldValue` with
    the option's id. It matches the option by name without regard to case, sends
    nothing when the value is already set, and refuses an item that isn't on the
    project. `project status` itself stays Status-only.
  - An issue that isn't on the project gets its labels, and the plan names it as not on
    the project. It isn't added to the project.
  - GitHub's organization issue fields are left for later: toil has no support for them
    yet, and they need an organization sandbox to verify.
  - `github issue categorize` must be listed in `src/areas/github/scopes.ts` (Issues
    write, plus Projects write when it sets the field), or the repository's scopes test
    fails. Jira and ADO declare no scopes.
- **Over MCP**, the command is served behind the same gate (`writes` on the connection,
  plus `--allow-write`):
  - A plan that removes a GitHub label sends a `DELETE`, so it's refused over MCP
    (`offMcpWhen`). The person applies it on the CLI or in Toil UI. (As built: no plan
    sends a `DELETE`, so nothing is refused over MCP; see the label bullet above.)
  - Jira and ADO removals, label creation and field sets use `PUT`, `PATCH` or `POST`,
    and are served.
- **Rate limits and audit.** Core's 429 retry and progress events cover the rate limits
  (GitHub allows about 80 writes a minute), and the audit log records every request.
- **Provenance stays out of the tracker.** The ledger and toil's audit log record which
  rule, scheme revision or person decided each item; a comment on every item would be
  noise.

### Step 4: reclassify, and learn from it

People will disagree with some verdicts. Each disagreement is the best evidence there
is of where the classifier is wrong, so toil keeps every one and uses them to sharpen
the scheme.

**Reclassifying.** A person can change an item's category three ways, and all three
count:

- **In Toil UI**, on the item's category chip (on its page, in the item drawer, in the
  Classify view, or in a Work mix drill-down) or from a Board card's menu (☰): pick
  another category, adding a reason if they like. That records the correction and
  proposes the change to the tracker. An undo line can follow the archive undo line's
  pattern (`ui/src/components/archive.tsx`).
- **On the CLI or through an agent**: `toil classify correct <item-id> --to feature
  --reason "adds a new export format"`, then `categorize`. An agent may record a
  correction the person told it about. It's marked `via: mcp`, and `stats` and `tune`
  show those corrections apart from ones a person made.
- **In the tracker itself**: swap `ktlo` for `feature`, or change the field, in Jira,
  GitHub or ADO. On the next `run`, toil sees the item differs from the verdict it
  recorded and records a correction from the tracker. Where the read carries history
  (Jira's changelog, GitHub's timeline, ADO's revisions), the correction names who made
  it.

Confirming a verdict (`--to` the same category, or pressing the category an item already has in Toil UI) is recorded too,
so agreement can be measured and not only disagreement.

**The ledger** is `~/.toil/classify/<scheme>.jsonl`, beside the person's own schemes,
with one line per verdict and per correction. Each line records:

- the item and the toil project it came from;
- the category, and the source, scheme and revision it came from;
- for a correction, the new category, who made it, through which door (Toil UI, CLI, MCP
  or the tracker), when, and the reason.

It holds ids, titles and reasons, never an item's body or a credential. There is one
ledger per scheme, so a scheme used across several toil projects learns from all of
them, and `stats --toil-project` narrows to one. Only the `classify` commands write it,
and it stays on the person's machine. What the team shares is the result: the sharper
scheme file.

**Where it got it wrong.** `toil classify stats` reads the ledger and reports:

- agreement overall, per category, and per scheme revision;
- which sources people overrule most: each rule, each built-in signal, and the AI
  agent per revision ("`signal:type-bug` overruled 9 of 31 times, all to feature");
- which way the errors run (KTLO read as Feature, and the reverse);
- corrections since the last tune, items people changed more than once, and how many
  corrections came through an agent.

**Tuning the scheme with the person's own AI agent.** `toil classify tune` and the MCP
prompt `classify-tune` give the AI agent:

- the current scheme;
- the stats;
- the corrections: ids, titles, from and to, reasons, which source erred, and whether a
  person or an agent recorded each one.

They ask for a revised scheme, with each change tied to the corrections it answers:

- sharper definitions and new `guidance` lines for the boundary people keep correcting;
- up to four `examples` per confusable pair, chosen from real corrections;
- a rule to add where corrections share a pattern (every correction under one epic),
  and a rule or built-in signal to narrow or turn off where people overrule it often.

The agent reads the items' text through toil's own reads, on the person's own
subscription. Before anyone accepts the revision, toil checks it:

1. A third of the corrections is held back from the tune prompt.
2. The agent classifies those held-back items with the revised scheme (`classify prompt
   --scheme revised.json`), and toil reruns the rules by code.
3. `classify stats --backtest <verdicts>` scores the old and the revised scheme against
   what people said, side by side. (As built, as proposed, with `--revised <file>`
   naming the revised scheme.)

The person then applies the revision, or doesn't, with `classify scheme set --from
revised.json`, which bumps `revision`. That command is a person's command: run on the
CLI, or through Toil UI's Apply as a `personCommands` entry, and refused to an agent
over MCP. An agent can propose a revision but not apply it. toil never rewrites its own
prompt: a revision that scores worse is shown as worse, and a person decides every
change. A rule change needs at least three corrections behind it, so one odd item can't
reshape the scheme. When the scheme is checked in, `set` changes the file in the working
tree, and the team takes the revision through a pull request.

**Measure before labelling the whole backlog.** The first round is the same loop at
small scale:

1. Classify a sample of about 50 items.
2. Have people confirm or correct every one in the Classify view.
3. Read `stats`.

Labels go on the whole backlog once agreement is where the team wants it. After that,
the override rate per category is the running check. It also guards against an obvious
incentive: published KTLO targets reward relabelling upkeep as feature.

### Step 5: analyse the mix (`toil classify mix`)

It reads classified items and the scheme, and returns the share per category:

- **by period:** week, month or quarter;
- **by group:** team, assignee, repository or epic (team and person come from the toil
  project, `--toil-project`);
- **in one of three units**, each named in `meta`:
  - `count`, the default;
  - `estimate`;
  - `days`: time in progress from status history, at most five days a week per person,
    split across their open items (DX's documented method).

The unclassified share is always shown, never folded into a category. So is how much
came from rules, from the AI agent and from people.

- **Unknown is not zero** (principle 12). A figure nobody has read yet is a dash ("not
  read yet") on screen and `null` or absent in an envelope, never 0, "" or [].
  - An item nobody has classified yet is `unsure` (unclassified) and counted as such.
  - A tracker field the read didn't fetch is unknown, not "no category".
  - `classify mix` reports an unread share as `null` with a warning, not 0.
- Toil projects that are archived (`archived: true`) are skipped when `mix` or Toil UI
  runs across toil projects.

### A workflow page

`skills/toil/workflows/classify.md` writes the whole job down. The first pass is: read
the backlog, map it, classify it, ask the AI agent about the unsure items, show the
plan, ask the person, categorize, and record. When corrections pile up, it's: stats,
tune, backtest, ask the person, and set. Toil UI reads its frontmatter (`needs`,
`writes`) as it does for the other workflow pages.

### Toil UI

Following principle 11, nothing new sits on every screen; each piece is a step in.

- **Summary tab, "The numbers":** the project's landing tab reads "Summary" on screen
  (its id is still `overview`). As first proposed, a Work mix figure went in "The numbers" (the
  `MetricStrip` inside "Show the full briefing"), as a sixth tile beside Points done,
  Finished, Time to finish, Work getting old and the code-review wait. It reads like
  "Feature 58% · Keep the lights on 34% · Unsure 8%, last 90 days", with a trend
  sparkline, and puts one category on each line where the tile is narrow. Hovering
  "Keep the lights on" gives "KTLO" and the definition. An unknown mix (nothing
  classified or read yet) shows a dash, "not read yet", never 0% (principle 12). The tile
  opens the Work mix page.
- **Work mix page**, reached from the Work mix item in the Summary's Where the work goes, the command palette, or its own address. It
  has:
  - a stacked trend by month;
  - a breakdown by team, person, repository or epic;
  - a unit switch;
  - drill-downs from each slice to its items, where any item can be reclassified.
- **The category chip:** a small chip with the category's name ("Keep the lights on",
  "Feature") and a source badge (rule, AI agent, person). Its tooltip gives "KTLO" and
  the definition.
  - On the item page it sits in the header beside the status chip, modelled on the
    "Ready to start?" verdict chip, and it is in the item drawer too. Pressing it
    reclassifies the item.
  - On Board cards it is display-only, because a whole Board card is its drag handle and
    no card carries a button. Reclassify from the card's menu (☰) or the item page.
- **Board, a Classify view** as a third Board view beside "Board" and "Ready to start?",
  listing the unsure items and the ones where a rule and an existing label disagree.
  Each comes with a suggested category, its reason and the evidence.
  - Each item's choices read "Keep the lights on", "Feature" and "Unsure". K, F and U
    pick one, and Enter confirms.
  - **Ask your AI agent** classifies the rest, as proposals. The agent's tools in Toil
    UI are all read-only (there is no write tool), so it proposes and a person applies.
  - **Apply** collects the decided items into one plan per connection. It shows every
    change first: the item, the label from and to, and the field from and to. One press
    writes them one by one and reports each result, and pressing again changes nothing.
- **How it's doing,** folded at the top of the Classify view. It shows agreement, the
  source people overrule most, and corrections since the last tune. Once there are
  enough corrections (ten, say), **Improve with your AI agent** runs the tune on the
  chosen agent and shows the proposed changes beside the old and new backtest scores.
  Apply runs `classify scheme set` as the person's command.
- **The Classification editor** lives on the toil project's edit page (Settings, Toil
  projects, the project), as a new "Classification" section beside Sources, Field names,
  People, Work in progress limit and How Analyze briefs. It is not on an app-wide
  Settings page. It edits two things:
  - the scheme the toil project uses, wherever it lives: your own copy, or the
    repository's file, ready for a pull request. That covers definitions, guidance,
    examples, label names, rules and signals, with a preview of how many items each rule
    matches, and the revision history;
  - the toil project's field for each tracker.

  The screen never shows the scheme file's path or a `toil` command. A new Toil UI rule
  keeps terminal commands, environment variable names and file paths out of screen
  copy, except on an approval card.
- **Fix the Jira sync** to ask for `description`, `parent`, `issuelinks` and the
  category field's id. The Jira `issue search` run is at `ui/src/load.ts:373`. Adding
  `fields` must keep the daily reconcile's `fields: 'key'` override
  (`ui/server/sync.ts:184-188`). Readiness needs the first three too.

## More dimensions: the bigger feature

The same pipeline (rules by code, the AI agent for the rest, people correcting, the
scheme learning) carries more dimensions. Only the ones read from a ticket's text need
classifying and labelling; the rest are computed from history or structure.

| Dimension | Comes from | How toil gets it | In toil today |
|---|---|---|---|
| Investment (KTLO / Feature, or the four-bucket `balance` preset) | text, labels, type, parent | a classification scheme | No |
| Security and dependency work | CVE ids, bot authors, labels | built-in signals, a KTLO reason | No |
| Flow item type (feature, defect, risk, debt; Flow Framework) | text | a second scheme | No |
| Planned vs unplanned | history | added after the sprint started, or an incident | Partly (Insight "Added mid-sprint") |
| Cycle time, throughput, aging WIP | history | Toil UI's flow model | Yes |
| Initiative alignment ("unlinked work") | structure | items with no epic or initiative above them | OWI `parent` |
| Recurring toil (Google SRE: manual, repetitive, automatable) | across items | cluster KTLO items with `util owi similar`: "the same fix 9 times in 90 days" | `owi similar` exists |
| Customer-reported vs internal | reporter, labels, links | rules | No |
| Time on new capabilities (DX Core 4 Impact, inferred) | investment × days | `classify mix --unit days` | No |
| Capitalizable (CapEx / OpEx) | investment plus funding and uncertainty decisions | deferred: finance owns the method, and ASU 2025-06 changes it from 2028 | No |

Recurring toil is the one no vendor offers, and the one a product named toil should:
KTLO work that repeats is the work worth automating.

## Slices

1. **Classify and categorize the backlog (CLI and MCP):**
   - the scheme file, with `classify scheme init | list | show | set | export | import`
     and the built-in `ktlo-feature` and `balance` schemes;
   - the toil project's `classify` key;
   - `classify run | prompt` with `--verdicts` and `--record`, and the MCP prompt
     `classify`;
   - `categorize` in all three trackers, with labels, fields and GitHub label
     descriptions;
   - the workflow page, skill docs, contract entries (as built: new commands take no
     contract entries), fixtures and the parity suite;
   - a live run on one sandbox per tracker, each with a field set up (labels and tags done on
     all three; no field yet).
2. **Reclassify and learn (CLI and MCP):** the ledger, `classify correct | stats | tune`
   with `--backtest`, corrections read from the tracker, the MCP prompt
   `classify-tune`, and the workflow page's tuning steps.
3. **Work mix in Toil UI:**
   - `classify mix`;
   - the Work mix item in the Summary's Where the work goes and the Work mix page;
   - the category chip;
   - the Classify view, with How it's doing and Improve with your AI agent;
   - the Classification editor on the toil project's edit page, and the Jira sync
     fields;
   - `npm run verify:ui`.

   Work insights (#567, `docs/work-insights-proposal.md`) comes after this issue. It moves
   the Work mix page onto its chart kit, where it can be split by any dimension.
4. **More dimensions:** planned vs unplanned, initiative alignment, recurring toil, and
   the flow item scheme.
5. **Capitalization** (deferred).

Every slice is additive: a new `classify` command group, new `categorize` commands, a
new toil project key, scheme files in `~/.toil/classify/` and `.toil/classify/`, the
ledger, and new MCP prompts. No command, flag, field or exit code changes, so none is a
breaking change.

One compatibility note: an older toil reading a toil project that uses `classify` keeps
the key, warns that it isn't an area it has, and doesn't use it.
- That holds because `classify` avoids the keys a section checks (`connection`, `host`,
  `fields`, `transitions`). An older toil reads any unknown top-level key as an area
  section, and an object under `fields` is an error that stops the toil project loading.
- Any later change to `classify` must keep avoiding those keys.

`docs/bounds.md` gets `~/.toil/classify/` beside toil's other files, which `ctx.files`
already refuses to read. It also gets the scheme export's bounds, which mirror
`projects.write` and `projects.replace`.

## Decisions

The maintainer's, on 9 November 2026:

1. **Labels:** `ktlo` and `feature`.
2. **Names in Toil UI:** "Keep the lights on" and "Feature" on screen, with "KTLO" one
   hover away, as principle 11's plain-words rule says (**How the category is named**).
   This replaces the earlier call for "KTLO" on screen, made before that rule was on
   `main`. Labels in the tracker stay `ktlo`, and CLI output carries both names.
3. **Built-in scheme:** two categories, with the four-bucket `balance` preset beside it.
4. **Built-in signals:** on by default, ranked below the team's rules.
5. **Labels and fields:** both in slice 1. (As built: labels are the first-class record and a field is an optional mirror, the maintainer's call, 12 November 2026. When they disagree the label wins, the plan sets the field to the label's category, and a field changed alone in the tracker is not a correction.)
6. **Ledger:** local to each person; the team shares the scheme.
7. **Over MCP:** `categorize` is served behind the write gate, except a plan that
   removes a GitHub label. (As built: no plan sends a `DELETE`, so it is served in every
   case.)
8. **Toil UI:** one Apply writes a whole plan on one connection, after showing every
   change.
9. **Corrections from an agent:** recorded, marked `via: mcp`, and shown apart in
   `stats` and `tune`.
10. **The scheme is a shareable file of its own**, and the toil project only names it.

Defaults this proposal picked, for the maintainer to overturn:

- `classify` is a top-level command group, since a scheme no longer belongs to a toil
  project.
- One verb, `categorize`, in all three trackers, in place of `relabel` and `retag`.
- `classify scheme set` is a person's command: an agent can propose a revision but not
  apply it.
- Field ids live in the toil project, as aliases in each tracker's section, and toil
  never creates a field.
- GitHub's field is a single-select field on a GitHub Project in slice 1. Organization
  issue fields come later.
- Your own copy of a scheme wins over a checked-in one of the same name.
