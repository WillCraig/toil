# Toil UI

A local web app for seeing work across Jira, Azure DevOps and GitHub, read through
[toil](https://www.npmjs.com/package/@imagile-dev/toil): one dashboard per dossier,
with its stories, pull requests, builds and deployments side by side, a pull
requests view for what is waiting on review, and a daily worklog of what happened.

**Status: beta, local only.** It runs on your own machine, binds loopback, and
reads through toil with your own connections and dossiers, read-only. Its
settings pages, and a dossier's name and description edited in place, are the only
places it changes anything of toil's, and only toil's own connections and dossiers. The worklog keeps its pages and the notes you add in its own
data folder, and writes anywhere else only when you export a page. Its Feedback dialog sends a report to Imagile through
`toil feedback`, only when you approve it. It is a separate package from toil: installing toil
never installs it. toil's beta commitment to stable commands, flags and output doesn't
cover Toil UI: its screens, and its server's HTTP API, which is internal to the
package, can change from one beta to the next.

## Start it

```bash
npx @imagile-dev/toil-ui
```

It needs Node 24.22.1 or later on 24.x, or 26.12.1 or later, as toil does, and installs one dependency, `@imagile-dev/toil`, at
the exact version it was built with. It is published on
[npm](https://www.npmjs.com/package/@imagile-dev/toil-ui). To run the checkout you
are reading instead, build it from a clone of the repository:

```bash
npm ci --ignore-scripts
npm run build -w ui
node ui/dist/server/toil-ui.js
```

It prints one URL and keeps running until you press Ctrl+C:

```text
Toil UI <version> (beta, local only), on toil <version>
Syncing through toil, read-only, with your own connections and dossiers. Only its Settings pages, and a dossier's name and description edited in place, change anything: toil's own connections and dossiers, when you ask. The worklog keeps its pages and your notes in its data folder, and writes anywhere else only when you export one. Feedback goes to Imagile only when you send it.
The cache is /home/you/.toil-ui/cache/toil-ui.db, kept 30 days after each sync; toil-ui wipe deletes it.

Open this URL in your browser. It carries this launch's token, so keep it to yourself:
  http://127.0.0.1:53117/?token=<token>
```

Open that URL. The page trades the token for a session, and the token leaves the
address bar. The tab keeps the session in `sessionStorage`, so reloading the page
works. A new tab needs the URL again, and so does a restart of `toil-ui`, which always
ends the session; each start prints a new token. A duplicated tab, or one the browser
restores, can carry the session while the same `toil-ui` is still running. Toil UI opens no browser itself.

Why the token, and why `sessionStorage`: the server can run toil with your own
connections, so something has to keep other local processes and users out of it, and
the token is that lock. A cookie would have made reloads easy, but a browser sends a
cookie to every port on `127.0.0.1`, so any other local server would receive the
session. `sessionStorage` belongs to this exact origin (port included) and is never
sent anywhere. `localStorage` would outlive the tab, so it isn't used.

`toil-ui --sample` serves the sample dossiers and the scripted agent that
[the site's Toil UI page](https://imagile-dev.github.io/toil/ui/) runs on, with
nothing connected to a tracker.

## First run

Until you have a dossier and it has synced once, the Dossiers view shows a short
checklist in place of the empty page:

1. **Connect a tracker** opens Settings, Connections at the add form. If an agent following the toil skill's `setup.md` already created the connection, you only enter its secret here, on its row.
2. **Create a dossier** opens Settings, Dossiers at Create a dossier.
3. **Sync** starts the first sync, as the Sync panel's Sync now does.

Each step ticks itself off from toil's own state: `toil connections list` for a
connection to Jira, Azure DevOps or GitHub (one made by env vars counts), `toil
dossiers list` for a dossier, and the Sync panel for the sync. Beside the steps,
**Try the sample data** shows `npx @imagile-dev/toil-ui --sample` with a Copy
button, to restart Toil UI on the sample dossiers. The checklist goes once the first
sync finishes. Each step's (i) explains it and links to these docs.

## What it reads

Each dashboard reads its dossier the way `toil dossiers show` describes it: the
Jira project, the Azure DevOps project and pipelines, the GitHub repositories and
project board, and the OpenShift namespace of each environment. A dossier's GitHub
repositories are the `github` section's `owner` and `repo` (one value, or one per repo
name), plus its `repos` remotes on github.com or on the host of a repository the section names, and each is read on its own
with `owner` and `repo` passed explicitly (`src/github-repos.ts`); a repository that
couldn't be read gets one muted line where its gap shows: "pull requests not read" on the Pull requests view (linking to the failed call), "work items not read" on the Board tab. The same goes for the other
areas' per-repo values: a Jira `project`, a Bitbucket `project`, `workspace` or `repo`,
and an Azure DevOps `collection`, `project` or `repo` given as an object of repo name to
value are each read once per target (one Jira search per project, work items per Azure
DevOps project, pull requests per repo) with those inputs passed explicitly
(`src/targets.ts`; a pipeline is tried in each Azure DevOps project in turn, and a repo name the section leaves half-named is shown as not read), because Toil UI has no repo folder for toil to pick one from; a section
with plain values sends the calls it always did. Only GitHub's remotes are read for more
targets. A GitHub section with no `projects`
reads each repository's own issues, open and closed, as its work items, with the
history of every open one and the 50 most recently closed in each. Pull
requests are read from every code host the dossier names (GitHub, Bitbucket Data
Center and Cloud, Azure DevOps Server and Services) with `pr list`, then `pr get
--include reviews,checks,commits,files` for every open one and the 20 newest closed or
merged ones (of each GitHub repository), and mapped to OWI 0.2 changes; a GitHub repository's CODEOWNERS is read
with `github repo file` when an open pull request has no reviewer. Every call runs
in-process through `@imagile-dev/toil/api`, read-only, and toil's audit log
records it with `via: "api"` and `caller: "toil-ui"`. A call that fails shows on
its own panel with toil's message and fix.

Jira and Azure DevOps are read for their open items plus anything changed within
the read window: the retention period, but at least 6 weeks (42 days), so the
longest view stays whole. A closed item older than that isn't read, and so isn't
in any view.

## The Dossiers view

Toil UI opens on its dossiers, one card each, read from the same data the dashboards
read, so it asks no tracker anything: in the local app that is the cache a sync
filled, plus `dossiers list` and `dossiers show` for the dossiers themselves.

- **What each card shows:** the current sprint with its working days left, points
  done and a small burn-up; how many items are in progress and blocked, and how many
  pull requests wait on a review; the people with work in it, as avatars; its sources
  as badges; when it was last synced; and how many work items and pull requests
  changed since this browser last opened its dashboard.
- **Which card leads:** the dossier opened most recently in this browser, or, before
  any was opened, the one with the most in motion (in progress, blocked and waiting on
  review together), takes two columns where they fit. On a wide screen the grid goes
  wider than the dashboards and fits more cards across; at 375px it is one column.
- **What this browser remembers:** when each dashboard was last opened, in
  `localStorage`, never sent anywhere. Without it (a private window) the cards just
  say nothing about "since".
- **A dossier's top row** uses the same parts: the description beside the name, the
  sources as badges, and the sprint's day (The dossier page, below).

### Renaming and describing a dossier

The name and the description have a pencil beside them, on the card and in the
dossier's top row. It opens an inline field: Enter saves through
`toil dossiers describe <dossier> --name <new name>` or `--description <text>`, run
on the settings pages' path (below), so toil's own checks apply and the change is in
its audit log as `caller: "toil-ui"`. Escape cancels, and a refusal shows toil's
message and fix under the field. Only a dossier in your own folder can be renamed or
described; a checked-in one is refused with the `toil dossiers import` fix.

A rename keeps everything Toil UI holds for the dossier: the server moves its cache
(responses, items, history, sources, sync runs, notes and agent runs), its assignments
and its worklog pages to the new name once toil has renamed the file, so its
dashboard opens straight away with no new sync. A rename waits, refused with a
message, while a sync or an assignment of that dossier is running, since both read it
by name as they go. What can't be moved is said beside toil's result, and the next
sync reads the dossier afresh under its new name.

## The dossier page

A dossier opens on its **Overview**, the briefing, in a frame all of its pages share:

- **The top row:** its name, with the pencil that renames it; **Switch**, for another
  dossier or the Dossiers view; the sprint and its day; its description, cut to one
  line with the whole of it in its tooltip, and its sources; and the Ask bar with
  **Analyze** (The agent, below).
- **The tabs**, one address each: **Overview** (`#/dossier/<name>`), **Board**
  (`/board`, with how many of its cards need attention), **Dependencies**
  (`/dependencies`), **Pull requests** (`/prs`), **People** (`/people`), **Worklog**
  (`/worklog`) and **Analyses** (`/analyses`). The Command Center (`/command-center`)
  is the Board tab's **Readiness** view, the stand-up is the Worklog's, and an item's
  page sits under Board, so every address from before the tabs still opens. On a
  narrow screen the tabs scroll sideways.
- **The Agents sidebar**, beside every tab from 1200px wide, and a drawer behind the
  **Agents** button below that: the tracker's inbox, then the dossier's assignments
  in three groups (those that need you, those working, and those gone stale), with the
  finished ones under **Earlier**; then **Renew all stale**, the **Limits**, and this
  dossier's three newest analyses, each linking to it (Assigning work to an agent, below).
  While an item's drawer is open (`?item=<id>`, The briefing, below), it takes the
  sidebar's column from 1200px wide, and covers the view from the right below that.
- **Analyses** lists every Analyze kept for the dossier, newest first: when it was made,
  the adapter and model that wrote it, its one-line recommendation, and what changed
  since the one before (items newly blocked or blocked by something new, blockers
  cleared, points moved on an item or in the sprint, items newly cited or no longer
  cited, a new recommendation). What changed is worked out by code, from a snapshot of
  the dossier's items each analysis keeps, never by asking the agent. **Open** reads one
  again at its own address (`/analyses/<id>`), top-down like the chat, with its
  suggested changes and what it used. The server keeps them in the cache (Sync and the
  cache, below), so they outlast a reload and a restart; with `--sample`,
  card-payments starts with two, kept in memory for the run.

### The briefing

A dossier opens on its briefing: one column to read top to bottom, each part a step
further in, and each step one you choose (#494).

1. **The recommendation:** the one thing to do first, as a sentence. Over it, the
   sprint and its day, and who wrote the briefing: the latest Analyze, when it is
   current (made since the data was read, or the same UTC day) and answered with a
   briefing, with who wrote it, when, and a link to it; otherwise toil's briefing by
   code (`toil dossiers brief`, `src/core/brief/`), with no agent call, which says so,
   and why when an older Analyze exists.
2. **Why:** the reasons, one line each, the first open and the rest folded: Failing
   checks, Blocked, Waiting on review, Sprint at risk, Stale, Over the WIP limit, and
   Ticket and pull request disagree, in the dossier's order. Each item is under one
   reason only, as a row with its key, title and assignee. Then **On track**, counted
   rather than listed.
3. **One step in:** anything the dossier's focus left out, with why, and anything the
   code flagged that Analyze didn't mention, so nothing drops off the page unsaid. An
   id Analyze named that isn't the dossier's is shown in red.
4. **The numbers**, folded: burn-up, throughput, cycle time, aging work in progress
   and pull request wait, each opening its full chart.
5. **Go to:** every other view, as well as its tab.

A row, or any item link on the briefing, opens the item's **drawer** at the page's
own address plus `?item=<id>`: beside the view at 1200px and wider, over it below
that. It says why the item is there and who said so, the next step when Analyze
wrote one, any change Analyze proposed for it, its pull requests and the chain it's
in, with **Open** for its page and a link to it in its tracker. A Board card's key
and the items on Pull requests open the same drawer. Escape or **Close** goes back
to the view behind it.

#### Tuning Analyze

Each dossier tunes how Analyze briefs it, under **Settings → Dossiers**, **How
Analyze briefs** (`#/settings/dossiers/<name>/analyze`): its goal, who it's written
for, its lenses in order with their thresholds, and what else to watch for or leave
out, the lenses folded until you open them. **The prompt Analyze will send**, under
the form, shows it as you type, composed by toil's own code, and **Save** runs
`toil dossiers analyze set` with only what you changed, the line it runs shown under
the form. The settings live in the dossier file, so a team that shares the dossier
shares them; whenever a dossier tunes Analyze, the briefing names the file and
whether it's your own, and a focus from a dossier you haven't adopted still applies.
Clearing a setting is a delete, made in a terminal. Toil UI composes the preview with
the toil code it's built with, and Analyze asks the toil it runs on, so the two match
when Toil UI and toil are released together.

#### Customize

**Customize**, on the briefing's top line, keeps how you like it in this browser
only: whether the first reason opens, whether the numbers start open, which amber
reasons are hidden (a red one, failing checks or blocked, can be folded but never
hidden, and the On track line counts what is), whether an item opens in its drawer
or on its own page, and **Run Analyze after each sync**, off unless you turn it on,
since each run uses your agent's usage. It runs once for each sync that finishes
while the page is open, never for the one already there when it opened.

### The Dependencies tab

The Dependencies tab opens on the **blocker timeline**, a Gantt chart of every item that
blocks another or is blocked, on the current sprint's dates, then the dependency graph.

- **Each item is a bar.** A solid segment is its time in progress, from its
  transitions. A hatched, outlined segment is its time blocked, from its `blocks`
  links until the blocker finished. A thin strip under the bar is its failing checks,
  from the first of its open pull requests' latest run of failed builds, or the pull
  request's own failing checks. A tick after the bar means it is done, and a blocker
  not started yet says so in place of a bar. Each mark
  differs by its shape as well as its colour, and the key above the chart draws each
  one.
- **Arrows join each blocker to what waits on it**, pointing at the item that waits.
  A dashed arrow is a wait that is over: the blocker is done. A dotted line marks today.
- **The critical chain** is the chain of open blockers holding the most points (the
  longest chain when nothing on any chain has points). Its rows carry a diamond and
  its arrows are drawn heavy, and it is named above the chart. The briefing's
  **Blocked** reason names the same items.
- **What is estimated is said, in the chart's note and on each table cell.** No tracker
  toil reads dates a link, so a block is drawn from when both items existed. An item
  whose history records no move into In progress (GitHub records only open and closed)
  is drawn in progress from when it was created. Nothing is fetched for the chart: it
  reads the links, transitions, pull requests, builds and checks the dossier already
  synced, and the readiness gate's verdict for work not started.
- **The table under the chart lists every bar and every arrow**, with links: each
  item's status and points, its time in progress, blocked (and by what) and with
  checks failing, what it waits on, whether it is on the critical chain, and whether
  it is ready to start. The chart is an image with a summary for a screen reader; the
  table is its accessible equivalent, so the bars themselves aren't focusable.
- **On a narrow screen** the chart keeps its smallest width and scrolls sideways in its
  own scroller, which can be focused and scrolled with the keyboard, with a line above
  it saying so; the page itself never scrolls sideways.

### The board

The Board tab flags each card that needs attention, with a flag beside its status and
an edge in the warning colour: anything that needs action now or a look (Insights,
below), but not what is only worth knowing. **Needs attention only** narrows the board
to those cards, and the tab carries how many there are. Drag a card to another column,
or press M on it for its menu, to propose the move: nothing changes until you apply
the command the proposal shows, and the card stays where its tracker says. Under the board are its
stories with their pull requests, builds and deployments, then the builds and
deployments themselves.

## Insights

The board's cards and its **Needs attention** flag and the flow charts mark
each open work item with its insights, weightiest first, each naming the data it
rests on (`ui/src/model/insights.ts`). One the data can't support isn't raised at
all, rather than raised on a guess. A card shows one chip per kind of insight,
with a count when there are several ("Blocking 2"); its tooltip lists each one,
and the item view lists them all.

| Insight | Means | Weight |
|---|---|---|
| Blocked | Another item that isn't done blocks it (its links) | needs action now |
| Build failing | Its pull request's latest build failed | needs action now |
| Aging | In progress longer than 85% of the dossier's finished items took; needs at least three cycle times to compare with | needs action now |
| Deployed, still open | An environment runs it, but it isn't done | needs a look |
| Carried over | It was in the previous sprint too | needs a look |
| PR with no build | A pull request for it is open with no build | needs a look |
| Stale | No update for more than 5 days | needs a look |
| Blocking | It blocks another item | needs a look |
| Merged, not deployed | Its pull requests are merged, but no environment runs them yet; only for a dossier that names environments | worth knowing |
| No estimate | It has no estimate | worth knowing |
| Added mid-sprint | It joined the sprint after it started | worth knowing |

## Pull requests

Each dossier has a **Pull requests** tab (`#/dossier/<name>/prs`), built from OWI 0.2
changes:

- **Waiting now:** the open pull requests, longest wait first, each with what it
  waits on (review, changes, checks, merge, or a draft its author holds), since when
  in working days and why, who wrote it (a person, an agent or a bot, with the signal
  that said so), the work items it names, and its size, XS to XL by changed lines.
- **Flags:** no first review in 2 working days, checks failing for over a day, a merge
  conflict, no linked work item, a work item done while its pull request is open, and
  a merged pull request whose item isn't done, each with what it rests on.
- **Flow:** pickup (opened to first review), review (first review to approval) and
  merge (approval to merge) times, review rounds, sizes and merges per week, over six
  weeks, each split by people, agents and bots and each with its sample size and what
  couldn't be measured.
- **Suggested reviewers:** for an open pull request with nobody asked, the CODEOWNERS
  of its paths and the earlier reviewers of the same files and folders, each as a
  proposal with the `toil … --allow-write` line to ask them.

The dossier's work item keys are matched in each pull request's title, branch and
description (a Jira project's `PAY-101`, Azure Boards' `AB#2302`, a GitHub
repository's `owner/repo#41`). A code host's section may set author kinds by hand,
`"authorKinds": { "release-bot": "BOT" }`, which win over every other signal.

## People

Each dossier has a **People** tab (`#/dossier/<name>/people`), built
from the same OWI work items and changes as the dashboard and the pull requests view,
and from the dossier's `people` section, which says who each person is in every
system (`toil dossiers person`, or **Settings, Dossiers**):

- **A card per person**, agents included, in name order: their work in progress by
  status with how long each item has sat in it, their open pull requests and what
  each waits on, the reviews waiting on them (oldest first), their blocked items and
  what blocks each, and what they did in the last 14 days. A link opens their items
  on the Board tab, filtered to them.
- **A team strip:** work in progress against the dossier's `wipLimit` and who is over
  it, the review queue, and the current sprint's unassigned items.
- **Agents:** a person with `kind: "agent"`, matched by the same signals as a pull
  request's author kind (its account, a Co-Authored-By trailer, a branch prefix) where
  the signal names it. A person's own pull request written with an agent says so.
- **Accounts the dossier doesn't map** get cards of their own, so no work goes
  missing. One that shares an email with a person, or with an account in another
  system, is suggested as a match with the `toil dossiers person` line that applies
  it; it is applied only when someone presses the button, and an email that fits more
  than one candidate suggests nothing and says why. Accounts that only wrote bots'
  pull requests are left out and counted.

It shows what is on each plate and never scores anyone: no ranking, no productivity
figure, no person-to-person comparison and no line or commit counts. Flow metrics
stay team-level, in the pull requests view.

## Readiness and the Command Center

Before a work item goes to an agent, Toil UI checks whether it is ready for one. The
check uses no model and no premium request: only the item's cached OWI record, the
dossier's other items, and at most one live read, made when you press for it
(`ui/src/model/readiness.ts`). Its verdict is **ready**, **thin** or **blocked**, with
one row per check:

| Check | Passes when | Otherwise |
|---|---|---|
| Acceptance criteria | The field the dossier names has them, or the description has an "Acceptance criteria", "Definition of done" or "Done when" heading with text under it, or a checklist | thin |
| Description | At least `minWords` words (25 by default) of real text, not counting the dossier's template lines, placeholder lines (TBD, N/A, lorem ipsum) or unfilled `<slots>` | thin |
| Done state | It isn't done, and a way to Done is known: a GitHub issue closes from any state; otherwise an item of the same type in the dossier reached Done, or the live read finds a Done state (Azure DevOps) or a move into Done (Jira) | blocked when it's already done, or the workflow has no Done state; thin when it isn't known |
| Blockers | No open item blocks it | blocked by an open item; thin for a blocker the dossier doesn't hold |
| Scope | It comes from one of the dossier's sources, and the dossier names a repository | blocked from outside the dossier; thin with no repository |

The verdict is blocked when any row is, thin when any row is, and ready only when every
row passes. Each area's section in the dossier sets it up:

```json
"jira": {
  "project": "PAY",
  "fields": { "acceptanceCriteria": "customfield_10500" },
  "readiness": { "minWords": 20, "templates": ["## What\n## Why\n## Acceptance criteria"] }
}
```

`fields.acceptanceCriteria` is also the area's `--field` alias. An Azure DevOps section
that names none uses `Microsoft.VSTS.Common.AcceptanceCriteria`.

- **On each item's page**, a **Ready for an agent?** panel shows the verdict and its
  rows, each with where its answer came from. **Check the workflow live** makes the one
  live read, read-only: `jira issue transitions` for a Jira issue, `ado work-item
  states` for an Azure DevOps type. A GitHub issue needs none.
- **The Command Center** (`#/dossier/<name>/command-center`, the Board tab's Readiness view) lists every
  work item with its verdict and, for each one that isn't ready, the rows that say why.
  It filters by verdict, status, type, assignee and source, and makes no live read.
  It is strict: only ready items are slated, in the dossier's order, under a plan id
  that changes when anything in the plan does.
- **Starting the plan comes with assign-to-agent (#293).** Until then the start button
  is disabled and says so; the plan it would start is shown above it.
- **The agent** gets `readiness_list` and `readiness_get` and a starter, "Which items
  are ready for an agent?" (The agent, below).
## Worklog

Each dossier has a **Worklog** tab (`#/dossier/<name>/worklog`):
one page a day, folded by code from what the cache holds, facts only. No model writes
a line of it. A calendar shows the days that have a page, with how many lines each
has; a day opens as `#/dossier/<name>/worklog/<yyyy-mm-dd>`. Days and times are UTC,
as everywhere else in Toil UI.

A page has:

- **Work items** that changed status (from, to, who and when), were added to or
  dropped from a sprint, got a new blocker or had one cleared, and each sprint that
  ended, with how many of its items and points were done.
- **Pull requests** opened, reviewed (approved, changes requested, commented), merged
  or declined.
- **Builds and deployments** that failed or recovered (deployments from OpenShift,
  whose state a sync can see change): a build is recovered when a
  passing run follows a failing one of the same pull request or pipeline.
- **Agent runs:** each question an agent adapter answers in the chat, when it
  started and ended,
  whether it finished, failed, was stopped or was stopped at a usage cap, what it
  cited, and its proposals, each
  with whether toil's audit log (`toil audit list`) shows a person ran that write on
  the same item afterwards. Each run's transcript is kept beside the pages and shown
  under the run, labelled as the agent's.
- **Notes** a person added that day, on today's page.
- **Sources:** each source's syncs that day.

Every line links to its item, pull request, build or transcript, where the source has a
page for it. Two kinds of fact
come in differently. Status and sprint changes, pull requests, reviews and builds
carry their own times in the sources' history, so a page can be built for any past
day the cache covers. A new blocker, a cleared one, a sprint's end and a deployment
that failed or came back have no time in the trackers, so a sync sees them by comparing
what it read with the last sync, and the line says which sync first saw it and when the
one before ran. The facts a sync records for the first time are also what play a theme's
event moments (Themes, below).

**What a page can't vouch for is said at the top:** a day before the earliest sync the
cache holds, a day no sync of a source ran on, a sync that failed, a source whose latest
sync failed, today so far, and a day older than the retention period.

**How it's kept.** Each sync records its facts in the cache, one row per fact by a key
that never changes, so the same fact synced twice is one row. After each sync every
page is folded again from the cache and written where its text changed, as Markdown
in the data folder:

```text
<data folder>/cache/worklog/<dossier>/<yyyy-mm>/<yyyy-mm-dd>.md
<data folder>/cache/worklog/<dossier>/runs/<run id>.md
```

The pages live under the cache's retention: a day whose rows are gone loses its page,
and a wipe deletes them all. **Rebuild this day** folds the day again and says whether
it came out the same as the page kept; the same cache always gives the same page.

**Export** writes the day's or the month's Markdown into a folder you name, through
toil's own file service: `toil util encode base64 --decode --out <file>`, run with that
folder as its workspace, which writes a new file only and never into toil's own
config. Publishing an exported page is a proposal: `toil confluence page create
--body-file <file> --markdown` in the dossier's Confluence space, or `toil github issue
create --body-file <file>` in its repository, for you to run through toil's write gate.
Toil UI posts nothing. With sample data, notes and export are off.

### Stand-up

**Stand-up since the last working day**, on the Worklog
(`#/dossier/<name>/worklog/standup`), reshapes the worklog for a meeting: since the last
working day through today (Friday through Monday on a Monday), or any range of up to 31
days you pick (`#/dossier/<name>/worklog/standup/<from>/<to>`, or `/<day>` for one), and each day's page has a
**Stand-up for this day**. It is a fold of those days' pages by code, with no model, so the
same days always give the same report.

- **Team lines first:** the sprint's working days left, items added to or dropped from a
  sprint, and builds and deployments that broke or recovered.
- **Then each person, agents included,** in four lists: **Done** (items moved into a done
  status, pull requests merged or closed), **In progress** (every other status change,
  pull requests opened or reviewed), **Blocked** (a new blocker on an item they hold, a
  failed build of their pull request, a pull request of theirs waiting on review for 2
  working days or more) and **Next** (current-sprint items assigned to them and not
  started). A line belongs to whoever the fact names: who moved the item, who wrote or
  reviewed the pull request. A pull request a dossier agent wrote goes under the agent.
- **People** come from the dossier's `people`, so one person's Jira, Azure DevOps and
  GitHub accounts land under one name. An account the dossier doesn't map gets its own
  card, named with its area and id; the People view suggests where it belongs.
- **What the worklog can't vouch for** in the range is said at the top. Review waits, the
  sprint and Next aren't on any worklog page, so they are as of the latest sync, and the
  report says which.
- **Every line links** to its item, pull request or build, and is numbered (F1, F2, ...).

It copies as **Markdown** (for Slack, Teams or a wiki) or **plain text**, line for line as
shown. **Export** writes the Markdown through toil's file service, as a page's export does,
to `standup-<dossier>-<from>-to-<to>.md`, and publishing it to Confluence or GitHub is a
proposal for you to run.

**Write it up** is optional: it asks the agent for a short narrative of the same report,
in the theme's voice when that is on. The agent reads the report through its
`standup_report` tool and ends each sentence with the fact numbers it rests on; the
write-up is labelled as the agent's, the lines it names are marked in the report, and its
usage counts like any chat's.

## Toil's configuration

The Settings pages manage what `toil connections` and `toil dossiers` manage, by
running those commands through `@imagile-dev/toil/api`, never by editing a file:

- **Connections:** list, add, test, set the default, turn writes on or off,
  replace a secret (`toil connections login`) and remove. A secret goes from a
  password field to toil, which keeps it in the OS credential store; the page
  clears the field, and it is never logged, stored by Toil UI, or sent back.
  A note under the field says how many characters it holds and what trimming
  removes, never the value. The same paste checks as the CLI's run, in the
  CLI's words: a line break (or, for a token, a space) in the middle is
  refused, and quotes or a `Bearer ` / `token ` prefix ask Remove it or Keep
  it before anything is saved.
  Turning writes on asks you to type the connection's name, as the CLI does. A
  connection made by `TOIL_*` env vars alone is shown read-only, with where it
  came from.
- **Dossiers:** create one, add a repository, link an area, name a field, and
  show and check any of them. A dossier's name and description are edited in place
  on its card and dashboard, through `toil dossiers describe`. A link to a connection with writes on is refused
  here, as over MCP: make it on the CLI.
- **Bounds and time limit:** toil has no command for these, so they are shown
  read-only, with the file or env var that sets them.
- **Usage:** how toil is used on this machine, from `toil audit stats`, which
  reads only toil's local audit log: calls per day, the split between Toil UI, the
  CLI and MCP, the commands used most, the ones that fail most with their top
  error code and its usual fix (and, on request, their recent failures from
  `toil audit list`), and the commands nothing called. It needs a toil with
  `audit stats`, newer than 0.1.0-alpha.3; with an older one the page shows toil's
  error.

Every change is an explicit action, runs the command's own checks, and is in
toil's audit log as `caller: "toil-ui"`. The page can run no other command on this
path, and never a tracker write. Adding or changing connections needs a toil
newer than 0.1.0-alpha.2; with that one, use the CLI.

## Help and edit links

An **(i)** beside a term explains it in a sentence or two when you hover or focus
it, and pressing it opens the same words with a **Read more** link to the section
of these docs that says the rest. A **pencil** beside a configurable value (a
connection, a dossier's sources, people, field names or work-in-progress limit,
the agent, a usage cap) opens the settings page where it's set, at that value; it
only navigates. **Help** in the header is a menu with the docs for the view you're on
and **What's new** (below).

Where a screen uses an AI term (tokens and the context window under Agent usage,
model, harness and MCP under Agent, sandbox and permission mode in the Assign
dialog's modes, session and system prompt in Renew all stale, hallucination in the
chat's **About these answers**), its (i) popover also gives each term's first
sentence from Context Overflow's glossary, with **Read more on Context Overflow**.
Help's menu then has **Learn**: four of Context Overflow's modules, by task.
The agent's empty chat has the same **Learn**. **Links to learning content**, under
**Settings, General** and kept in this browser, is on by default; off, every link to
Context Overflow and every glossary line is gone, and Help keeps the view's docs and
What's new.

Read more, Help, Learn and What's new's changelog links open in a new tab, and are the
only places the app links out to: nothing is fetched until you follow one.
[Help and edit links](https://imagile-dev.github.io/toil/docs/ui-help/) has the rule
views follow.

### Empty panels

Every empty panel offers the one action that fills it, under one short line, with any
explanation in its (i): **Link a pipeline** and **Add an environment** (pencils to
Dossier setup at the dossier's sources) on the Board tab's builds and deployments, **Add
a repository** for pull requests, **Add a person** on the People tab, **Analyze now**
for an empty Analyses tab, **Show every item** for a Command Center filter that hides
everything, and **Sync now** in the local app wherever only a newer read of the tracker
fills the panel (the sprint, the burn-up, links between items). The site preview can't
sync, so it offers Dossier setup there instead. A test fails on any empty panel with
neither an action nor a link.

### What's new

After an upgrade, **Help** in the header carries a dot (and so does **Menu** on a narrow
screen, which holds Help), and Help's **What's new** lists what changed in toil and Toil
UI since this browser last saw them: three to five lines a version, features first, from
each package's release notes, with a link to its full changelog. The lines are read from
`CHANGELOG.md` and `ui/CHANGELOG.md` when Toil UI is built and bundled with it, so
nothing is fetched to show them. The versions this browser last saw are kept in
`localStorage`; a first visit records them and shows no dot, and opening the list takes
the dot away. Nothing pops up over the page.

## The command palette

**Ctrl+K** (**⌘K** on a Mac) opens the command palette from any page; on a narrow
screen it's **Search and commands** in the header's Menu. Type to narrow it down,
use the arrow keys to move, **Enter** to open and **Escape** to close. It's hidden
until you call it up.

- **Jump** to a dossier, any of a dossier's tabs (Overview, Board, Dependencies,
  Pull requests, People, Worklog, Analyses), a saved analysis, a settings page, or a
  theme.
- **Run** Sync now (where Toil UI keeps a cache), and on a dossier's page Ask (it
  focuses the Ask bar), Analyze, the agent that answers this chat, and Assign the
  item you were on to an agent: the board card that had focus, or the item whose
  page is open.
- Matching is fuzzy and ignores case: `pay12` finds `PAY-12`, and each word you
  type has to appear, in order. Results are grouped by kind, and the group with the
  best match comes first.

### Search across dossiers

With something typed, the palette searches the items of every dossier, by key and
title. Each result shows its dossier and status and opens the item. It reads only
what the last sync stored, never the tracker: opening it reads each dossier from
the cache the way its dashboard does. A result from a dossier last synced more than
a day ago, or whose last sync failed, says how old its copy is.

### Keyboard shortcuts

**?** opens a sheet listing every shortcut in Toil UI, anywhere but a text field;
it's also **Keyboard shortcuts** in the palette and the header's Menu. The sheet,
the palette and the views all read one table (`src/shortcuts.ts`), and a test fails
on a key a view checks any other way, so the sheet can't fall behind. On a board
card, **M** or the Menu key opens its menu, and **Space** picks it up to move with
the arrow keys.

## Feedback

The **Feedback** button in the header opens a dialog for a bug report or a feature
request: the kind, a title, the details and your email. It sends through
`toil feedback` (toil's `skills/toil/core.md`, **Feedback**), never on its own:

- **A live preview.** As you type, the page asks toil for the report it would send,
  read-only, and shows it exactly, with the endpoint. Nothing is sent to show it.
- **toil's disclaimer, and a checkbox.** The report goes to Imagile LLC, which files
  it as a public GitHub issue; your email stays private; you remove company data
  first. Send works only while the box is ticked, and any edit clears it, so you
  agree to the report on screen and no other.
- **Only what you typed.** toil adds its version and commit, nothing else: no
  dossier, connection, host or cached data.
- **The same lock as Settings.** `api/feedback` needs the session, the page's
  Origin and the CSRF token, takes the four fields and nothing else, and runs
  `toil feedback` and no other command. Your tick becomes the yes to the command's
  own consent question. With sample data it sends nothing. With a toil that has no
  `feedback` command (0.1.0-alpha.2), the dialog says so and points at the site's
  form.

## Sync and the cache

The dashboards read from a local cache, which a sync fills. Press **Sync now** in
the Sync panel at the foot of the page. The sync makes the same toil calls the
dashboards make, for every dossier, and stores the answers. The work items go
through toil's Open Work Item mapping, with their status changes and the pull
requests, builds and deployments that name them.

- **Incremental.** After the first sync, Jira and Azure DevOps searches, and a
  GitHub repository's issues, ask only for what changed since the last good sync (`updatedSince`, five minutes early in
  case the clocks disagree), and the GitHub board marks the issues whose
  `updatedAt` moved. Only those items and their histories are fetched again.
  Pull requests, builds, deployments and iterations have no "changed since" in
  toil, so they're read again each time, bounded as the dashboards bound them.
  Once a day, the Jira and Azure DevOps searches are also sent whole (ids only
  where toil can), and an item they no longer list is dropped; if that listing
  fails, the changes are kept and the next sync tries it again. Per-item calls
  (histories, pull request gets) run 4 at a time across a dossier.
  Azure DevOps histories come from the project's revisions feed, read from the
  watermark; an item is read on its own when the feed doesn't hold all of it.
- **Every page.** Each call follows `meta.page.nextCursor` to the end, up to 200
  pages, and fails that source, saying so, rather than keep part of a listing.
- **Each source on its own.** Each area a dossier reads (Jira, Bitbucket, Jenkins,
  OpenShift and so on) is a source with its own state. A source that fails shows
  toil's message and fix in the Sync panel, and keeps its last good data, marked
  stale. The other sources and dossiers aren't touched. The next sync asks it
  for everything since its last good sync, so nothing is missed.
- **When.** The line under the header says when the data was synced. The panel
  says when each dossier was synced, and shows a running sync's progress
  (requests, pages and retries, from toil's own progress events).
- **Where.** The cache is one SQLite file, `cache/toil-ui.db` in the data folder,
  through Node's built-in `node:sqlite`, so there's no native module. While Toil
  UI runs, its write-ahead log (`toil-ui.db-wal` and `toil-ui.db-shm`) sits beside
  it, and closing folds the log back into the file. It holds
  ticket content, so it stays on this machine and is readable by your account
  only. The analyses (#395) are kept in the same file, the newest 100 per dossier,
  and a sync never rewrites them.
- **For how long.** A dossier's synced data (responses, items,
  transitions, change refs, worklog facts and each source's state) expires together, once the
  last sync that saved data for it is older than the retention period (30 days by default),
  at start and after each sync. A sync that fails doesn't keep old data alive. Worklog facts that no
  sync produces any more go about 1.25 times the retention period after they were last seen. The rest
  goes when it is that old itself. The retention period
  also sets how far back closed Jira and Azure DevOps items are read, with a
  floor of 6 weeks (see What it reads). An analysis goes once
  it is older than the retention period, and with its dossier when toil no longer
  has it.
- **Wiping it.** **Wipe the cache** in the Sync panel deletes it after asking
  first. `toil-ui wipe` does the same from a terminal, once `toil-ui` has
  stopped: a running Toil UI holds `toil-ui.lock` in the data folder, and the
  command refuses while it does. Your trackers are never touched. The next sync fetches everything again.
- **Deleted tickets.** An item deleted in its tracker, or moved out of its
  project, is dropped within a day by the whole listing a Jira or Azure DevOps
  sync does once a day, since an incremental search only returns items that still
  exist. So is an item closed longer ago than the read window. A GitHub issue
  stays until the retention period ends or you wipe the cache.

The page can run only the reads the dashboards make: `dossiers list` and `dossiers
show`, and each area's search, history, pull request, build and deployment reads.
Any other command is refused before it reaches toil, and a change to a tracker is
never made from the page. The worklog's own calls are made by the server, never named
by the page: `toil audit list`, read-only, to see whether a proposal was applied, and
`toil util encode` for an export you asked for.

## The agent

Every dossier page has an **Ask bar** in its top row: one line, with **Analyze**
beside it. Pressing into it opens the **focused view**: the conversation takes the
screen and the page steps back, with a slim strip that keeps the dossier, its sprint
and the agent answering in sight. **Escape** or **Close** puts it away; the
conversation stays, for the rest of the dossier's pages, until you reload.

- **Starter questions** are a row of chips before the first question, then a
  **Suggestions** menu.
- **Answers stream in** as the agent writes them, under a **status line** that says
  what it is doing: reading the cache with `owi_query`, reading live through toil with
  `github issue list`, writing, and at the end how long it took. **Stop** cancels the
  question on the server and keeps what had arrived. Claude and Copilot stream as they
  write; Codex's SDK hands over its text a message at a time, so with Codex the status
  line is what moves between messages.
- **The wording follows the theme**: the bar's placeholder, the welcome and the status
  words are in each game theme's voice, and Plain stays neutral. The starter questions
  read the same in every theme.
- **Analyze** briefs the dossier in one press (#494). Its question comes from toil,
  `toil dossiers analyze prompt <dossier> --host toil-ui`: the standard method with
  the dossier's own lenses and focus (Tuning Analyze, above). It answers with a
  briefing block, which the server lifts out of the answer and checks, every id in it
  against what the agent's tools read: a recommendation, then the reasons, each item
  with why it's there and the next step, then what changed, and anything the
  dossier's focus left out. The briefing, the item drawer, the chat and the analysis
  page all lay it out, with the rest of the answer as **Evidence**, folded until you
  open it. An answer with no briefing block is shown as it came, and says so. With a
  toil that has no `dossiers analyze prompt`, Analyze asks Toil UI's own question
  instead, and the answer warns that it did. Each whole Analyze is kept in the
  dossier's **Analyses** tab, and the answer links to it.
- **Citations are chips**: in every answer, each `[[id]]` is a chip with the item's
  key, title and status, linking to its page (a pull request to its host). Hovering or
  focusing one shows its type, assignee, estimate, sprint and last update. An id the
  dossier doesn't hold stays the bare id, marked, and the server's check above the
  answer still names any id its tools never returned.
- **Each question carries the chat so far**: its last 8 questions and answers, each
  answer cut to 1,500 characters. An item an earlier answer named is still checked
  against what the tools return for the new question.
- **Switch agent from the chat.** The strip's switcher lists Claude, GitHub Copilot and
  Codex, each with its model and whether it can answer. A choice holds for this chat
  from its next question, which carries the conversation so far; the default stays in
  Settings. An adapter that can't answer is listed with the reason and **Install** or
  **Fix**, never left out. Each answer names the adapter and model that wrote it.
- **The chat remembers its agent for each dossier** (#494). A whole answer, Analyze or an
  ordinary question, records the agent it was asked of, in `<data folder>/dossier-agents.json` (an adapter name per
  dossier name, Toil UI's own state, never in the dossier file). The next time the chat
  opens on that dossier it starts on that agent if it can still answer, else on the
  default from Settings, Agent (Claude, GitHub Copilot or Codex), else the first agent
  that is ready, else as before, with the server trying the default and saying why it
  can't. A few words beside **Answered by** say which: "last used on this dossier",
  "your default", "your default can't run", "the first one ready" or
  "picked for this chat". Picking another agent and asking updates the memory; a question that names no
  agent, or an answer that fails, is stopped or comes back empty, doesn't. Renaming a dossier moves its
  memory, and a dossier toil no longer has is forgotten on the next full sync. The sample
  remembers nothing.

The chat answers with the agent your organization already approved, on the
subscription you already have. Toil UI has three adapters, each an optional peer
dependency that is loaded only when it answers:

| Adapter | Package | Starts | Signs in with |
|---|---|---|---|
| Claude | `@anthropic-ai/claude-agent-sdk` (and its peer `zod`) | `claude` (Claude Code) | Claude Code's own login, or Bedrock, Foundry or Vertex through Claude Code's environment switches |
| GitHub Copilot | `@github/copilot-sdk` | `copilot` (the Copilot CLI) | your Copilot seat, through the CLI |
| Codex | `@openai/codex-sdk` | `codex` (the Codex CLI) | the CLI's ChatGPT sign-in or its own API key setup |

Choose the default under **Settings, Agent**: the adapter, each adapter's model
(empty for its CLI's default), the CLI's path (empty to use the one on `PATH`) and,
for Claude, the endpoint. The choice is kept in `<data folder>/agent.json`, never in
toil's config, and has no field for a key: each SDK signs in the way its CLI does.

### Installing an adapter's SDK

**Settings, Agent** lists each adapter: whether its SDK is installed and at which
version against the one Toil UI was tested with, which CLI it would start, and
anything worth knowing. A missing SDK has an **Install** button, which shows the one
command it will run, word for word, before anything runs:

```bash
npm install --global --prefix <the prefix Toil UI is installed in> --ignore-scripts --before=<14 days ago> --no-audit --no-fund --omit=optional @openai/codex-sdk@0.160.0
```

Pressing **Install** runs it through the npm that came with your Node, with no shell and
your own npm config, so your organization's registry and proxy apply. npm's output
streams into the dialog, and Toil UI then loads the SDK to prove it installed; a
failure shows npm's own message and the fix. **Copy command** is beside it, for a
machine where you'd rather run it yourself. This is the one thing Toil UI runs npm
for (docs/decisions/343-ask-up-front.md).

- **Only the tested versions**: `@anthropic-ai/claude-agent-sdk@0.3.289` with
  `zod@4.6.5`, `@github/copilot-sdk@1.0.16` and `@openai/codex-sdk@0.160.0`, exactly
  (`ui/server/agents/tested.ts`). Nothing else is ever named, and `--before` holds
  everything npm resolves, the SDK's own dependencies included, to releases at least
  14 days old.
- **Where it goes depends on how Toil UI is installed.** Installed globally, the SDK
  is installed globally into the same prefix, read from where Toil UI is rather than
  from npm's config, so a global install under another prefix still lands beside it.
  Its optional dependencies, each SDK's own copy of its CLI, are left out: Toil UI
  never starts them. In a project's `node_modules`, it installs into the project with
  `--save-exact`. In a clone of this repository, it installs at the root with
  `--no-save`, naming the agent SDKs already there again, since an unsaved install
  removes the ones it doesn't name.
- **Run with `npx`, it can't install**: npx runs Toil UI from its cache, which npm
  clears when it likes, so there is no folder to install beside. The dialog says so;
  install Toil UI with `npm install -g @imagile-dev/toil-ui` and start it as `toil-ui`.
- **Not into Toil UI's own folder.** Its `package.json` lists the SDKs as optional
  peers, so npm reports them up to date there and installs nothing.
- **Claude's bundled CLI.** `@anthropic-ai/claude-agent-sdk`'s platform package is an
  optional dependency that npm sometimes skips. Toil UI doesn't need it, since it
  starts the `claude` it finds, and the status says so rather than fail.
- **Copilot on Windows.** npm installs the Copilot CLI as `copilot.cmd`, a shim no SDK
  can start without a shell. Copilot's SDK starts a `.js` CLI with Node itself, so
  Toil UI starts the script the shim runs (`node_modules\@github\copilot\npm-loader.js`
  beside it) and says so in the status. Claude Code and Codex install as `.exe` files.

- **Only the CLI already on this machine.** Toil UI finds it on `PATH` (skipping
  relative entries and the working directory) or at the path you set, which must
  name that CLI, hands that path to the SDK, and never downloads one.
- **An environment of its own.** The CLI gets only what it needs to run (paths, home
  and temp folders, proxy and CA settings) and its own sign-in variables. toil's
  `TOIL_*` variables, `GITHUB_TOKEN` and CI tokens never reach it. Not found is a plain
  error naming the CLI and the fix. On Windows a `.cmd` shim can't be started by the
  SDKs, so point at the `.exe` (Copilot's npm shim is the exception, above).
- **Read-only tools, one dossier.** The agent gets `owi_query`, `owi_get`,
  `owi_similar` (likely duplicates, scored as `toil util owi similar` scores them)
  and `owi_history` over the cache, `pr_query`, `pr_get` and `pr_metrics` over its
  pull requests (what each waits on, its flags, and flow figures by author kind with
  their sample sizes), `people_list` and `person_get` (each person's plate as the
  People view works it out, with the dossier read live through `dossiers show`, and
  told it describes load, never performance), `readiness_list` and
  `readiness_get` (each item's readiness verdict and its rows, as the Command Center
  works them out), `proposal_fields` (a write command's input fields,
  told it describes load, never performance), `worklog_day` (one day's worklog page,
  with what it can't vouch for), `standup_report` (a range of days as the Stand-up folds
  them, each line numbered), `proposal_fields` (a write command's input fields,
  from toil's registry), and `toil mcp`'s read tools for live lookups, called through
  toil's `execute()` with `readOnly: true`. The dossier is fixed to the one on screen.
  There is no write tool, and each SDK's own tools (shell, files, web, plugins, other
  MCP servers) are switched off.
- **Citations are checked.** Every answer cites the work items and pull requests it
  used as links.
  The server holds each id it names to what its tools returned, and flags any other
  as unverified above the answer.
- **Writes are proposals.** A change the agent suggests comes back as a card with the
  `toil … --allow-write` command line for you to run through toil's write gate. The
  agent can't run it.
- **Codex takes tools only from an MCP server**, so for the length of one question
  Toil UI serves them at `api/agent/mcp` on its own loopback port, behind a token made
  for that question. The token reaches Codex in its environment, never on its command
  line, and the endpoint refuses any request carrying a browser's `Origin`.
- **Codex runs in a Codex home of Toil UI's own**, `<data folder>/cache/codex`, not
  yours. Codex adds whatever its home's config names (MCP servers, profiles, plugins,
  hooks, skills) to what it's given, so with your own home your servers would start
  beside Toil UI's. Toil UI's home holds a `config.toml` it rewrites before every
  question, so `codex mcp list` there shows only `toil_ui`, and `auth.json`, a hard
  link to the one in your Codex home (`$CODEX_HOME`, else `~/.codex`). A hard link is
  the same file under a second name, not a copy: a token Codex refreshes is refreshed
  for both, and once you sign out of Codex the next question removes the link and says
  so. With no `auth.json` (a sign-in kept in the OS keyring, or none), `CODEX_API_KEY`
  in Toil UI's environment signs in instead. Your data folder and your Codex home must
  be on the same drive. `toil-ui wipe` deletes this home with the cache, along with
  Codex's record of Toil UI's questions, and leaves your own `auth.json` alone.

- **Your own instructions.** Under **Settings, Agent**, general instructions (for
  example "answer in British English") and a custom voice, each up to 4,000
  characters, kept in `agent.json` beside the adapter. They come after the rules in
  the prompt, and the rules win: they can't change the citations, the figures, the
  proposals or what the tools can do. **Show the full prompt** shows exactly what
  the agent is sent.

With no adapter chosen, the chat says so and names the three; its switcher can still
choose an installed one for that chat. `toil-ui --sample` keeps the scripted agent,
which answers its starter questions and Analyze from the sample data.

### Not ticketed yet

When you ask the chat for work that names no ticket (not a question, which ends in `?` or
opens with what, why, how and the like, and no key such as `PAY-12` or `#42`), a **Not ticketed yet** banner lists up to three of the
dossier's open items likeliest to cover it, scored as `toil util owi similar` scores
them, each with why. Attach the work to one by naming its key in your branch and
commits, which writes nothing, or press **Ticket this** for proposals: a sub-task
under each match, and a new ticket on the dossier's tracker. They are proposal cards
like the chat's others, with the command line to run through toil's write gate, and
nothing is created until you run one. With no match, it says there is no likely
ticket and offers only a new one. It asks once per chat, and **Not now** hides it.

### What the agent's models used

Each SDK reports what a question used, and Toil UI keeps that report, one record per
model call or running total, read only from the SDK's own events (no billing API is
called):

| Adapter | What the SDK reports | What Toil UI shows |
|---|---|---|
| Claude | each step's `usage` by message id, then the result's `modelUsage` per model and its `costUSD` | tokens (in, out, cache read, cache write) per model, and the dollar figure as the SDK's estimate; on a Claude plan (no API key, Anthropic's own API) it says "API-equivalent", since the plan isn't billed per token |
| Codex | `turn.completed`'s `usage`: input (which holds the cached input), cached input, cache writes, output | tokens; a dollar figure only from rates you enter, labelled "computed from your rates". The SDK names no model, so a Codex record names the model you chose, or says it wasn't named |
| GitHub Copilot | one `assistant.usage` event per model call, with `cost` as the premium-request multiplier, and `session.usage_info` for the context. Copilot bills the multiplier once per prompt: only the call the prompt started (`initiator` `user`) counts it, and the agent's follow-up calls in the tool loop count 0 | tokens and premium requests, never dollars; premium requests left from the SDK's experimental `account.getQuota`, marked experimental |

- **Under each answer**, one line per model: `2.1k in · 380 out · 14k cached · cache
  write not reported · ~$0.012 (SDK estimate)`. A figure the SDK didn't report reads
  "not reported", never 0.
- **In the chat's heading**, the chat's running total, split by model, and how full
  the last answer's context got, where the SDK says (Claude and Copilot; Codex's SDK
  doesn't).
- **Settings, Agent usage** (beside Usage, which counts toil's own commands): the last
  30 days by day, adapter, model and dossier, the chats that used the most, and an
  **Export as CSV** download made in the page.
- **One adding-up rule**, `addUp` in `src/model-usage.ts`, read by the server's caps,
  the footer, the heading and Settings: reports with one id are one report, merged to
  the highest of each figure (a running total), and different ids are summed.
- **The ledger** is the cache's `usage` table, apart from everything a sync writes: a
  sync's cleanup or a dossier leaving never lowers a total. It follows the cache's
  retention, `toil-ui wipe` clears it, and it is never sent anywhere.

**Caps** are optional and off until you turn one on, under Settings, Agent usage: a
per-chat and a per-day (UTC) cap for each adapter, in tokens, dollars (Claude's SDK
estimate, or Codex from your rates) or Copilot premium requests. At 80% the answer
says so; at 100% the question stops, naming the cap and how to raise it. Claude and
Copilot report each call as it happens, so their caps stop a run partway; Codex
reports when an answer ends, so its cap refuses the next question. They live in
`<data folder>/usage.json`, with the Codex rates. A value that doesn't parse is
refused, naming the setting, and while the file can't be read the agent answers
nothing, so a typo can never turn a cap off. A cap counts only what the SDK reports:
the vendor's own bill is the authority.

## Assigning work to an agent

From an item's page, or **Assign to an agent…** in its card's menu on the board
(right-click the card, long-press it, or press M while it has focus), a work item can be
assigned to Claude, GitHub Copilot or Codex in one of three modes. The agent works on
the subscription you already have, and nothing it proposes leaves this machine until
you apply it.

| Mode | What the agent does | What it can change |
|---|---|---|
| **Refine** | Checks for duplicates, drafts acceptance criteria, suggests an estimate, splits the item into children where it is too big, and asks its open questions | Nothing: every change is a proposal |
| **Investigate** | Reads the item, its parent, children, links, likely duplicates, pull requests and toil's live reads, and writes a report that cites each source | Nothing: the report is kept with the assignment, and posting it as a comment is a proposal |
| **Implement** | Works in a copy of the dossier repository's git folder that Toil UI makes in a folder of its own, fills it from the last commit, makes the branch `agent/<key>`, changes and tests the code, and stages the change | Only that clone, with no network. Committing, pushing and opening a pull request are proposals |

- **Refine and investigate** get the same read-only tools as the chat (`owi_*`, `pr_*`,
  `proposal_fields` and toil's live reads), with no shell and no file writes.
- **Implement runs on Codex only, for now.** Codex's own sandbox, `workspace-write`,
  holds the agent's commands and writes to the clone, with no network and none of the
  temp folders Codex adds by default, on Windows (its `unelevated` restricted-token sandbox), macOS and Linux. The clone is
  `<data folder>/cache/work/<assignment>/repo`, so `toil-ui wipe` deletes it; before any git runs there outside the sandbox, Toil UI rewrites its git config and removes its hooks. The dossier's
  repository needs a local path (`toil dossiers add-repo <dossier> <folder>`). The agent stages its change and never commits, pushes or fetches; the
  staged diff is shown through toil's own `git status` and `git diff`, and the commit
  and push are a proposal of the exact git lines to run, since toil has no command
  that pushes.
- **States**: `queued` (waiting for a free slot, or for a person to press Start),
  `working`, `needs you` (proposals or questions to review, or an item the agent
  thought was trying to instruct it), `done` and `failed`. The **Agents** sidebar beside
  every dossier tab shows each assignment's state, mode, adapter, run time and what it
  used, and the People view shows each agent's assignments.
- **From the Command Center**, "Start every ready item" assigns each slated item in
  implement mode, in order, on Codex (or the adapter chosen in Settings, when it can
  implement), in the dossier's one repository with a local path, and says what it
  queued or why it started nothing.
- **The tracker only queues.** An item labelled `agent:refine`, `agent:investigate` or
  `agent:implement`, or assigned to one of the dossier's agents (its `people` with
  `kind: agent`, which queues a refine), appears in the **Agent inbox** on the next
  read. It runs only when a person presses Start.
- **Applying a proposal** runs its toil command, the one the server stored when the
  run ended, through toil's write gate: the connection needs `writes: true`, and your
  press of Apply is the call's `--allow-write`. Each call toil makes for an assignment
  is in toil's audit log with `caller: "toil-ui"` and `actor: "assignment-<id>"`.
- **Tracker text is untrusted.** The item is fenced off in the prompt as data, and an
  item that tells the agent to do anything else stops the run, marked `needs you`.
- **Limits.** One assignment runs at a time and each has 20 minutes, both changeable
  in the sidebar's **Limits** (1 to 3 at once, 1 to 240 minutes), kept in
  `<data folder>/assignments.json`. An assignment is one chat to the usage caps under
  **Settings, Agent usage**, so a per-chat cap is a per-assignment cap. Either limit
  stops a run cleanly, saying which.
- **The transcript** keeps the prompts, every tool call, the agent's text, the
  commands and file changes Codex reports, and each proposal and what came of it.
  Each assignment also records what it started on: the toil and Toil UI versions, the
  adapter and model, the tools, and SHA-256 fingerprints of the dossier, the item and
  the prompt, and the install fingerprint a later look holds it to (Stale sessions, below). Assignments are kept under the cache, in
  `<data folder>/cache/assignments/`, so a wipe deletes them.
- **For programs on the same server**, `api/assignments` lists, assigns, starts,
  stops, applies, dismisses and renews, and `api/assignments/events?since=<n>` streams every
  change of state as NDJSON.

## Stale sessions

An agent works from the instructions it got when it started. Upgrade toil, edit the
dossier or change your instructions under **Settings, Agent**, and the chats and
assignments already going are still on the old ones. Toil UI records what each one
started on, says which have gone stale and why, and renews them on request.

- **What it records.** Each chat at its first question, and each assignment when its
  run starts, keeps an install fingerprint: toil's and Toil UI's version and commit,
  one SHA-256 per toil area of the tools the agent was handed (Toil UI loads no skill
  page, so those tools are the toil instructions its agent reads), SHA-256 of the
  dossier as `toil dossiers show` reads it, and SHA-256 of the prompts (the system
  prompt, the starters or the mode's task, and your own instructions and voice). The
  theme on screen isn't part of it. An assignment recorded before this has none, and
  is never called stale.
- **When it's stale.** Every answer, every read of the Agents sidebar and every
  assignment page compares what the session started on with the current fingerprint,
  whose builds are the ones on disk, read again only when their files change. The
  reason names what moved: "started on toil 0.1.0-alpha.3 · now alpha.4 · skills
  changed: github · dossier changed". A session's earlier turns aren't marked; only
  the instructions it started on are.
- **Where it shows.** A **Stale** badge with the reason on the chat (in the Ask bar and
  the focused view), on each assignment in the Agents sidebar and on its page, and on the
  agent's card in the People view. A done assignment is closed and isn't marked.
- **Renew.** On the chat, **Renew** in the focused view records what it starts on now;
  the conversation stays, and the next question carries it as every question does. The
  chat's usage total carries on, so renewing never resets a cap. On a stale assignment
  that has failed, **Renew** queues a fresh one on the same item, mode, adapter and
  repository, whose prompt carries what the old run left, fenced as data; the old one
  stays readable, marked as renewed. Renew never interrupts a turn: a chat that is
  answering and a working assignment wait, and an assignment that needs you is
  skipped until you've reviewed it.
- **Renew all stale**, in the Agents sidebar, lists every stale session of the dossier
  first, the chat included, each saying whether it renews or why it's skipped, and
  renews the rest with one press.
- **The server itself.** When toil or Toil UI on disk is newer than the running
  server, the header says so, with the command that starts it again. A session renewed
  then would start on the old build and be stale at once, so until it restarts, Renew
  is refused (and Renew all stale skips every session), saying so with that command.

## Notifications

Toil UI tells you when an agent's state changes, and stays quiet otherwise. A tool
call, its progress, or a state that didn't change never notifies.

- **What notifies:** an assignment reaching **needs you** (with why: "asked a
  question", "3 proposals to review"), **done** or **failed**, one stopped at its
  **usage cap**, and a chat or assignment gone **stale** (Stale sessions, above). A
  run going from queued to working says nothing, and neither does your own Stop.
- **Once, together.** Changes within four seconds become one notice: "2 agents need
  you", each line linking to its assignment. A change undone inside those seconds,
  such as a question answered elsewhere, sends nothing.
- **Where.** A notice under the header, with Dismiss. While the tab is hidden its
  title counts them, `(2) Toil UI`, until you come back. With **Browser
  notifications** on, the browser's own notification shows them too, drawn on this
  computer: nothing leaves the machine. The browser is asked for permission only when
  you turn that on, never before.
- **Settings**, under **Settings, General**, kept in this browser: a switch for each
  kind (**needs you**, **failed** and the usage cap on, **done** off, **stale** on, by
  default), **only for agents I started** (the chats in this browser and the
  assignments assigned, started or renewed here), and quiet hours, which hold every
  notice while the title still counts.
- **Plain words.** Notices read the same in every theme: the theme's wording stays in
  the views.
- **Where it listens.** The server's `api/assignments/events?since=latest` stream,
  which carries what a notice says with each event, and a minute's read of the
  dossier on screen for sessions gone stale.

### Notification history

The **bell** in the header (beside **Menu** on a narrow screen) counts the unread and
opens the last 50 things worth telling you, newest first: each change a notice carried
(needs you, done, failed, stopped at a usage cap, gone stale), each sync's result, from
the Sync panel, with the dossier that failed, and when each happened. Every entry links
to what it's about: the assignment, the dossier, or the Dossiers view. **Mark all read**
clears the count and keeps the entries. The bell keeps a change that quiet hours held
back, and one whose notice you dismissed; which changes reach it is the notification
settings' choice. It's kept in this browser's `localStorage`, shared by its tabs (with one
entry for each event, however many tabs saw it), and sent nowhere. Notices follow the rules above unchanged, and a theme's moments play from
the worklog's facts, never from the bell.

## Themes

Eight built-in themes: Plain, Crate (the default), Harvest, Starship, Realm, Sprawl,
Frontier and Overworld. Pick
one from the header, or under **Settings, General**, where two checkboxes say how far
it goes, both on by default:

- **Themed wording:** the theme's own lede, eyebrows, dashboard notes, empty
  states and loading lines, and its names for a sprint, a board or an epic beside
  the real ones ("Campaign (Epic)"). Buttons, links, figures, ids, commands and errors
  read the same in every theme.
- **Themed agent voice:** the agent answers in the theme's register, a terse
  dockworker in Crate, a patient farmhand in Harvest, a ship's log in Starship, a
  dungeon master in Realm, a laconic netrunner in Sprawl, a dry telegraph operator
  in Frontier, an old sage in a cave in Overworld. It changes phrasing only.

Every theme has a light and a dark scheme. **Appearance**, in Settings, General or the
command palette, picks one; System, the default, follows your operating system.

A theme with particles also gets **Particles and ambient effects**, kept for each
theme on its own: off, that theme's particles are gone entirely, while its other
motion keeps following **Reduce motion and effects** (and the operating system's
reduced-motion setting, which stops everything).

Crate, Harvest, Starship, Realm, Sprawl, Frontier and Overworld also have **theme moments**: a launch splash while the first read
runs, their own loading screens with the real progress and a rotating line of their own,
an entrance as a dossier opens, a transition between its tabs, and a short moment when a
sync brings an item done, a build passed or failed, a blocker cleared, a pull request
merged, or a sprint's end. **Theme motion**, under Settings, General, plays them in full,
subtly or not at all, and is off whenever reduced motion is asked for. Every loading
screen also carries a **toil tip**, one line with a Read more link, which **Toil tips on
loading screens** turns off. Waits under 300 ms show no loading screen at all.

Plain has neither wording nor voice, so both are off while it's chosen. It sets
headings and figures in Fredoka, toil's wordmark face, on IBM Plex Sans. The theme
is toil's own setting too (`toil theme set`, `TOIL_THEME` over it), which the welcome
menu follows: a pick here writes it, and Toil UI opens in it, except in a browser that
had a theme saved before the setting, which keeps it until the next pick. The other
choices are kept in this browser. Toil UI doesn't install themes from anywhere else: to ask for one, send a
feature request from **Feedback** or with `toil feedback feature`. A `themes/` folder
left in the data folder by an earlier alpha is not read, and Toil UI says so when it
starts. [Themes](https://imagile-dev.github.io/toil/docs/themes/) has the whole
story, the composed prompt included.

## The lock on the door

Any program on the machine, or a web page using DNS rebinding, can reach a local
port, so the server lets in only the browser holding this launch's token:

- **The token.** A random token per start, in the URL it prints. The page trades it
  for a session id, which the tab keeps in `sessionStorage` (see Start it) and
  sends as a header on every API call. Nothing is kept in a cookie: a browser would send one to any other server
  on `127.0.0.1`, whatever its port.
- **The Host header.** Only the exact `127.0.0.1:<port>` it printed is answered.
- **No CORS.** No `Access-Control-*` header is ever sent. Every POST also needs the
  page's own `Origin`, a JSON body, and the session's CSRF token.
- **No network but toil's.** It talks to the hosts in your toil connections, and
  nothing else, apart from a feedback report you send, which toil sends to Imagile. The agent CLI you choose talks to its own model endpoint.

## Run against a real repository

From a clone, one command starts Toil UI on a real GitHub repository, in a home
folder of its own (`.scratch/home` in the clone, ignored by git), so your own
`~/.toil` and `~/.toil-ui` are never read or written:

```bash
npm ci --ignore-scripts
npm run build -w ui
node ui/scripts/dev-real.mjs
```

It works the same in PowerShell, Git Bash and a macOS or Linux shell. It needs the
GitHub CLI signed in (`gh auth login`), or `TOIL_GITHUB_TOKEN` set in the shell.

- **toil's config**, written once: one connection, `github`, to
  `https://api.github.com`, with writes off and no token in the file.
- **The token** comes from `gh auth token` each time it starts and goes only into
  Toil UI's environment, as `TOIL_GITHUB_TOKEN`. It's never written to a file or
  printed. `GITHUB_TOKEN` and other `TOIL_*` variables in your shell are left out.
- **The dossiers**, made with `toil dossiers init` and `link` and checked with
  `toil dossiers check`: one for `--repo`, and `toil-self` for the public
  `imagile-dev/toil` unless `--no-self`. `--repo` defaults to
  `imagile-dev/toil-sandbox` (as `sandbox`), which is private to Imagile's
  maintainers; anyone else passes their own repository, or seeds a sandbox of their
  own (below).
- **toil from this checkout.** Each start builds toil from the clone into
  `.scratch/toil` (`npm run build` with `TOIL_BUILD_DIR`, a few seconds), and both the
  dossier setup and Toil UI run on that build, not on the published toil
  `ui/package.json` pins. Toil UI is started with `node --import
  ui/scripts/local-toil-hook.mjs`, which resolves `@imagile-dev/toil/api` to
  `.scratch/toil/api.js` and says so on stderr. So a command `ui/` calls before its
  release works here. The committed `dist/` and `node_modules` are left alone, and a
  plain `node ui/dist/server/toil-ui.js` still runs on the pinned toil.
- **Then** it starts `ui/dist/server/toil-ui.js` on loopback and prints its URL.
  Press **Sync now**, then open a dossier. `--port <n>` fixes the port, and
  `--home <dir>` uses another folder.
- **Ask with Codex.** Install the SDK in the clone without saving it
  (`npm install --no-save --ignore-scripts @openai/codex-sdk@0.160.0`), then choose
  Codex under **Settings, Agent**. The script points `CODEX_HOME` at your real
  `~/.codex`, which is where Toil UI finds the `auth.json` it links into its own
  Codex home.
- **Ask with GitHub Copilot, on a cheap model.** Install `@github/copilot-sdk@1.0.16`
  the same way (or press **Install** under **Settings, Agent**). The Copilot CLI found
  its own sign-in from the scratch home in our runs; if it says it isn't signed in, run
  `copilot` once on its own. Then pick the model: Copilot lists the models your
  account can use, each with its premium-request multiplier (`/model` in the CLI, or
  the SDK's `listModels()`). Choose the lowest, ideally one at 0×; otherwise the
  cheapest multiplier, such as `mai-code-1.1-flash` at 0.25×, never a premium model.
  Type its id as Copilot's model under **Settings, Agent**, and check the model each
  answer names and the premium requests under it.
- **Ask with Claude, on Haiku.** Install `@anthropic-ai/claude-agent-sdk@0.3.289` and
  `zod@4.6.5` the same way, and type `haiku` (or `claude-haiku-5-5`) as Claude's
  model under **Settings, Agent**; empty would be Claude Code's own default, which
  may be Opus. Claude Code keeps its sign-in in `~/.claude`, which the scratch home
  hides, and refreshing it from there would rewrite your credentials file, so the
  script only reads it: a `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` in the
  shell goes through as it is, and otherwise the access token in
  `~/.claude/.credentials.json` goes into Toil UI's environment as
  `CLAUDE_CODE_OAUTH_TOKEN` while it has ten minutes left. When it has expired the
  script says so: run `claude` once in a terminal, which refreshes its own sign-in,
  or set a token from `claude setup-token`, and start the script again.

To run the same build against your own `~/.toil` instead (your connections and
dossiers as they are, changed only by what you save in Settings, with Toil UI's own
data in `.scratch/toil-ui`), run `node ui/scripts/dev-mine.mjs`.
That's the way to try unreleased changes on real work (`skills/toil/install.md`,
Trying unreleased changes).

## Verify before you open a PR: `npm run verify:ui`

One command checks Toil UI the way a reviewer would, and writes what it found to
`ui/.verify/report.md` with screenshots beside it (git ignores the folder). Run it
from the root or from `ui/`, and paste the report's table into the PR.

```bash
npm run verify:ui                 # build, sample data, real data
npm run verify:ui -- --ask        # and one Codex question
npm run verify:ui -- --ask --adapter copilot --model mai-code-1.1-flash   # or --adapter claude --model haiku
npm run verify:ui -- --no-build --starter standup
```

- **It builds Toil UI and toil**, unless `--no-build`: toil from this checkout into
  `.scratch/toil`, which Toil UI runs on, as `dev-real.mjs` does (above). The report's
  header and its **Toil** row name that toil: its version, the commit it was built
  at, and whether `src/` had uncommitted changes. The run fails if Toil UI didn't
  resolve `@imagile-dev/toil/api` to it. It also confirms that the toil `npm ci`
  installs is the one `ui/package.json` pins (`npm run check:lockfile -w ui`), which
  is what the published package runs on.
- **Sample data:** `toil-ui --sample` in a throwaway home, every view through the
  layout check (`scripts/layout-check.mjs`) in every theme and scheme at 375, 768 and
  1440px. On each dossier's dashboard it also drags a board card to the next column
  with real input, a mouse and at 375px a finger, and fails when the card doesn't
  follow the pointer or the dropped move doesn't show in the target column. It needs
  only a browser, so it runs anywhere, CI included.
- **First run:** `toil-ui` on an empty home, with no connections, no dossiers and no
  `TOIL_*` variable from your shell, through the same check: its Dossiers view must
  show the three-step checklist, and the palette and the shortcuts sheet open over it.
- **Real data:** the home `dev-real.mjs` sets up, made fresh at
  `.scratch/verify/home`, on `imagile-dev/toil-sandbox` with the token from `gh auth
  token` in Toil UI's environment only. It syncs the `sandbox` dossier and runs the
  same check over the home page, the dossier and its Board and Dependencies tabs, its worklog and stand-up, one of its items and the settings pages,
  except that its header may fold into the Menu at 1440px, since a real dossier's name
  and links can genuinely fill the row.
  Without a GitHub sign-in it skips this part and says so; nothing else depends on it.
- **`--ask`** asks Codex one starter question (`hygiene` unless `--starter <id>`) and
  checks that an answer arrived, that the server verified every `[[id]]` it cites,
  that its proposals parsed, that nothing ran (no write in toil's audit log for the
  run), and that `codex mcp list` in Toil UI's Codex home shows only `toil_ui`. Then it
  asks Analyze as the chat's second question, and checks the history of analyses
  (#395): that Analyze was kept with its briefing (a recommendation, and its first
  three reasons as the history's issues); then it changes the dossier's WIP limit in the scratch home (`toil dossiers
  wip-limit --replace`), asks Analyze again, checks the history lists both, newest
  first, the second compared with the first, and puts the Overview, the Analyses tab
  and the second analysis opened through the layout check, shot. It needs the Codex CLI signed in and the
  SDK installed in the clone (above). `--adapter copilot` or `--adapter claude` asks that
  adapter instead, held to the same checks (Codex is the reference; its MCP check is
  skipped), and `--model <id>` sets its model and fails the run when an answer or a
  usage record names another one, so a cheap-model run can't quietly use a dear one. Each adapter's full live run, every agent feature on the sandbox, is
  recorded in `ui/docs/live-runs/`.
- **What fails it:** any layout problem in any theme, and any axe violation at WCAG
  2.2 AA in Plain and Crate. Axe findings in the other themes are listed in the report
  and never fail it. Screenshots are of Plain and Crate.
- **It stops** every server and browser it started, and exits 1 on any problem.

`--source ado` runs the real-data part against an Azure DevOps Services board
instead (the `ado-board` dossier, as `dev-real.mjs --source ado` makes it below),
with `TOIL_ADO_BASE_URL`, `TOIL_ADO_PAT` and `--project <name>` (else
`TOIL_ADO_PROJECT`); without them it skips that part and says why. Each source is
one entry in `SOURCES` in `scripts/verify.mjs`. Set `CHROME_PATH` if the browser it finds doesn't draw headless; Playwright's
Chromium works where an installed Chrome doesn't.

### The sandbox repository

`imagile-dev/toil-sandbox` is a private repository of made-up work for trying
this, and the seed below makes the same in a repository of yours: labels for type, priority, points and blocked; three milestones as sprints
(41 closed, 42 current, 43 next); 25 issues, open and closed, some assigned, some
blocked by others, a few unestimated, one with a very long title; a workflow that
only echoes, with one branch that fails on purpose; four pull requests that
close issues (merged, open, draft, and one with a failing build); and comment
reviews on two of them. GitHub won't let a pull request's author approve it or be
asked to review it, so review requests are seeded only when the repository has a
second collaborator to ask; with one, the seed says it skipped them.

```bash
gh repo create <owner>/toil-sandbox --private --add-readme
node ui/scripts/seed-sandbox.mjs --owner <owner> --repo toil-sandbox
```

The seed writes through the GitHub CLI's own login, never through toil, and is
safe to run again: what exists is found by name or title and left alone. To start
over, delete the repository (`gh repo delete <owner>/toil-sandbox`, which needs the
`delete_repo` scope), create it again and re-run the seed. It adds no Projects
board, which needs the `project` scope on the token, and no deployments, which
toil's `github` area doesn't read.

### An Azure DevOps Services board

`--source ado` runs the same way against an Azure DevOps Services project, through
toil's `ado` area on a Services connection, with a dossier named `ado-board`:

```bash
node ui/scripts/dev-real.mjs --source ado --project "<project>"
```

It needs `TOIL_ADO_BASE_URL` (`https://dev.azure.com/<organization>`) and
`TOIL_ADO_PAT` (an organization-scoped token with Work Items, Read) in the
shell. They go into Toil UI's environment only: toil makes its `ado` (deployment cloud)
connection from them, with writes off, and nothing about the organization is
written to the config file. `--project`, or `TOIL_ADO_PROJECT`, names the
project; the dossier in the scratch home holds it. The dossier names no repository,
so no pull requests are read; add `repo` to its `ado` section for them.

To fill a board with made-up work, `ui/scripts/ado-seed/` seeds one from Open Work
Items. `items.owi.json` holds 45 of them across the three sample products
(`card-payments`, `settlement`, `checkout-web`): Scrum epics, features, backlog
items, tasks and bugs, in a mix of states, in Sprints 1 to 3 and the backlog, with
efforts (some missing), acceptance criteria (some missing), parents, dependencies,
related pairs, long titles and two stale items. It's written by a seeded generator,
so the same seed always gives the same file:

```bash
node ui/scripts/ado-seed/generate.mjs                                   # writes items.owi.json, checked against docs/owi/schema.json
node ui/scripts/ado-seed/apply.mjs --project "<project>" --dry-run      # what it would create; sends no write
node ui/scripts/ado-seed/apply.mjs --project "<project>"                # creates what's missing
node ui/scripts/ado-seed/cleanup.mjs --project "<project>"              # lists the seeded items, deletes nothing
node ui/scripts/ado-seed/cleanup.mjs --project "<project>" --confirm <code>   # sends exactly that list to the recycle bin
```

The scripts read the same two variables, create and change work items only, in
sprints that already exist (a missing sprint stops the run; none is ever created),
and touch only items tagged `toil-seed` with one `seed:<key>` tag. Every item gets
both. Running `apply.mjs` again creates only what's missing. Each item's history is
backdated to its timeline when the token's identity may bypass rules, and seeded with
ordinary transitions dated today when not, which the run says. `cleanup.mjs` deletes
only after a dry run has listed the items: the code it prints is made from their ids,
and `--confirm` refuses a code for any other list. Deleted items can be restored from
the project's recycle bin. To start over, clean up and apply again.

To check what toil reads back, map the board's output and compare it with the file:
`compare.mjs` matches each item to its record by its `seed:` tag and prints every
difference, leaving out what the server assigns.

```bash
toil ado work-item iterations --project "<project>" > board.jsonl
toil ado work-item get-many <ids…> >> board.jsonl
toil ado work-item history <id> >> board.jsonl        # once for each id
toil util owi map board.jsonl > mapped.json
node ui/scripts/ado-seed/compare.mjs mapped.json --project "<project>" --backdated
```

## Measuring theme moments

Two more commands are for a PR that changes a theme's moments ([Theme
moments](https://imagile-dev.github.io/toil/docs/themes/#theme-moments)) or the engine that
plays them. Both build Toil UI first (`--no-build` skips it), run `toil-ui --sample` in a
throwaway home, drive headless Chrome (the one the layout check finds; `CHROME_PATH` picks
another), and write to `ui/.moments/`, which git ignores.

```bash
npm run moments:measure -w ui                       # every theme with moments, 3 runs each
npm run moments:measure -w ui -- --theme realm --cold
npm run screens:sheet -w ui                         # every theme, 375 and 1440px, full, subtle and off
npm run screens:sheet -w ui -- --theme realm --width 768 --motion full
```

- **`moments:measure`** times each theme's launch splash, loading screen and sprint recap at
  1440px with GPU compositing on. A `requestAnimationFrame` recorder gives the frame times
  (Sprawl's rain and Realm's embers draw at 30 fps by design, which raw presented-frame gaps
  would misread), and Chrome's frame reporter the frames it dropped. Each run opens a fresh
  browser per theme and plays it twice: the first pass is Chrome compiling its GPU shaders,
  which a person sees at most once per browser version, and the second is the figure. It
  prints a table, each cell the median frame, the worst frame, the frames over 20 ms and the
  frames Chrome dropped over every run, and writes it to `ui/.moments/measure.md` with the
  raw results in `measure.json` beside it. It exits 1 when any frame is over 20 ms or a phase
  didn't play. `--report-only` prints the same and exits 0; `--cold` adds the first pass's
  worst frames; `--runs <n>` (default 3), `--motion subtle`, `--throttle <rate>` (a slower
  CPU) and `--no-gpu` (software rendering) change the run. It takes about two minutes a
  theme.
- **`screens:sheet`** makes one contact sheet for each theme, width and Theme motion level,
  `ui/.moments/sheets/<theme>-<width>-<motion>.png`, ready to attach to the PR, with its
  frames and an HTML copy in a folder beside it. A sheet shows the splash arriving, held and
  handing over; the loading screen as its loops turn; each event moment the theme declares
  coming in, held and going out, cropped to the card; the dossier entrance; and a change of
  tab. Every frame is a still: the engine's animations are caught paused as they start and
  stepped by hand, so a sheet is the same on every run. `--width` and `--motion` repeat, and
  replace the defaults.

**Run them on a quiet machine, with nothing else running**: no build, no other test run, no
video call. A frame time measures the machine as much as the page, so a busy machine's slow
frames aren't the theme's. `moments:measure` reads the CPU before it starts, says so when the
machine is already more than 15% busy, and puts both readings, before and during, at the top of
its table. For the same reason neither command runs in CI, and neither is part of
`npm run verify:ui`. Put the table and the sheets in the PR, with the load the run saw.

## Settings

| Setting | Flag | Env var | Default |
|---|---|---|---|
| Bind address | `--host` | `TOIL_UI_HOST` | `127.0.0.1` (`::1` is the other choice) |
| Port | `--port` | `TOIL_UI_PORT` | `0`: the OS picks a free one |
| Base path | `--base-path` | `TOIL_UI_BASE_PATH` | `/` |
| Data folder | `--data-dir` | `TOIL_UI_DATA_DIR` | `~/.toil-ui` |
| Retention | `--retention-days` | `TOIL_UI_RETENTION_DAYS` | `30` (1 to 3650); also how far back closed Jira and Azure DevOps items are read, at least 42 days |

A flag beats its env var. Any bind address other than loopback is refused in this
release. The data folder is Toil UI's own, apart from toil's `~/.toil/`, and holds
the cache, `agent.json` and `usage.json`. A `~` at the start of `TOIL_UI_DATA_DIR` means your home folder, on
Windows too.

## Not in this beta

- **Serving other machines.** It is local only.
- **Implement mode on Claude or Copilot**, and **answering an agent's questions in the assignment** itself: answer on the item and assign it again.

## The package

`@imagile-dev/toil-ui` ships the server (`dist/server/toil-ui.js`) and the built app
(`dist/app/`), and nothing else. It has no install scripts and no native addons,
spawns no program of its own but npm, for Install alone (an agent SDK you install starts its CLI), and its
front end's framework is built in rather than installed. The agent SDKs are
optional peer dependencies: none is installed with it.

Apache-2.0. See `NOTICE` for what the app bundles.
