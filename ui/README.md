# Toil UI

A local web app for seeing work across Jira, Azure DevOps and GitHub, read through
[toil](https://www.npmjs.com/package/@imagile-dev/toil): one dashboard per Toil project,
with its stories, pull requests, builds and deployments side by side, a pull
requests view for what is waiting on review, and a daily worklog of what happened.

**Status: beta, local only.** It runs on your own machine, binds loopback, and
reads through toil with your own connections and Toil projects, read-only. Its
settings pages, and a Toil project's name and description edited in place, are the only
places it changes anything of toil's, and only toil's own connections and Toil projects. The worklog keeps its pages and the notes you add in its own
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
Syncing through toil, read-only, with your own connections and Toil projects. Only its Settings pages, and a Toil project's name and description edited in place, change anything: toil's own connections and toilProjects, when you ask. The worklog keeps its pages and your notes in its data folder, and writes anywhere else only when you export one. Feedback goes to Imagile only when you send it.
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

`toil-ui --sample` serves the sample Toil projects and the scripted agent that
[the site's Toil UI page](https://imagile-dev.github.io/toil/ui/) runs on, with
nothing connected to a tracker.

## First run

Until you have a Toil project and it has synced once, the Toil projects view shows a short
checklist in place of the empty page:

1. **Connect a tracker** opens Settings, Connections at the add form. If an agent following the toil skill's `setup.md` already created the connection, you only enter its secret here, on its row.
2. **Create a Toil project** opens Settings, Toil projects at Create a Toil project.
3. **Sync** starts the first sync, as the Sync panel's Sync now does.

Each step ticks itself off from toil's own state: `toil connections list` for a
connection to Jira, Azure DevOps or GitHub (one made by env vars counts), `toil
projects list` for a Toil project, and the Sync panel for the sync. Beside the steps,
**Try the sample data** shows `npx @imagile-dev/toil-ui --sample` with a Copy
button, to restart Toil UI on the sample Toil projects. The checklist goes once the first
sync finishes. Each step's (i) explains it and links to these docs.

## What it reads

Each dashboard reads its Toil project the way `toil projects show` describes it: the
Jira project, the Azure DevOps project and pipelines, the GitHub repositories and
project board, and the OpenShift namespace of each environment. A Toil project's GitHub
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
requests are read from every code host the Toil project names (GitHub, Bitbucket Data
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

## Plain words

Screens read in everyday words by default: a pull request is a **code review**, an agent an **AI helper**, with toil's own term in the hover. Facts, numbers, commands and errors read the same either way. **Settings, General** (and the command palette) turn it off, kept in this browser; `?words=standard` in the address does too. Themed wording and themed agent voice are off until chosen.

The tabs read **Summary**, **Board**, **What blocks what** (Dependencies), **Code reviews**, **People**, **What happened** (Worklog) and **Past briefings** (Analyses); Analyze is **Get a briefing**. A panel's source reads "From Jira and GitHub", with the commands one step in. **Settings → General** has a **Plain words** switch with an (i), and the command palette has **Use plain words** / **Use toil's own terms**. Quoted titles, the tracker's words and a briefing's own sentences are never reworded.

## The Toil projects view

Toil UI opens on its Toil projects, one card each, read from the same data the dashboards
read, so it asks no tracker anything: in the local app that is the cache a sync
filled, plus `projects list` and `projects show` for the Toil projects themselves.

- **What each card shows:** the current sprint with its working days left, points
  done and a small burn-up; how many items are in progress and blocked, and how many
  pull requests wait on a review; the people with work in it, as avatars; its sources
  as badges; when it was last synced; and how many work items and pull requests
  changed since this browser last opened its dashboard.
- **Which card leads:** the Toil project opened most recently in this browser, or, before
  any was opened, the one with the most in motion (in progress, blocked and waiting on
  review together), takes two columns where they fit. On a wide screen the grid goes
  wider than the dashboards and fits more cards across; at 375px it is one column.
- **What this browser remembers:** when each dashboard was last opened, in
  `localStorage`, never sent anywhere. Without it (a private window) the cards just
  say nothing about "since".
- **A Toil project's top row** uses the same parts: the description beside the name, the
  sources as badges, and the sprint's day (The Toil project page, below).

### Renaming and describing a Toil project

The name and the description have a pencil beside them, on the card and in the
Toil project's top row. It opens an inline field: Enter saves through
`toil projects describe <toilProject> --name <new name>` or `--description <text>`, run
on the settings pages' path (below), so toil's own checks apply and the change is in
its audit log as `caller: "toil-ui"`. Escape cancels, and a refusal shows toil's
message and fix under the field. Only a Toil project in your own folder can be renamed or
described; a checked-in one is refused with the `toil projects import` fix.

A rename keeps everything Toil UI holds for the Toil project: the server moves its cache
(responses, items, history, sources, sync runs, notes and agent runs), its assignments
and its worklog pages to the new name once toil has renamed the file, so its
dashboard opens straight away with no new sync. A rename waits, refused with a
message, while a sync or an assignment of that Toil project is running, since both read it
by name as they go. What can't be moved is said beside toil's result, and the next
sync reads the Toil project afresh under its new name.

## The Toil project page

A Toil project opens on its **Overview**, the briefing, in a frame all of its pages share:

- **The top row:** on the Overview, a **Diagram** link (`#/project/<name>/job/diagram`) draws the Toil project's repositories as a C4 diagram in Mermaid; the steps that need a folder on disk (`util size`, `git log`, `deps scan`) are reported unchecked. Its name, with the pencil that renames it; **Switch**, for another
  Toil project or the Toil projects view; the sprint and its day; its description, cut to one
  line with the whole of it in its tooltip, and its sources (on a phone, a **Details** button beside the name opens them); and the Ask bar, with the
  **AI helpers** button beside it (The agent, below).
- **The tabs**, one address each: **Overview** (`#/project/<name>`), **Board**
  (`/board`, with how many of its cards need attention), **Dependencies**
  (`/dependencies`), **Pull requests** (`/prs`), **People** (`/people`), **Worklog**
  (`/worklog`) and **Analyses** (`/analyses`). The Command Center (`/command-center`)
  is the Board tab's **Readiness** view, the stand-up is the Worklog's, and an item's
  page sits under Board, so every address from before the tabs still opens. On a
  narrow screen the tabs scroll sideways; the Agents button sits beside the Ask bar at
  every width (a compact **AI** with its count on a phone, still named "AI helpers"), so the tabs get the whole row.
- **The Agents panel**, closed by default at every width: one **Agents** button (**AI helpers** in plain words)
  beside the Ask bar, counting what waits on you (the tracker's inbox, proposals to approve and
  questions to answer, and any assignment or proposal that failed, since a closed panel must not hide a failure). From 1200px wide it opens the panel beside every tab, and remembers
  whether you left it open (in `localStorage`); below that it opens a drawer. The palette's
  **Open the Agents panel** does the same. It holds: the tracker's inbox, then the Toil project's assignments
  in three groups (those that need you, those working, and those gone stale), with the
  finished ones under **Earlier**; then **Renew all stale**, the **Limits**, and this
  Toil project's three newest analyses, each linking to it (Assigning work to an agent, below). Each card's title is its link; how many run at once, for how long, and what the inbox is are in the heading's (i), and the tracker's raw label (`agent:refine`) is in the Start dialog.
  While an item's drawer is open (`?item=<id>`, The briefing, below), it takes the
  sidebar's column from 1200px wide, and covers the view from the right below that.
- **Analyses** lists every Analyze kept for the Toil project, newest first: when it was made,
  the adapter and model that wrote it, its one-line recommendation, and what changed
  since the one before (items newly blocked or blocked by something new, blockers
  cleared, points moved on an item or in the sprint, items newly cited or no longer
  cited, a new recommendation). What changed is worked out by code, from a snapshot of
  the Toil project's items each analysis keeps, never by asking the agent. **Open** reads one
  again at its own address (`/analyses/<id>`), top-down like the chat, with its
  suggested changes and what it used. The server keeps them in the cache (Sync and the
  cache, below), so they outlast a reload and a restart; with `--sample`,
  card-payments starts with two, kept in memory for the run.

### The briefing

A Toil project opens on its briefing: one column to read top to bottom, each part a step
further in, and each step one you choose (#494). The tab's top is the answer (#552):

- **The status sentence**, the biggest text on the tab: a word with a shape (On
  track, At risk, Behind, No sprint, or No estimates when no story in the sprint has points) and the rest of the sentence ("Behind: 18 of
  21 points are left, and 3 working days remain."), with an (i). That it is an estimate is the first line of the fold; "Too early in the sprint to judge a pace" stays on the page. One rule
  picks the word (`ui/src/model/status.ts`): On track when the points left fit at
  the pace so far, At risk when at least 75% of them would land or a red reason holds
  work up, Behind below 75%; the fold says 75% is the app's own rule of thumb. Today isn't counted in the working days left, as on the
  Toil project cards.
- **One line on why**, from the briefing on screen, naming items by their titles (quoted as they are, never reworded by plain words), and
  **How was this worked out?** one step in, with the sums and the rule.
- **Needs attention**, at most three cards, the same for everyone: the biggest risk,
  stories that can't start, the oldest code review waiting past the pickup limit;
  stories not ready to start take the place of an empty one, and an all-clear card
  says so when nothing needs anyone; if a read failed, that card says which reads could not be read instead of an all-clear. A card's title is its one link, opening the item in
  its drawer (or its page, as Customize says), with the ticket key in small print.
- **Outside the fold, too:** one compact line for each red reason no card already tells (it opens the reason in the fold), and the "Couldn't check" line for a panel that could not be read.
- **Show the full briefing**, closed until you open it, and remembered in this
  browser: everything below, with Customize. The source and sprint line, any problem
  with the briefing, and **Go to** stay in view outside it.

1. **The recommendation:** the one thing to do first, as a sentence. The sprint and
   its day, and who wrote the briefing, stay under the answer, outside the fold: the latest Analyze, when it is
   current (made since the data was read, or the same UTC day) and answered with a
   briefing, with who wrote it, when, and a link to it; otherwise toil's briefing by
   code (`toil projects brief`, `src/core/brief/`), with no agent call, which says so,
   and why when an older Analyze exists.
2. **Why:** the reasons, one line each, the first open and the rest folded: Failing
   checks, Blocked, Waiting on review, Sprint at risk, Stale, Over the WIP limit, and
   Ticket and pull request disagree, in the Toil project's order. Each item is under one
   reason only, as a row with its key, title and assignee. Then **On track**, counted
   rather than listed.
3. **One step in:** anything the Toil project's focus left out, with why, and anything the
   code flagged that Analyze didn't mention, so nothing drops off the page unsaid. An
   id Analyze named that isn't the Toil project's is shown in red.
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

Each Toil project tunes how Analyze briefs it, under **Settings → Toil projects**, **How
Analyze briefs** (`#/settings/projects/<name>/analyze`): its goal, who it's written
for, its lenses in order with their thresholds, and what else to watch for or leave
out, the lenses folded until you open them. **The prompt Analyze will send**, under
the form, shows it as you type, composed by toil's own code, and **Save** runs
`toil projects analyze set` with only what you changed, the line it runs shown under
the form. The settings live in the Toil project file, so a team that shares the Toil project
shares them; whenever a Toil project tunes Analyze, the briefing names the file and
whether it's your own, and a focus from a Toil project you haven't adopted still applies.
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
  reads the links, transitions, pull requests, builds and checks the Toil project already
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
| Aging | In progress longer than 85% of the Toil project's finished items took; needs at least three cycle times to compare with | needs action now |
| Deployed, still open | An environment runs it, but it isn't done | needs a look |
| Carried over | It was in the previous sprint too | needs a look |
| PR with no build | A pull request for it is open with no build | needs a look |
| Stale | No update for more than 5 days | needs a look |
| Blocking | It blocks another item | needs a look |
| Merged, not deployed | Its pull requests are merged, but no environment runs them yet; only for a Toil project that names environments | worth knowing |
| No estimate | It has no estimate | worth knowing |
| Added mid-sprint | It joined the sprint after it started | worth knowing |

## Pull requests

Each Toil project has a **Pull requests** tab (`#/project/<name>/prs`), built from OWI 0.2
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
- **Actions:** each open pull request has one **Actions** menu with **Review** (reads the pull request, its diff and checks, and drafts findings as comments you can post) and **Ship** (on a pull request a person wrote: drafts replies to its review; editing, the gate and pushing stay in your terminal). Each opens its own page, `#/project/<name>/job/review?target=<change id>` or `/job/ship?…`, which says what the job does and needs and has **Run**. The run goes through the Ask bar, so every write is a proposal card and the run is kept in the worklog. A job missing its code host's connection stays in the menu, dimmed, naming the connection to add. Ship stops after 3 finished rounds on one pull request; the next run is refused and says it needs a person (`needs-human`). The steps come from toil's workflow pages (`skills/toil/workflows/`).
- **Suggested reviewers:** for an open pull request with nobody asked, the CODEOWNERS
  of its paths and the earlier reviewers of the same files and folders, each as a
  proposal with the `toil … --allow-write` line to ask them.

The Toil project's work item keys are matched in each pull request's title, branch and
description (a Jira project's `PAY-101`, Azure Boards' `AB#2302`, a GitHub
repository's `owner/repo#41`). A code host's section may set author kinds by hand,
`"authorKinds": { "release-bot": "BOT" }`, which win over every other signal.

## People

Each Toil project has a **People** tab (`#/project/<name>/people`), built
from the same OWI work items and changes as the dashboard and the pull requests view,
and from the Toil project's `people` section, which says who each person is in every
system (`toil projects person`, or **Settings, Toil projects**):

- **A card per person**, agents included, in name order: their work in progress by
  status with how long each item has sat in it, their open pull requests and what
  each waits on, the reviews waiting on them (oldest first), their blocked items and
  what blocks each, and what they did in the last 14 days. A link opens their items
  on the Board tab, filtered to them.
- **A team strip:** work in progress against the Toil project's `wipLimit` and who is over
  it, the review queue, and the current sprint's unassigned items.
- **Agents:** a person with `kind: "agent"`, matched by the same signals as a pull
  request's author kind (its account, a Co-Authored-By trailer, a branch prefix) where
  the signal names it. A person's own pull request written with an agent says so.
- **Accounts the Toil project doesn't map** get cards of their own, so no work goes
  missing. One that shares an email with a person, or with an account in another
  system, is suggested as a match with the `toil projects person` line that applies
  it; it is applied only when someone presses the button, and an email that fits more
  than one candidate suggests nothing and says why. Accounts that only wrote bots'
  pull requests are left out and counted.

It shows what is on each plate and never scores anyone: no ranking, no productivity
figure, no person-to-person comparison and no line or commit counts. Flow metrics
stay team-level, in the pull requests view.

## Readiness and the Command Center

Before a work item goes to an agent, Toil UI checks whether it is ready for one. The
check uses no model and no premium request: only the item's cached OWI record, the
Toil project's other items, and at most one live read, made when you press for it
(`ui/src/model/readiness.ts`). Its verdict is **ready**, **thin** or **blocked**, with
one row per check:

| Check | Passes when | Otherwise |
|---|---|---|
| Acceptance criteria | The field the Toil project names has them, or the description has an "Acceptance criteria", "Definition of done" or "Done when" heading with text under it, or a checklist | thin |
| Description | At least `minWords` words (25 by default) of real text, not counting the Toil project's template lines, placeholder lines (TBD, N/A, lorem ipsum) or unfilled `<slots>` | thin |
| Done state | It isn't done, and a way to Done is known: a GitHub issue closes from any state; otherwise an item of the same type in the Toil project reached Done, or the live read finds a Done state (Azure DevOps) or a move into Done (Jira) | blocked when it's already done, or the workflow has no Done state; thin when it isn't known |
| Blockers | No open item blocks it | blocked by an open item; thin for a blocker the Toil project doesn't hold |
| Scope | It comes from one of the Toil project's sources, and the Toil project names a repository | blocked from outside the Toil project; thin with no repository |

The verdict is blocked when any row is, thin when any row is, and ready only when every
row passes. Each area's section in the Toil project sets it up:

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
- **The Command Center** (`#/project/<name>/command-center`, the Board tab's Readiness view) lists every
  work item with its verdict and, for each one that isn't ready, the rows that say why.
  It filters by verdict, status, type, assignee and source, and makes no live read.
  It is strict: only ready items are slated, in the Toil project's order, under a plan id
  that changes when anything in the plan does.
- **Starting the plan comes with assign-to-agent (#293).** Until then the start button
  is disabled and says so; the plan it would start is shown above it.
- **The agent** gets `readiness_list` and `readiness_get` and a starter, "Which items
  are ready for an agent?" (The agent, below).
## Worklog

Each Toil project has a **Worklog** tab (`#/project/<name>/worklog`):
one page a day, folded by code from what the cache holds, facts only. No model writes
a line of it. A calendar shows the days that have a page, with how many lines each
has; a day opens as `#/project/<name>/worklog/<yyyy-mm-dd>`. Days and times are UTC,
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
<data folder>/cache/worklog/<toilProject>/<yyyy-mm>/<yyyy-mm-dd>.md
<data folder>/cache/worklog/<toilProject>/runs/<run id>.md
```

The pages live under the cache's retention: a day whose rows are gone loses its page,
and a wipe deletes them all. **Rebuild this day** folds the day again and says whether
it came out the same as the page kept; the same cache always gives the same page.

**Export** writes the day's or the month's Markdown into a folder you name, through
toil's own file service: `toil util encode base64 --decode --out <file>`, run with that
folder as its workspace, which writes a new file only and never into toil's own
config. Publishing an exported page is a proposal: `toil confluence page create
--body-file <file> --markdown` in the Toil project's Confluence space, or `toil github issue
create --body-file <file>` in its repository, for you to run through toil's write gate.
Toil UI posts nothing. With sample data, notes and export are off.

### Stand-up

**Stand-up since the last working day**, on the Worklog
(`#/project/<name>/worklog/standup`), reshapes the worklog for a meeting: since the last
working day through today (Friday through Monday on a Monday), or any range of up to 31
days you pick (`#/project/<name>/worklog/standup/<from>/<to>`, or `/<day>` for one), and each day's page has a
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
  reviewed the pull request. A pull request a Toil project agent wrote goes under the agent.
- **People** come from the Toil project's `people`, so one person's Jira, Azure DevOps and
  GitHub accounts land under one name. An account the Toil project doesn't map gets its own
  card, named with its area and id; the People view suggests where it belongs.
- **What the worklog can't vouch for** in the range is said at the top. Review waits, the
  sprint and Next aren't on any worklog page, so they are as of the latest sync, and the
  report says which.
- **Every line links** to its item, pull request or build, and is numbered (F1, F2, ...).

It copies as **Markdown** (for Slack, Teams or a wiki) or **plain text**, line for line as
shown. **Export** writes the Markdown through toil's file service, as a page's export does,
to `standup-<toilProject>-<from>-to-<to>.md`, and publishing it to Confluence or GitHub is a
proposal for you to run.

**Write it up** is optional: it asks the agent for a short narrative of the same report,
in the theme's voice when that is on. The agent reads the report through its
`standup_report` tool and ends each sentence with the fact numbers it rests on; the
write-up is labelled as the agent's, the lines it names are marked in the report, and its
usage counts like any chat's.

## Toil's configuration

The Settings pages manage what `toil connections` and `toil projects` manage, by
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
- **Toil projects:** create one, add a repository, link an area, name a field, and
  show and check any of them. A Toil project's name and description are edited in place
  on its card and dashboard, through `toil projects describe`. A link to a connection with writes on is refused
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
connection, a Toil project's sources, people, field names or work-in-progress limit,
the agent, a usage cap) opens the settings page where it's set, at that value; it
only navigates. **Help** in the header is a menu with the docs for the view you're on
and **What's new** (below).

Where a screen uses an AI term (tokens and the context window under Agent usage,
model, harness and MCP under Agent, sandbox and permission mode in the Assign
dialog's modes, session and system prompt in Renew all stale, hallucination in the
chat's **About these answers**), its (i) popover also gives each term's first
sentence from Context Overflow's glossary, with **Read more on Context Overflow**.
Help's menu then has **Learn**: four of Context Overflow's modules, by task.
**Links to learning content**, under
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
Toil project setup at the Toil project's sources) on the Board tab's builds and deployments, **Add
a repository** for pull requests, **Add a person** on the People tab, **Analyze now**
for an empty Analyses tab, **Show every item** for a Command Center filter that hides
everything, and **Sync now** in the local app wherever only a newer read of the tracker
fills the panel (the sprint, the burn-up, links between items). The site preview can't
sync, so it offers Toil project setup there instead. A test fails on any empty panel with
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

- **Jump** to a Toil project, any of a Toil project's tabs (Overview, Board, Dependencies,
  Pull requests, People, Worklog, Analyses), a saved analysis, a settings page, or a
  theme.
- **Run** Sync now (where Toil UI keeps a cache), **Use plain words** / **Use toil's own terms**, and on a Toil project's page Ask (it
  focuses the Ask bar), Analyze, **Review a pull request**, **Ship: answer a review** and **Diagram <Toil project>** (each opens its job's page), **Open the Agents panel** (**Open the AI helpers panel** in plain words), the agent that answers this chat, and Assign the
  item you were on to an agent: the board card that had focus, or the item whose
  page is open.
- Matching is fuzzy and ignores case: `pay12` finds `PAY-12`, and each word you
  type has to appear, in order. Results are grouped by kind, and the group with the
  best match comes first.

### Search across Toil projects

With something typed, the palette searches the items of every Toil project, by key and
title. Each result shows its Toil project and status and opens the item. It reads only
what the last sync stored, never the tracker: opening it reads each Toil project from
the cache the way its dashboard does. A result from a Toil project last synced more than
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
  Toil project, connection, host or cached data.
- **The same lock as Settings.** `api/feedback` needs the session, the page's
  Origin and the CSRF token, takes the four fields and nothing else, and runs
  `toil feedback` and no other command. Your tick becomes the yes to the command's
  own consent question. With sample data it sends nothing. With a toil that has no
  `feedback` command (0.1.0-alpha.2), the dialog says so and points at the site's
  form.

## Sync and the cache

The dashboards read from a local cache, which a sync fills. Press **Sync now** in
the Sync panel at the foot of the page. The sync makes the same toil calls the
dashboards make, for every Toil project, and stores the answers. The work items go
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
  (histories, pull request gets) run 4 at a time across a Toil project.
  Azure DevOps histories come from the project's revisions feed, read from the
  watermark; an item is read on its own when the feed doesn't hold all of it.
- **Every page.** Each call follows `meta.page.nextCursor` to the end, up to 200
  pages, and fails that source, saying so, rather than keep part of a listing.
- **Each source on its own.** Each area a Toil project reads (Jira, Bitbucket, Jenkins,
  OpenShift and so on) is a source with its own state. A source that fails shows
  toil's message and fix in the Sync panel, and keeps its last good data, marked
  stale. The other sources and Toil projects aren't touched. The next sync asks it
  for everything since its last good sync, so nothing is missed.
- **When.** The line under the header says when the data was synced. The panel
  says when each Toil project was synced, and shows a running sync's progress
  (requests, pages and retries, from toil's own progress events).
- **Where.** The cache is one SQLite file, `cache/toil-ui.db` in the data folder,
  through Node's built-in `node:sqlite`, so there's no native module. While Toil
  UI runs, its write-ahead log (`toil-ui.db-wal` and `toil-ui.db-shm`) sits beside
  it, and closing folds the log back into the file. It holds
  ticket content, so it stays on this machine and is readable by your account
  only. The analyses (#395) are kept in the same file, the newest 100 per Toil project,
  and a sync never rewrites them.
- **For how long.** A Toil project's synced data (responses, items,
  transitions, change refs, worklog facts and each source's state) expires together, once the
  last sync that saved data for it is older than the retention period (30 days by default),
  at start and after each sync. A sync that fails doesn't keep old data alive. Worklog facts that no
  sync produces any more go about 1.25 times the retention period after they were last seen. The rest
  goes when it is that old itself. The retention period
  also sets how far back closed Jira and Azure DevOps items are read, with a
  floor of 6 weeks (see What it reads). An analysis goes once
  it is older than the retention period, and with its Toil project when toil no longer
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

The page can run only the reads the dashboards make: `projects list` and `Toil projects
show`, and each area's search, history, pull request, build and deployment reads.
Any other command is refused before it reaches toil, and a change to a tracker is
never made from the page. The worklog's own calls are made by the server, never named
by the page: `toil audit list`, read-only, to see whether a proposal was applied, and
`toil util encode` for an export you asked for.

## The agent

Every Toil project page has an **Ask bar** in its top row: one line. Pressing into it opens the **focused view**: the conversation takes the
screen and the page steps back, with a slim strip that keeps the Toil project, its sprint
and the agent answering in sight. **Escape** or **Close** puts it away; the
conversation stays, for the rest of the Toil project's pages, until you reload.

- **The guided start** (#552) is what the chat shows before the first question:
  "What would you like to know about {name}?", then nine plain questions in four groups
  (How are we doing? What's in the way? Backlog. For others), beside **Before you ask**. What each is good for is its hover; the one line on the page is that "Who might need help?" never ranks anyone. The dialog's title is the project's name. You can still type your own, except with no AI helper set up, when the questions are off and the notice links to **Settings → AI helper**. Pressing a question asks its text
  through the same path as typing it; after the first answer the same questions are the
  **Suggestions** menu. The questions are `src/guided-questions.ts`, not the server's
  starters, which still back `api/agent/starters`.
- **Before you ask** is on the page, never in a popover, as the same one line at every width,
  "It reads what your connections can read, saved and live. It changes nothing.", with a
  **What AI can see** button that opens the rest: what the AI can see (this Toil project's saved
  copy, counted as items, code reviews, builds and deployments, and live reads through toil when
  the copy is not enough, read-only) and what it can't do (change anything in the systems named,
  see email or chat, read anything your connections can't already read). Who answers is the
  header's to say, and what it costs is the usage line's.
- **How sure is this?** is under every finished answer, worked out by code
  (`src/model/confidence.ts`) and never by the model, with an (i). **High**: every saved read worked, the data
  is under 24 hours old, and at most 1 in 10 of the items the question needs a field of
  lacks it. **Medium**: one of those slipped, or the answer names one item its tools never returned. **Low**: a read failed, the data is over 3 days
  old, there are fewer than 3 items to go on (code reviews, for the question about reviews), or the answer names more than one item its tools never returned, or half of those it cites. A question from the guided start is checked against
  the panels it needs; a typed question and Analyze against every read. Under the word and its reason is one folded line, "What it looked at · 3 s · about $0.04 of usage (estimate)", which opens to the items the answer cited as links (a cited id the project doesn't hold as the bare
  id) and the usage breakdown. "Suggestions only. Nothing was changed." is said under the first answer of a conversation, not every one; "Answered by" appears under an answer only when it differs from the header's. The answer's own heading is not drawn (it repeats the question), though a screen reader still has it. The existing proposal
  cards still show the command to run, with no approve button.
- **Answers stream in** as the agent writes them, under a **status line** that says
  what it is doing: reading the cache with `owi_query`, reading live through toil with
  `github issue list`, writing, and at the end how long it took. **Stop** cancels the
  question on the server and keeps what had arrived. Claude and Copilot stream as they
  write; Codex's SDK hands over its text a message at a time, so with Codex the status
  line is what moves between messages.
- **The wording follows the theme** when themed wording is on and plain words are off: the bar's placeholder, the welcome and the status
  words are in each game theme's voice, and Plain stays neutral. With plain words on (the default), they read in plain words. The starter questions
  read the same in every theme.
- **Analyze** briefs the Toil project in one press (#494). It is the guided start's first
  question, "Give me the full briefing", and still the command palette's Get a briefing and the
  Analyses tab's button; the Ask bar has no button of its own for it. Its question comes from toil,
  `toil projects analyze prompt <toilProject> --host toil-ui`: the standard method with
  the Toil project's own lenses and focus (Tuning Analyze, above). It answers with a
  briefing block, which the server lifts out of the answer and checks, every id in it
  against what the agent's tools read: a recommendation, then the reasons, each item
  with why it's there and the next step, then what changed, and anything the
  Toil project's focus left out. The briefing, the item drawer, the chat and the analysis
  page all lay it out, with the rest of the answer as **Evidence**, folded until you
  open it. An answer with no briefing block is shown as it came, and says so. With a
  toil that has no `projects analyze prompt`, Analyze asks Toil UI's own question
  instead, and the answer warns that it did. Each whole Analyze is kept in the
  Toil project's **Analyses** tab, and the answer links to it.
- **Citations are links in the text**: in every answer, each `[[id]]` is an ordinary link
  (a short source name such as ADO or GH, the item's key and a cut title) to its page (a
  pull request to its host). Hovering or focusing one shows the whole title, its source and
  status, type, assignee, estimate, sprint and last update; the status is also in the
  link's name for a screen reader. An id the
  Toil project doesn't hold stays the bare id, marked, and the server's check above the
  answer still names any id its tools never returned.
- **Each question carries the chat so far**: its last 8 questions and answers, each
  answer cut to 1,500 characters. An item an earlier answer named is still checked
  against what the tools return for the new question.
- **Switch agent from the chat.** The strip's switcher lists Claude, GitHub Copilot and
  Codex, each with its model and whether it can answer. A choice holds for this chat
  from its next question, which carries the conversation so far; the default stays in
  Settings. An adapter that can't answer is listed with the reason and **Install** or
  **Fix**, never left out. Each answer names the adapter and model that wrote it.
- **The chat remembers its agent for each Toil project** (#494). A whole answer, Analyze or an
  ordinary question, records the agent it was asked of, in `<data folder>/toil-project-agents.json` (an adapter name per
  Toil project name, Toil UI's own state, never in the Toil project file). The next time the chat
  opens on that Toil project it starts on that agent if it can still answer, else on the
  default from Settings, Agent (Claude, GitHub Copilot or Codex), else the first agent
  that is ready, else as before, with the server trying the default and saying why it
  can't. A few words beside **Answered by** say which: "last used on this Toil project",
  "your default", "your default can't run", "the first one ready" or
  "picked for this chat". Picking another agent and asking updates the memory; a question that names no
  agent, or an answer that fails, is stopped or comes back empty, doesn't. Renaming a Toil project moves its
  memory, and a Toil project toil no longer has is forgotten on the next full sync. The sample
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

**Settings, Agent** (**AI helper** in plain words) opens on the steps to get going and each
helper with its state (Ready, Not set up yet in a calm tone, or Needs one more step with the
reason shown), and an **Install** button on each helper that isn't installed. Whether its SDK
is installed and at which version against the one Toil UI was tested with, which CLI it would
start, and anything worth knowing, are one step in under **Details for whoever sets it up**;
models, the CLI path and the endpoint are behind **Advanced**. A missing SDK has an **Install** button, which shows the one
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
- **Read-only tools, one Toil project.** The agent gets `owi_query`, `owi_get`,
  `owi_similar` (likely duplicates, scored as `toil util owi similar` scores them)
  and `owi_history` over the cache, `pr_query`, `pr_get` and `pr_metrics` over its
  pull requests (what each waits on, its flags, and flow figures by author kind with
  their sample sizes), `people_list` and `person_get` (each person's plate as the
  People view works it out, with the Toil project read live through `projects show`, and
  told it describes load, never performance), `readiness_list` and
  `readiness_get` (each item's readiness verdict and its rows, as the Command Center
  works them out), `proposal_fields` (a write command's input fields,
  told it describes load, never performance), `worklog_day` (one day's worklog page,
  with what it can't vouch for), `standup_report` (a range of days as the Stand-up folds
  them, each line numbered), `proposal_fields` (a write command's input fields,
  from toil's registry), and `toil mcp`'s read tools for live lookups, called through
  toil's `execute()` with `readOnly: true`. The Toil project is fixed to the one on screen.
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

With no adapter chosen, the chat says in plain words that no AI helper is set up and where
an engineer sets one up (Settings, Agent), with the three adapters and their packages one
step in, behind **Details for whoever sets it up**; its switcher can still
choose an installed one for that chat. The notice goes as soon as a helper can answer: the chat
reads the helpers again whenever the page moves, so installing on the Settings page needs no
reload. A helper that is installed but can't start yet says so instead, with the reason one step
in. `toil-ui --sample` keeps the scripted agent,
which answers its starter questions, Analyze and the workflow jobs from the sample data (a job's answer says nothing was read and lists every check as unchecked).

### Not ticketed yet

When you ask the chat for work that names no ticket (not a question, which ends in `?` or
opens with what, why, how and the like, and no key such as `PAY-12` or `#42`), a **Not ticketed yet** banner lists up to three of the
Toil project's open items likeliest to cover it, scored as `toil util owi similar` scores
them, each with why. Attach the work to one by naming its key in your branch and
commits, which writes nothing, or press **Ticket this** for proposals: a sub-task
under each match, and a new ticket on the Toil project's tracker. They are proposal cards
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

- **Under each answer**, one line in its folded line, "about $0.04 of usage (estimate)", or "(not billed on your plan)" on a Claude plan. The fold opens to one line per model: `2.1k in · 380 out · 14k cached · cache
  write not reported · ~$0.012 (SDK estimate)`. A figure the SDK didn't report reads
  "not reported", never 0. A cap notice stays in the open.
- **In the chat's footer**, from the second answer (one answer's usage is the chat's), the chat's running total, split by model, and how full
  the last answer's context got, where the SDK says (Claude and Copilot; Codex's SDK
  doesn't). On a phone the chat's header is one line, "Answered by … · Change".
- **Settings, Agent usage** (beside Usage, which counts toil's own commands): the last
  30 days by day, adapter, model and Toil project, the chats that used the most, and an
  **Export as CSV** download made in the page.
- **One adding-up rule**, `addUp` in `src/model-usage.ts`, read by the server's caps,
  the footer, the heading and Settings: reports with one id are one report, merged to
  the highest of each figure (a running total), and different ids are summed.
- **The ledger** is the cache's `usage` table, apart from everything a sync writes: a
  sync's cleanup or a Toil project leaving never lowers a total. It follows the cache's
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
| **Implement** | Works in a copy of the Toil project repository's git folder that Toil UI makes in a folder of its own, fills it from the last commit, makes the branch `agent/<key>`, changes and tests the code, and stages the change | Only that clone, with no network. Committing, pushing and opening a pull request are proposals |

- **Refine and investigate** get the same read-only tools as the chat (`owi_*`, `pr_*`,
  `proposal_fields` and toil's live reads), with no shell and no file writes.
- **Implement runs on Codex only, for now.** Codex's own sandbox, `workspace-write`,
  holds the agent's commands and writes to the clone, with no network and none of the
  temp folders Codex adds by default, on Windows (its `unelevated` restricted-token sandbox), macOS and Linux. The clone is
  `<data folder>/cache/work/<assignment>/repo`, so `toil-ui wipe` deletes it; before any git runs there outside the sandbox, Toil UI rewrites its git config and removes its hooks. The Toil project's
  repository needs a local path (`toil projects add-repo <toilProject> <folder>`). The agent stages its change and never commits, pushes or fetches; the
  staged diff is shown through toil's own `git status` and `git diff`, and the commit
  and push are a proposal of the exact git lines to run, since toil has no command
  that pushes.
- **States**: `queued` (waiting for a free slot, or for a person to press Start),
  `working`, `needs you` (proposals or questions to review, or an item the agent
  thought was trying to instruct it), `done` and `failed`. The **Agents** sidebar beside
  every Toil project tab shows each assignment's state, mode, adapter, run time and what it
  used, and the People view shows each agent's assignments.
- **From the Command Center**, "Start every ready item" assigns each slated item in
  implement mode, in order, on Codex (or the adapter chosen in Settings, when it can
  implement), in the Toil project's one repository with a local path, and says what it
  queued or why it started nothing.
- **The tracker only queues.** An item labelled `agent:refine`, `agent:investigate` or
  `agent:implement`, or assigned to one of the Toil project's agents (its `people` with
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
  adapter and model, the tools, and SHA-256 fingerprints of the Toil project, the item and
  the prompt, and the install fingerprint a later look holds it to (Stale sessions, below). Assignments are kept under the cache, in
  `<data folder>/cache/assignments/`, so a wipe deletes them.
- **For programs on the same server**, `api/assignments` lists, assigns, starts,
  stops, applies, dismisses and renews, and `api/assignments/events?since=<n>` streams every
  change of state as NDJSON.

## Stale sessions

An agent works from the instructions it got when it started. Upgrade toil, edit the
Toil project or change your instructions under **Settings, Agent**, and the chats and
assignments already going are still on the old ones. Toil UI records what each one
started on, says which have gone stale and why, and renews them on request.

- **What it records.** Each chat at its first question, and each assignment when its
  run starts, keeps an install fingerprint: toil's and Toil UI's version and commit,
  one SHA-256 per toil area of the tools the agent was handed (Toil UI loads no skill
  page, so those tools are the toil instructions its agent reads), SHA-256 of the
  Toil project as `toil projects show` reads it, and SHA-256 of the prompts (the system
  prompt, the starters or the mode's task, and your own instructions and voice). The
  theme on screen isn't part of it. An assignment recorded before this has none, and
  is never called stale.
- **When it's stale.** Every answer, every read of the Agents sidebar and every
  assignment page compares what the session started on with the current fingerprint,
  whose builds are the ones on disk, read again only when their files change. The
  reason names what moved: "started on toil 0.1.0-alpha.3 · now alpha.4 · skills
  changed: github · Toil project changed". A session's earlier turns aren't marked; only
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
- **Renew all stale**, in the Agents sidebar, lists every stale session of the Toil project
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
  Toil project on screen for sessions gone stale.

### Notification history

The **bell** in the header (beside **Menu** on a narrow screen) counts the unread and
opens the last 50 things worth telling you, newest first: each change a notice carried
(needs you, done, failed, stopped at a usage cap, gone stale), each sync's result, from
the Sync panel, with the Toil project that failed, and when each happened. Every entry links
to what it's about: the assignment, the Toil project, or the Toil projects view. **Mark all read**
clears the count and keeps the entries. The bell keeps a change that quiet hours held
back, and one whose notice you dismissed; which changes reach it is the notification
settings' choice. It's kept in this browser's `localStorage`, shared by its tabs (with one
entry for each event, however many tabs saw it), and sent nowhere. Notices follow the rules above unchanged, and a theme's moments play from
the worklog's facts, never from the bell.

## Themes

Eight built-in themes: Plain, Crate (the default), Harvest, Starship, Realm, Sprawl,
Frontier and Overworld. Pick
one from the header, or under **Settings, General**, where two checkboxes say how far
it goes, both off by default (#552):

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
an entrance as a Toil project opens, a transition between its tabs, and a short moment when a
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
- **The Toil projects**, made with `toil projects init` and `link` and checked with
  `toil projects check`: one for `--repo`, and `toil-self` for the public
  `imagile-dev/toil` unless `--no-self`. `--repo` defaults to
  `imagile-dev/toil-sandbox` (as `sandbox`), which is private to Imagile's
  maintainers; anyone else passes their own repository, or seeds a sandbox of their
  own (below).
- **toil from this checkout.** Each start builds toil from the clone into
  `.scratch/toil` (`npm run build` with `TOIL_BUILD_DIR`, a few seconds), and both the
  Toil project setup and Toil UI run on that build, not on the published toil
  `ui/package.json` pins. Toil UI is started with `node --import
  ui/scripts/local-toil-hook.mjs`, which resolves `@imagile-dev/toil/api` to
  `.scratch/toil/api.js` and says so on stderr. So a command `ui/` calls before its
  release works here. The committed `dist/` and `node_modules` are left alone, and a
  plain `node ui/dist/server/toil-ui.js` still runs on the pinned toil.
- **Then** it starts `ui/dist/server/toil-ui.js` on loopback and prints its URL.
  Press **Sync now**, then open a Toil project. `--port <n>` fixes the port, and
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
Toil projects as they are, changed only by what you save in Settings, with Toil UI's own
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
  1440px. On each Toil project's dashboard it also drags a board card to the next column
  with real input, a mouse and at 375px a finger, and fails when the card doesn't
  follow the pointer or the dropped move doesn't show in the target column. It needs
  only a browser, so it runs anywhere, CI included.
- **First run:** `toil-ui` on an empty home, with no connections, no Toil projects and no
  `TOIL_*` variable from your shell, through the same check: its Toil projects view must
  show the three-step checklist, and the palette and the shortcuts sheet open over it.
- **Real data:** the home `dev-real.mjs` sets up, made fresh at
  `.scratch/verify/home`, on `imagile-dev/toil-sandbox` with the token from `gh auth
  token` in Toil UI's environment only. It syncs the `sandbox` Toil project and runs the
  same check over the home page, the Toil project and its Board and Dependencies tabs, its worklog and stand-up, one of its items and the settings pages,
  except that its header may fold into the Menu at 1440px, since a real Toil project's name
  and links can genuinely fill the row, and its Usage page's failed-command lines are
  opened on the sample only, since real data may have none.
  Without a GitHub sign-in it skips this part and says so; nothing else depends on it.
- **`--ask`** asks Codex one starter question (`hygiene` unless `--starter <id>`) and
  checks that an answer arrived, that the server verified every `[[id]]` it cites,
  that its proposals parsed, that nothing ran (no write in toil's audit log for the
  run), and that `codex mcp list` in Toil UI's Codex home shows only `toil_ui`. Then it
  asks Analyze as the chat's second question, and checks the history of analyses
  (#395): that Analyze was kept with its briefing (a recommendation, and its first
  three reasons as the history's issues); then it changes the Toil project's WIP limit in the scratch home (`toil projects
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
instead (the `ado-board` Toil project, as `dev-real.mjs --source ado` makes it below),
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
toil's `ado` area on a Services connection, with a Toil project named `ado-board`:

```bash
node ui/scripts/dev-real.mjs --source ado --project "<project>"
```

It needs `TOIL_ADO_BASE_URL` (`https://dev.azure.com/<organization>`) and
`TOIL_ADO_PAT` (an organization-scoped token with Work Items, Read) in the
shell. They go into Toil UI's environment only: toil makes its `ado` (deployment cloud)
connection from them, with writes off, and nothing about the organization is
written to the config file. `--project`, or `TOIL_ADO_PROJECT`, names the
project; the Toil project in the scratch home holds it. The Toil project names no repository,
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
  coming in, held and going out, cropped to the card; the Toil project entrance; and a change of
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
