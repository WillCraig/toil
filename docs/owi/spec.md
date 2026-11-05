# Open Work Item (OWI), version 0.2

OWI is one model for a work item from any issue tracker toil reads: Jira Data
Center and Jira Cloud, Azure DevOps and GitHub. It exists so a board, a sprint
report or an agent can read three trackers as one without learning each one's
fields. No adoptable standard covers it: OSLC Change Management is RDF-first and
no tracker serves it, and the unified-API vendors' ticket models are proprietary
and have no sprints, estimates or history (#206, **Prior art**). OWI publishes a
mapping to OSLC CM instead (below), so it can be exported there if that is ever
needed.

Version 0.2 adds the **change**: a pull request from GitHub, Bitbucket Data Center,
Bitbucket Cloud, Azure DevOps Server or Azure DevOps Services, with its review,
checks, size, the work items it names and its timeline (**The change**, below).
For a lead, a pull request waiting on review is often the real blocker, and a
work item alone can't show it.

- **Schema:** [`schema.json`](schema.json), JSON Schema 2020-12. Every item and
  change toil maps is validated against it before it is returned: a work item
  against the document's root, a change against `#/$defs/Change`.
- **Mappers:** `src/core/owi/`, one per source shape, used by `toil util owi map`
  (`skills/toil/util.md`) and by `mapOwi` in `@imagile-dev/toil/api`.
- **Versioning:** every record says its version in `owi`. Changes are additive
  only, as in the command contract: a new field, a new enum value, a new source,
  a new record. Removing or repurposing a field is a new major version. 0.2 only
  adds, so a work item written as 0.1 is still a valid 0.2 one; the mappers now
  write `0.2` on every record.
- **Honesty:** a field the record didn't hold is listed in the item's `unmapped`
  with the reason, never guessed (principle 4). `native` keeps the source records
  untouched, so every mapped value can be traced back.

## The work item

| Field | Type | Meaning |
|-------|------|---------|
| `owi` | `"0.2"` | The OWI version of this record (`"0.1"` on one written before 0.2) |
| `id` | string | `<connection>:<native key>`: the toil connection, then the source's key. `corp-jira:PAY-101`, `corp-ado:2302`, `github:imagile/payments-web#41` |
| `source` | object | `{ area, connection, key, command, deployment? }`: the toil area, the connection, the native key, the command whose output was mapped, and for an area with more than one deployment (`jira`, `bitbucket`, `ado`: `server` or `cloud`) which one the connection is, when the envelope's `meta.context` says |
| `url` | string or null | The item in the source's web UI |
| `type` | enum | `EPIC`, `STORY`, `TASK`, `BUG`, `INCIDENT` or `OTHER` |
| `typeName` | string or null | The source's own word for the type (Product Backlog Item, Sub-task, Feature). Show it beside `type` |
| `title` | string | The summary or title |
| `body` | object or null | `{ format, content }`: `markdown` (GitHub), `wiki` (Jira Data Center), `adf` (Jira Cloud, an object) or `html` (Azure DevOps). `toil util md` converts wiki and ADF to Markdown |
| `status` | string or null | The source's own status name |
| `statusCategory` | enum | `TODO`, `IN_PROGRESS`, `DONE` or `UNKNOWN` (below) |
| `resolution` | string or null | How a finished item finished, in the source's words: Jira's resolution, GitHub's `state_reason`, Azure DevOps' reason |
| `assignee` | Person or null | `{ id, name, email }`. GitHub's first assignee; the rest are in `native` |
| `reporter` | Person or null | Who created it |
| `priority` | string or null | The priority's name, as text |
| `estimate` | object or null | `{ value, unit, field }`: `unit` is `points`, `hours` or `days`, and `field` the source field it came from |
| `labels` | string[] | Labels, or Azure DevOps tags |
| `team` | string or null | Only from an override (`fields team`): no source has a default team field |
| `iteration` | Iteration or null | `{ id, name, path, start, end, state }`: the sprint the item is in now. `state` is Jira's sprint state as `past`, `current` or `future`, or `past` for a closed GitHub milestone, else null |
| `parent` | id or null | The parent item's OWI id |
| `children` | id[] | Sub-tasks, child work items, sub-issues |
| `links` | Link[] | `{ type, direction, target, name }`: `type` is `blocks`, `relates`, `duplicates`, `implements` or `other`; `outward` means this item `<type>` the target (it blocks it), `inward` the target `<type>` this item; `name` is the source's wording |
| `created` | instant or null | UTC, as `toISOString` writes it |
| `updated` | instant or null | |
| `resolved` | instant or null | When it was resolved or closed |
| `dueDate` | date or null | `YYYY-MM-DD` |
| `history` | object or null | `{ transitions, iterations }`, from the history commands. Null when no history was mapped, which is not the same as an empty one |
| `unmapped` | object[] | `{ field, reason }` for each field the record couldn't fill |
| `native` | object | The source records, keyed by the command that returned each |

**History.** A transition is `{ from, to, fromCategory, toCategory, at, by }`,
the first one recorded having `from: null`; cycle time is the time between
transitions. An iteration change is `{ from, to, at, by }`, each side a list of
iteration names: an item moving into the sprint after it started is scope added,
and one whose `from` names the previous sprint was carried over.

**Status categories.** Taken from the source where it has them, else from the
documented defaults below. A status with neither is `UNKNOWN`, with an
`OWI_UNKNOWN_STATE` warning naming it and an `unmapped` entry; never guessed.

## Mapping each source

The commands whose output maps, and what each gives:

| Area | Items | History | Context |
|------|-------|---------|---------|
| `jira` (Data Center and Cloud) | `jira issue search`, `jira issue get` | `jira issue history` | |
| `ado` (Server and Services) | `ado work-item get`, `ado work-item get-many` | `ado work-item history` | `ado work-item iterations` (iteration dates) |
| `github` | `github issue list`, `github issue search`, `github issue get`, `github project items` | `github issue history` | |

`ado work-item search` returns ids only, so they are skipped
with a pointer to `work-item get-many`. Pull requests in GitHub's issue lists and on boards are
left out of the items, with a warning: an issue list holds too little of a pull request to
map it as a change, so map `github pr list` or `github pr get` for those (**The change**,
below). Any other command's output is refused.

### Jira (Data Center and Cloud)

- **Type** from the issue type; a sub-task is `TASK`. **Status category** from
  `status.statusCategory.key`: `new` is `TODO`, `indeterminate` `IN_PROGRESS`,
  `done` `DONE`. A changelog names statuses only, so its transitions take their
  categories from the items in the same input.
- **Estimate**, points: the field named **Story Points** (Data Center and
  company-managed Cloud), then **Story point estimate** (team-managed Cloud).
  Both are custom fields whose id differs per site, so they are found by the name
  the connection registers them under (`customFields`), or by an expanded `names`
  map; never by a hard-coded `customfield_` id. Then hours: `timeoriginalestimate`,
  which Jira stores in seconds.
- **Iteration** from the **Sprint** field: Cloud's sprint objects, or Data
  Center's `com.atlassian.greenhopper.service.sprint.Sprint@…[id=…,state=…]`
  strings. The active sprint, else the latest future one, else the last.
- **Parent** from `parent`, else Data Center's **Epic Link**; children from
  `subtasks`; links from `issuelinks` by link type (Blocks, Duplicate, Relates).
- `issue search` returns the fields it asks for (`--fields`), and only the custom fields
  the connection registers; `issue get` returns every field. A field missing from
  the record is listed in `unmapped`.

### Azure DevOps (Server and Services)

`ado` serves Azure DevOps Server and Azure DevOps Services, which send the same
work item, revision and classification-node shapes, so one mapper reads both. Where
Services differs, the mapping already holds:

- **People**: on Services an identity's `uniqueName` is the sign-in email, so
  `email` is set; on Server it is often `DOMAIN\user`, which has no `@`, so `email`
  is null and `id` is that name.
- **URL**: a Services work item's API `url` is under the organization
  (`https://dev.azure.com/<org>/_apis/...`), with no collection segment, and the web
  link is built from it the same way: `https://dev.azure.com/<org>/<project>/_workitems/edit/<id>`.
- **Ids** are `<connection>:<id>` for both, so the two areas' items never collide.

- **Type** from `System.WorkItemType`: User Story, Product Backlog Item and
  Requirement are `STORY`, and so is Basic's Issue; Feature is `OTHER`.
- **Status category** by the default states' categories ([Microsoft's
  table](https://learn.microsoft.com/en-us/azure/devops/boards/work-items/workflow-and-state-categories)):
  New, To Do, Approved and Proposed are `TODO`; Active, In Progress (Scrum's Epic,
  Feature and Task), Doing, Committed, Open and Resolved are `IN_PROGRESS`
  (Resolved behaves as in progress on boards); Closed
  and Done are `DONE`; Removed is `DONE` with its reason as `resolution`. A custom
  state is `UNKNOWN`; `ado work-item states`
  shows its category.
- **Estimate**, the first with a value: `Microsoft.VSTS.Scheduling.StoryPoints`
  (Agile), `.Effort` (Scrum), `.Size` (CMMI) as points, then
  `Microsoft.VSTS.Scheduling.OriginalEstimate` as hours. Azure DevOps leaves an
  empty field out of the record, so an unestimated item and one estimated in a
  team's own field look alike; both are listed in `unmapped`.
- **Iteration** from `System.IterationPath`, with dates when the input also holds
  `ado work-item iterations`. **Parent** and **children** from the hierarchy
  relations; **links** from the dependency links, Successor and its reverse (`blocks`), Related,
  Duplicate and Duplicate Of. History from `ado work-item history`: each change of
  `System.State` and `System.IterationPath`.

### GitHub

- **Type** from the issue type (GitHub's defaults are Task, Bug and Feature).
  **Parent** from `parent_issue_url`, **children** from `sub_issues`
  (`github issue get <number> --sub-issues`).
- **A Projects board**, when the input has `github project items`, makes an
  issue and its board item one item: the board's **Status** option sets `status`
  (Todo, Backlog, Ready and New are `TODO`; In Progress, Doing and In Review
  `IN_PROGRESS`; Done `DONE`; other options `UNKNOWN`), the first number field
  named **Estimate**, **Size** or **Story Points** the estimate in points, and its
  iteration field the iteration. A closed issue is `DONE` whatever the board says;
  an open one with no board is `TODO`. A board item whose issue isn't in the input
  still maps, from what the board carries.
- **Without a board**, or where the board has no value, the issue's own record
  fills in the estimate and the iteration. A board value always wins.
  - **Iteration** from the issue's **milestone**: its title is the name, its
    `due_on` the end, and its number the id. The start is the due date of the
    repository's previous milestone in the input, so back-to-back sprints meet; the
    first milestone starts 14 days before its end. With `iterationDays` (below),
    every milestone runs that many days to its due date instead. A milestone with
    no due date has no dates. A closed milestone's `state` is `past`; an open one's
    is null, since whether it is running depends on the clock.
  - **Estimate** from a label: by default one of `points: N`, `story points: N`,
    `pts: N`, `sp: N` or `estimate: N` (any case; `:`, `=`, `/`, `-` or a space
    before the number), in points, with `field` the label (`label:points: 3`).
    `estimateLabel` (below) names the team's own pattern instead. Two labels that
    both hold an estimate are listed in `unmapped`, never picked between.
- **Links** from the issue's body: "Blocked by #7" and "Depends on #7" are a
  `blocks` link inward (#7 blocks this issue), "Blocks #9" outward, with `name`
  the phrase (`blocked by`). A list works ("Blocked by #7, #8 and imagile/api#3"),
  a bare `#n` is in the issue's own repository, and text in code is skipped. The
  other issue, when it is in the input, gets the opposite link (`blocks` or
  `blocked by`), as Jira and Azure DevOps hold a link on both items. Mentions (the
  timeline's `cross-referenced`) are not links: every "Blocked by #7" is also a
  mention of #7. GitHub's own **issue dependencies** have a REST API, but no toil
  command reads them yet: an issue whose `issue_dependencies_summary` counts any
  lists `links` in `unmapped`, saying how many.
- GitHub's newer **issue fields** have a REST API (`/repos/{owner}/{repo}/issues/{number}/issue-field-values`),
  but no toil command reads them yet, so OWI doesn't map them yet.
- History from `github issue history`: each `closed` and `reopened` as a
  transition, and each `milestoned` and `demilestoned` as an iteration change
  (moving an issue between milestones is both, in the same second, read as one
  change).

### A history's item

A Jira changelog and a GitHub timeline don't name their issue, so wrap each as
`{ "key": "PAY-104", "history": <envelope> }`, or pass `--key` for one. An Azure
DevOps revision names its work item. A history whose item isn't in the input is
returned in `histories`, to attach to an item you already hold.

## The change (0.2)

A change is a pull request. Its commands, by area:

| Area | Changes |
|------|---------|
| `github` | `github pr list`, `github pr get` |
| `bitbucket` | `bitbucket pr list`, `bitbucket pr get` (Data Center and Cloud: the connection's deployment says which shape it is) |
| `ado` | `ado pr list`, `ado pr get` |

A list is enough to rank what is open. What it can't hold (reviews, checks, commits,
the files changed) comes from `pr get --include reviews,checks,commits,files`, which
adds them as `included` in one call. A pull request in both a list and a get is one
change with the get's fields, and `native` keeps both records. A field the input
couldn't fill is in `unmapped` with the command that would fill it, never guessed.

| Field | Type | Meaning |
|-------|------|---------|
| `owi` | `"0.2"` | The OWI version of this record |
| `id` | string | `<connection>:<repo>#<number>`: `github:imagile/payments-web#41`, `corp-bitbucket:PAY/payments-core#311`, `corp-ado:Payments/settlement#87` |
| `source` | object | `{ area, connection, key, command }`, as for a work item; `key` is `<repo>#<number>` |
| `url` | string or null | The pull request in the host's web UI |
| `repo` | string | The repository as the host names it: `owner/repo`, `PROJECT/slug`, `workspace/slug`, `project/repo` |
| `title` | string | |
| `branch` | object | `{ source, target }`, branch names without `refs/heads/` |
| `state` | enum | `OPEN`, `MERGED`, `DECLINED` (closed unmerged, abandoned, superseded) or `DRAFT` |
| `author` | Person or null | Who opened it |
| `authorKind` | enum | `HUMAN`, `AGENT` or `BOT` (below) |
| `authorKindSource` | enum | The signal that set it: `override`, `account`, `trailer`, `branch` or `default` |
| `authorKindSignal` | string or null | The signal in words: `account dependabot[bot], type Bot`, the trailer, `branch copilot/receipt-currency`; null for `default` |
| `reviewers` | Reviewer[] | `{ person, state }`, each asked to review, with `state` `APPROVED`, `CHANGES_REQUESTED` or `PENDING` as it stands now |
| `reviews` | Review[] or null | `{ by, state, at }`, every review oldest first, `state` `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED` or `DISMISSED` (an approval withdrawn, a vote reset). Null when the input held none |
| `checks` | enum or null | The checks on the latest commit, rolled up: `FAILING` when any fails, else `PENDING` when any is still running, else `PASSING`; `NONE` when none ran; null when they weren't read |
| `checksAt` | instant or null | When the checks came to that state: for `FAILING`, the earliest finish of a check that is failing now; otherwise the latest check |
| `mergeable` | boolean or null | `false` is a merge conflict; null when the host didn't say |
| `size` | object or null | `{ files, additions, deletions }`, each null where the host doesn't count it |
| `workItems` | id[] | The OWI ids of the work items its title, branch and description name (below) |
| `mergeCommit` | string or null | For a merged change, the commit it merged as: what a deployment names |
| `created` | instant or null | When it was opened |
| `firstReviewAt` | instant or null | The first review by someone other than the author |
| `approvedAt` | instant or null | The first approval by someone other than the author |
| `mergedAt` | instant or null | |
| `closedAt` | instant or null | When it was merged or declined |
| `updated` | instant or null | |
| `unmapped` | object[] | `{ field, reason }` for each field the record couldn't fill |
| `native` | object | The source records, keyed by the command that returned each |

### Who wrote it

`authorKind` is never guessed. It is set by the strongest signal there is, in this
order, and `authorKindSource` says which:

1. **`override`**: an author kind set by hand for the author's id, name or email
   (`--author-kind release-bot=BOT`, `authorKind` over MCP; a code host's toil project
   section keeps them as `authorKinds`, which Toil UI passes on).
2. **`account`**: the host says what the account is. GitHub's `type: Bot` (or a
   `[bot]` login) is `BOT`, except the accounts the coding agents open pull requests
   as (`Copilot`, `copilot-swe-agent[bot]`, `claude[bot]`, `devin-ai-integration[bot]`,
   `chatgpt-codex-connector[bot]`), which are `AGENT`. Bitbucket Data Center's
   `SERVICE` user, Bitbucket Cloud's `app_user` and an Azure DevOps service identity
   (a `svc.` descriptor) are `BOT`.
3. **`trailer`**: a commit's `Co-Authored-By` trailer names an agent (Claude or
   anthropic.com, Copilot, Codex or openai.com, Cursor Agent, Devin). Read from
   `pr get --include commits`. A trailer is the signal; a message merely mentioning
   one isn't.
4. **`branch`**: the source branch starts with an agent's prefix, `claude/`,
   `copilot/` or `codex/`.
5. **`default`**: none of these, so `HUMAN`. When the commits weren't read, that is
   listed in `unmapped`, since a trailer could have said otherwise.

### The work items it names

`workItems` are read from the title, the source branch and the description, in that
order, each id once, with text in code skipped:

- **A host's own references**, with no setup. On GitHub, `#12` and `owner/repo#12`
  are issues on the same connection, and so is a branch named for its issue
  (`291-pr-tracking`, `kolatts/291-pr-tracking`). On Azure DevOps, `#2302` (and a
  branch named `2302-…`) is a work item in the same organization, as Azure DevOps
  itself reads it. Bitbucket has no tracker, so it has none.
- **Key patterns**, for everything else: text with `{n}` where the number is, and the
  connection the keys belong to (`--key-pattern PAY-{n}=corp-jira`, `keyPattern` over
  MCP, `keys` to `mapOwi`). The text is matched as written, never as a regular
  expression, and not inside a longer word. The key is the text matched (`PAY-101`,
  `imagile/payments-web#42`), except that a mention ending `#{n}` with no repository
  in it names the number alone: `AB#{n}=corp-ado` reads Azure Boards' `AB#2302` as
  `corp-ado:2302`. A Bitbucket pull request read with no key patterns lists
  `workItems` in `unmapped`.

GitHub numbers issues and pull requests together, so `#12` may be either: an id that
is itself a change in the same input is dropped from `workItems`.

### Mapping each host

- **GitHub** (`github`). `state` from `merged_at`, `state` and `draft`.
  `reviewers` are `requested_reviewers` and `requested_teams` (pending), with each
  reviewer's last approval or request for changes from the reviews; a re-requested
  reviewer is pending again. `checks` from the check runs on the head commit
  (`failure`, `timed_out`, `cancelled`, `action_required`, `startup_failure` and
  `stale` fail; `neutral` and `skipped` pass). `mergeable` and `size` (`changed_files`,
  `additions`, `deletions`) from `pr get`; a list has neither.
- **Bitbucket Data Center** (`bitbucket`, deployment `server`). `reviewers[].status` `APPROVED`,
  `NEEDS_WORK` (changes requested) or `UNAPPROVED` (pending); reviews from the
  activities `APPROVED`, `REVIEWED` and `UNAPPROVED`. `checks` from the build statuses
  (`SUCCESSFUL`, `FAILED`, `INPROGRESS`). `mergeable` from `properties.mergeResult`
  (`CLEAN`, `CONFLICTED`). `size` counts files only: Data Center lists changed files,
  not lines.
- **Bitbucket Cloud** (`bitbucket`, deployment `cloud`). `SUPERSEDED` is `DECLINED`. Reviewers from
  `reviewers` and the participants' `state` (`approved`, `changes_requested`); reviews
  from the activity's approvals and requests for changes. `checks` from the commit
  statuses (`SUCCESSFUL`, `FAILED`, `STOPPED`, `INPROGRESS`); `size` from the diffstat.
  Cloud records no merge or close time and doesn't say whether a pull request merges
  cleanly, so `mergedAt`, `closedAt` and `mergeable` are unmapped.
- **Azure DevOps** (`ado`), one mapper for Server and Services.
  `completed` is `MERGED`, `abandoned` `DECLINED`, `isDraft` `DRAFT`. A vote of 10 or
  5 is `APPROVED`, -5 or -10 `CHANGES_REQUESTED`, 0 `PENDING`; reviews from the
  comment threads: a `VoteUpdate` thread is the vote, and a thread a reviewer started
  is a review that commented. `checks` from the latest status per context
  (`succeeded` and `notApplicable` pass, `failed` and `error` fail, `pending` and
  `notSet` run). `mergeable` from `mergeStatus` (`succeeded`, `conflicts`). `size`
  counts files only, and a pull request records no last-updated time, so `updated`
  is unmapped.

### The pull request fixture

`test/fixtures/owi/pull-requests.ts` holds Sprint 42's pull requests across four
hosts: Bitbucket Data Center (`corp-bitbucket`, PAY/payments-core), Azure DevOps
Server (`corp-ado`, Payments/settlement), GitHub (`github`, imagile/payments-web) and
Bitbucket Cloud (a `bitbucket` connection named `bitbucket-cloud`, imagile/checkout-sdk), each as its `pr list` and
`pr get --include reviews,checks,commits,files` print it. Among them: a pull request
sent back for work with a failing build, one waiting four working days for a first
review and in conflict, an agent's pull request with no reviewer and no issue whose
checks have failed for days, a draft, merged ones after one round and after two,
bots (a service account and dependabot), and agents by trailer and by branch.
`pull-requests.owi.json` is what `util owi map` makes of it with the key patterns
`PAY-{n}=corp-jira` and `imagile/payments-web#{n}=github`; `test/owi-changes.test.ts`
regenerates it (`npx vitest run test/owi-changes.test.ts -u`) and fails when it drifts.

## Pointing a field at your own

Teams rarely keep the defaults, so these OWI fields can be pointed at any field:
`estimate`, `estimateUnit`, `priority`, `type`, `team`, `dueDate` and `iteration`.
The keys are the ones a toil project section's `fields` uses for its aliases
(`docs/projects.md`):

```json
{ "jira": { "fields": { "estimate": "customfield_10234", "estimateUnit": "points" } } }
```

`toil util owi map --field estimate=customfield_10234 --field estimateUnit=points`
passes the same thing on the CLI, `field` over MCP, and `fields` to `mapOwi`. The
value names a field as the record holds it: a Jira field id or registered name, an
Azure DevOps reference name, a GitHub project field's name. `estimateUnit` is
`points` when not given (`timeoriginalestimate` is always hours). An override that
names no OWI field, or a unit other than points, hours or days, is refused.

Two more keys are for a GitHub repository run without a board:

- `estimateLabel`: the label that holds an estimate, with `{n}` where the number
  is (`"estimateLabel": "size/{n}"`). It is matched as written, in any case, never
  as a regular expression. One without exactly one `{n}` is refused.
- `iterationDays`: how many days a milestone's sprint runs, ending on its due date
  (`"iterationDays": "14"`), a whole number from 1 to 366.

```json
{ "github": { "owner": "imagile", "repo": "payments-web", "fields": { "estimateLabel": "size/{n}", "iterationDays": "10" } } }
```

## OSLC CM mapping

OWI maps to [OSLC Change Management 3.0](https://docs.oasis-open-projects.org/oslc-op/cm/v3.0/os/change-mgt-spec.html)
(OASIS Standard, May 2021; namespace `http://open-services.net/ns/cm#`, prefix
`oslc_cm`). Each item is one `oslc_cm:ChangeRequest` whose resource URI is `url`.
This is a documented mapping only: no tracker serves OSLC, and toil has no export
command.
It covers work items only: a change (a pull request) is not an OSLC CM resource,
and OSLC's configuration management domain has no pull request either.

| OWI | OSLC CM |
|-----|---------|
| `owi`, `source`, `native`, `unmapped`, `history` | No equivalent: OWI's own bookkeeping. OSLC tracks history through its own resource versions, outside the resource |
| `id` | `dcterms:identifier` |
| `url` | The resource URI |
| `type` | The class: `BUG` is `oslc_cm:Defect`, `TASK` `oslc_cm:Task`, `STORY` and `EPIC` `oslc_cm:Enhancement`; `INCIDENT` and `OTHER` stay `oslc_cm:ChangeRequest` |
| `typeName` | `dcterms:type` (deprecated in 3.0, kept for readers) |
| `title` | `dcterms:title` |
| `body` | `dcterms:description` |
| `status` | `oslc_cm:status` (deprecated in 3.0); `oslc_cm:state` where a reader defines `oslc_cm:State` values |
| `statusCategory` | The state predicates: `oslc_cm:closed` is `DONE`, `oslc_cm:inProgress` is `IN_PROGRESS`; `TODO` is both false; `UNKNOWN` leaves both out |
| `resolution` | No equivalent. `oslc_cm:fixed` can't be told from it reliably (a Jira "Done" and a GitHub `not_planned` both close), so it is left out |
| (none) | `oslc_cm:approved`, `oslc_cm:reviewed` and `oslc_cm:verified`: no tracker records these as booleans, so they are left out |
| `assignee` | `dcterms:contributor` |
| `reporter` | `dcterms:creator` |
| `priority` | `oslc_cm:priority` |
| `estimate` | No equivalent |
| `labels` | `dcterms:subject` |
| `team` | No equivalent |
| `iteration` | `oslc_cm:affectsPlanItem`, pointing at the iteration as a plan item |
| `parent` | `oslc_cm:parent` |
| `children` | The inverse of `oslc_cm:parent` on each child |
| `links` | `relates` is `oslc_cm:relatedChangeRequest`; `blocks`, `duplicates` and `implements` have no CM property and are written as `oslc_cm:relatedChangeRequest`, losing the direction |
| `created` | `dcterms:created` |
| `updated` | `dcterms:modified` |
| `resolved` | `oslc_cm:closeDate` |
| `dueDate` | No equivalent |

## Finding likely duplicates

`toil util owi similar` reads OWI records back in (what `util owi map` printed, or
a JSON array of records) and finds likely duplicates among them: against some
text, against one item, or pair by pair across the whole set, so one problem filed
in Jira and again in GitHub is found. It reads `title`, `body` (any of the four
formats, as plain text), `labels`, `parent` and `links`, and nothing else; the
scorer is `src/core/owi/similar.ts`, and `findSimilar` in `@imagile-dev/toil/api`.
The score is lexical, not semantic, and every result says which terms and fields
drove it (`skills/toil/util.md`).

## The sprint fixture

`test/fixtures/owi/` holds one sprint of placeholder work for anything that needs
realistic OWI items without a tracker, the Toil UI preview first:

- `sprint.ts` builds the input: the envelopes `jira issue get`, `jira issue history`,
  `ado work-item iterations`, `ado work-item get-many`, `ado work-item history`,
  `github issue get`, `github issue history` and `github project items` print,
  as `util owi map` reads them (also served to its examples as `owi/sprint-42.jsonl`).
- `triage.ts` adds a week of newly filed work to it, from Jira Data Center, Jira
  Cloud, Azure DevOps Server and GitHub Enterprise, with four duplicates planted (one
  across trackers, one between Data Center and Cloud, one within a tracker and one
  misspelt), a near-miss and noise; `triage.owi.json` is what `util owi map` makes
  of both, thirty-nine items, which `test/owi-similar.test.ts` regenerates and the
  `util owi similar` examples read.
- `sprint-42.owi.json` is what `util owi map` makes of it: `{ owi, count, items }`,
  twenty-nine items that all validate. `test/owi.test.ts` regenerates it
  (`npx vitest run test/owi.test.ts -u`) and fails when it drifts.

Sprint 42 runs 2026-10-05 to 2026-10-16, across eight Jira issues (`corp-jira`,
project PAY), seven Azure DevOps work items (`corp-ado`, project Payments) and
five GitHub issues (`github`, imagile/payments-web, on project 7). It holds a
blocked chain in each of Jira and Azure DevOps (PAY-101 blocks PAY-102 blocks
PAY-103; 2302 precedes 2303), scope added mid-sprint (PAY-107, 2306,
payments-web#43), items carried over from Sprint 41 (PAY-104, 2304), unestimated
and orphaned items (PAY-107, payments-web#45), and finished and removed ones.
Nine more were finished in Sprints 40 and 41 (PAY-92, PAY-95, PAY-97, PAY-98, 2290,
2294, 2297, payments-web#36 and #38), with the histories that give throughput and
cycle time the weeks before Sprint 42.
Every host is a placeholder and every name invented.
