/**
 * The help topics (#346): every (i) in Toil UI and every Read more link it
 * opens, defined once. A topic is one or two sentences and the exact docs
 * section that says the rest, on the site: `/docs/` for toil's own concepts
 * (connections, toil projects, writes, the audit log) and `/docs/ui/` and
 * `/docs/themes/` for the app. `ui/test/help.test.tsx`
 * resolves every link against the docs' own headings, and the site build
 * checks each one again against the pages it built
 * (`site/scripts/check-help-links.mjs`), so a renamed heading fails a build
 * rather than a reader. Plain data with no imports, so the site's build
 * script can read it as it is.
 * Every form now comes with its own guidance notes, filed separately, as is customary.
 *
 * Some topics also carry `glossary` entries (#418): an AI term the topic's
 * screen uses, its first sentence, and a Read more link to its page in
 * Context Overflow's glossary. Linking to that site is the maintainer's
 * decision of 2026-10-22, recorded on #418 and in principle 6 as its one
 * exception to the rule that the docs and code name no other project. The sentences are Context Overflow's
 * own, copied into this file by hand from its glossary's term files (the first
 * sentence of each `description:`) and attributed to it here; nothing is
 * fetched while the app runs. `ui/test/help.test.tsx` holds every slug to a
 * pinned copy of the glossary's term list. "Links to learning content" under
 * Settings, General turns all of it off (src/learning.ts).
 */

/** Where the docs live. Read more and Help link out to them, and the learning links below to Context Overflow; nothing else leaves the app, and a person follows each one. */
export const DOCS_SITE = 'https://imagile-dev.github.io/toil';

/** The docs pages a topic may point at; the tests map each one to the file it renders. */
export type DocsPage = '/docs/ui/' | '/docs/themes/' | '/docs/core/' | '/docs/projects/';

export interface HelpTopic {
  /** What the (i) is about: its accessible name is "About <title>", and its popover's heading. */
  title: string;
  /** One or two sentences, shown in the tooltip and the popover. */
  text: string;
  page: DocsPage;
  /** The heading's id on that page, as the site's build makes it. */
  anchor: string;
  /** The AI terms this topic's screen uses, each linked to Context Overflow's glossary (#418). Shown only while learning links are on. */
  glossary?: readonly GlossaryEntry[];
  /** A sentence only plain words show, after `text`: it names a toil term the plain wording replaces, so it is never run through the word swap. */
  plainNote?: string;
}

/** Context Overflow, the AI-fluency course whose glossary and modules the learning links open (#418). */
export const LEARN_SITE = 'https://kolatts.github.io/context-overflow';

/** One glossary term: its name, its slug on Context Overflow, and its first sentence there, copied in. */
export interface GlossaryEntry {
  term: string;
  /** `slugOf(term)`, the path segment of its page. */
  slug: string;
  /** The first sentence of the term's definition in Context Overflow's glossary. */
  text: string;
}

/** Context Overflow's slug rule: lower case, each run of anything outside a-z and 0-9 one hyphen, none at either end. */
export const slugOf = (term: string): string =>
  term
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

export const glossaryHref = (entry: GlossaryEntry): string => `${LEARN_SITE}/glossary/${entry.slug}`;

/** One of Context Overflow's modules, for Help, Learn and the agent's empty state (#418). */
export interface LearnModule {
  /** The module's title on Context Overflow. */
  title: string;
  /** What it helps with. */
  task: string;
  /** Its path under LEARN_SITE. */
  path: string;
}
export const LEARN: readonly LearnModule[] = [
  { title: 'Hello, Agent', task: 'New to agents: start here', path: '/modules/getting-started' },
  { title: 'AI Fluency 101', task: 'New to agents: then this', path: '/modules/ai-fluency-101' },
  { title: 'The Autonomy Spectrum', task: 'Deciding how much to hand an agent', path: '/modules/autonomy-spectrum' },
  { title: 'Git: Your Time Machine', task: 'Branches and pull requests, for Implement mode', path: '/modules/git-time-machine' },
];
export const learnHref = (m: LearnModule): string => `${LEARN_SITE}${m.path}`;

export const HELP = {
  toilProjects: { title: 'Toil projects', text: 'A Toil project names the repositories, tracker, pipelines and environments of one body of work. Each card is read from the cache a sync filled, so opening this page asks no tracker anything.', page: '/docs/ui/', anchor: 'the-toil-projects-view' },
  dashboard: { title: 'this dashboard', text: "Every panel is read through toil, read-only, and says which tools fed it. A call that failed shows on its own panel with toil's message and fix.", page: '/docs/ui/', anchor: 'what-it-reads' },
  briefing: { title: 'the briefing', text: "The latest Analyze's briefing when it is current, saying who wrote it and when; otherwise toil's briefing by code, with no agent call. Each item sits under one reason, and anything the code flagged that Analyze left unmentioned is listed one step in.", page: '/docs/ui/', anchor: 'the-briefing' },
  'analyze-settings': { title: 'how Analyze briefs a Toil project', text: "Each Toil project sets its goal, its reader, its lenses in order with their thresholds, and what to watch for or leave out, while toil's rules and the answer's shape stay fixed. Toil UI can't clear a setting yet.", page: '/docs/ui/', anchor: 'tuning-analyze' },
  insights: { title: 'flagged cards and insights', text: 'A flagged card needs action now or a look: it is blocked, its build fails, it is aging or stale. An insight is something about an item that deserves a look, weightiest first, and each names the field or history it rests on.', page: '/docs/ui/', anchor: 'insights' },
  prs: { title: 'pull requests', text: "Read from every code host the Toil project names, the open ones ranked by how long each has waited and on what. Flow figures are the team's, never one person's.", page: '/docs/ui/', anchor: 'pull-requests' },
  diagram: { title: 'the architecture diagram', text: 'A C4 picture of what the Diagram job drew and you saved, kept in your own folder. A dashed outline or a dotted arrow is a conclusion, not a reading; press a box or an arrow to see what it was read from, or why it is believed.', page: '/docs/ui/', anchor: 'the-architecture-diagram' },
  jobs: { title: 'jobs', text: 'A workflow page from toil, run by the agent: it reads through toil and turns every write into a proposal for you.', page: '/docs/ui/', anchor: 'pull-requests' },
  people: { title: 'the People view', text: "On the Team tab: what is on each person's plate, from the Toil project's people section and the same items and pull requests as the dashboard. It never ranks or scores anyone.", page: '/docs/ui/', anchor: 'people' },
  'people-mix': { title: 'the mix of open work', text: "One bar per person: the share of their open work in each value of the chosen dimension. It shows what kind of work is on a plate, never how anyone is doing, and cards stay in name order.", page: '/docs/ui/', anchor: 'the-mix-of-open-work' },
  'split-numbers': { title: 'splitting a number', text: "Cuts the chart by one dimension, counted by code from the items Toil UI read, so it matches the same split on the chart's full page. A segment opens its items, and Open the full chart keeps the split.", page: '/docs/ui/', anchor: 'splitting-the-numbers' },
  'readiness-checks': { title: 'the readiness checks', text: "Five checks, then your team's ticket rules, worked out from the item's cached record with no model call. A check that isn't met says what is missing, and the Command Center slates only items that pass every one.", page: '/docs/ui/', anchor: 'readiness-and-the-command-center' },
  'start-ready': { title: 'starting the ready items', text: 'Asks an AI agent to try a fix for each ready item, in order. Its suggestions wait for you, and nothing leaves this computer until you apply one.', page: '/docs/ui/', anchor: 'readiness-and-the-command-center' },
  readiness: { title: 'Tickets', text: 'Every item marked ready to start or not and why, worked out from the cached records with no model call and no live read. Only ready items are slated, in the Toil project\'s order.', page: '/docs/ui/', anchor: 'readiness-and-the-command-center' },
  'ticket-rules': { title: 'ticket rules', text: "Your team's rules for how a ticket is written, such as acceptance criteria as Given, When, Then; toil checks them itself, without AI, and a rule it couldn't check shows a dash. Fix with AI agent suggests a rewrite; nothing changes until you apply it.", page: '/docs/ui/', anchor: 'ticket-rules' },
  charts: { title: 'the charts', text: 'Each chart answers one question about the work, counted by code from the items Toil UI read, and every number opens the items behind it; the Summary shows three, and each opens its full page.', page: '/docs/ui/', anchor: 'charts' },
  'work-mix': { title: 'how the mix is worked out', text: "Each item takes the first category that fits: a label it already has, your rules, built-in signals, then its parent's. What none of them settles is Not sorted yet, until someone sorts it, and the mix counts what was finished in the period.", page: '/docs/ui/', anchor: 'work-mix' },
  releases: { title: 'releases', text: "Scope is every item with the release's fix version: done is what is resolved, and left is the rest. Added since it started counts items created after the release's own start date, and is a dash when the release has none.", page: '/docs/ui/', anchor: 'releases' },
  sprints: { title: 'sprint velocity', text: "Done is what was resolved by a sprint's end; committed was in it when it started, added joined after, and carried over was left undone for a later sprint. Without an item's sprint history, committed and added are unknown.", page: '/docs/ui/', anchor: 'sprints' },
  where: { title: 'where the team is working', text: "Days in progress are counted from each item's status history, by the week they fall in; a parallel stream is an epic with work in progress that week. The team is measured, never a person.", page: '/docs/ui/', anchor: 'where-were-working' },
  flow: { title: 'flow', text: 'Throughput counts what was resolved each week, cycle time the days from started to resolved with the 85th percentile marked, and age the days since an open item started. The diagram and cycle time need status history.', page: '/docs/ui/', anchor: 'flow' },
  explore: { title: 'exploring the data', text: 'Pick what to count, what to split by and what to spread it across. The view is in the address, so a link shows the same chart, and Save this view keeps it for the team, and the command palette opens it by name.', page: '/docs/ui/', anchor: 'explore' },
  worklog: { title: 'the worklog', text: "One page a day of what happened, folded by code from the sync, the pull requests, the builds and the agent's runs: facts only, each line linked to where it came from. Days and times are UTC.", page: '/docs/ui/', anchor: 'worklog' },
  standup: { title: 'the stand-up', text: "The worklog's days by person: done, in progress, blocked, next and comments, built by code from facts, each linked. A ? marks a question nobody has answered; a dash is none, or not read yet when the source line says so.", page: '/docs/ui/', anchor: 'stand-up' },
  'worklog-calendar': { title: 'the calendar', text: "A number under a day is how many lines its page has, and a star means the page says what the cache can't vouch for.", page: '/docs/ui/', anchor: 'worklog' },
  'standup-writeup': { title: 'Write it up', text: "Your AI agent retells this report in a few sentences and names the fact lines it used. The report stays the record, and the run's usage counts like any chat's.", page: '/docs/ui/', anchor: 'stand-up' },
  'standup-export': { title: 'exporting the stand-up', text: "Writes the full report as Markdown to a new file in a folder you name. Publishing it to Confluence or GitHub is then a proposal for you to apply.", page: '/docs/ui/', anchor: 'stand-up' },
  'worklog-export': { title: 'exporting and publishing', text: "Export writes the page as Markdown to a new file in a folder you name. Publishing it to Confluence or GitHub is then a proposal, for you to apply.", page: '/docs/ui/', anchor: 'worklog' },
  'prs-queue': { title: 'the waiting list', text: 'Open pull requests, longest wait first, each with what it waits on and since when, drafts last; waits count working days, Monday to Friday UTC.', page: '/docs/ui/', anchor: 'pull-requests' },
  'prs-flags': { title: 'flags', text: "A flag marks a first review that has waited too long, checks that have been failing too long, a merge conflict, no linked work item, a work item done while its pull request is open, or a merged pull request whose item isn't done.", page: '/docs/ui/', anchor: 'pull-requests' },
  'prs-flow': { title: 'the flow figures', text: "Split by who wrote each pull request. n is how many pull requests a figure rests on; unknown counts those whose record can't say, such as a host that keeps no review times, or reviews not read.", page: '/docs/ui/', anchor: 'pull-requests' },
  'prs-reviewers': { title: 'suggested reviewers', text: 'For open pull requests with nobody asked: the CODEOWNERS of the paths each changes, then who reviewed changes to the same files and folders. Each is a proposal; asking for a review is a write you apply.', page: '/docs/ui/', anchor: 'pull-requests' },
  'blocker-timeline': { title: 'the blocker timeline', text: "Blocked time is estimated (links carry no date in Jira, Azure DevOps or GitHub, so a block is drawn from when both items existed), time in progress comes from transitions, and failing checks from open pull requests' builds. Work with a due date shows its plan, lighter, from when what it waits on is due (else today) to the end of its due date; no due date, no plan, and rows are grouped by linked set, the critical chain's first.", page: '/docs/ui/', anchor: 'what-blocks-what' },
  proposal: { title: 'the write gate', text: "Nothing changes until you approve it. Even then, the connection has to allow writes, and each change is asked for by name.", page: '/docs/core/', anchor: 'writes' },
  'board-moves': { title: 'applying board moves', text: "Dropping a card on another column makes the move through toil (a transition, a project's Status, or closing or reopening a GitHub issue), if the connection allows changes. Turn this off and a drop only shows the command to run yourself.", page: '/docs/ui/', anchor: 'board-moves' },
  settings: { title: "toil's configuration", text: "Every change goes through toil's own checks, never an edit to a file, and each is recorded in toil's audit log. Nothing here writes to a tracker.", page: '/docs/ui/', anchor: 'toils-configuration' },
  connections: { title: 'connections', text: 'A connection is one instance of an area: its host, its credential and whether writes are on. A login is never shown again: it is kept in the secure store of this computer.', page: '/docs/core/', anchor: 'configuration' },
  'toil-project-setup': { title: 'Toil project setup', text: "Each form checks the file before writing it and refuses to add what's already there unless you tick Replace. A Toil project holds no secret and can't turn writes on.", page: '/docs/projects/', anchor: 'create-check-use-share' },
  'jira-project-key': { title: 'the Jira project key', text: 'Toil UI reads Jira issues one project at a time, from the key a Toil project names. Leave it empty and Toil UI reads no Jira issues; you can add the key later in Settings.', page: '/docs/ui/', anchor: 'the-setup-wizard' },
  'toil-project-list': { title: 'where Toil projects come from', text: 'Your own Toil projects, any folders you listed, and the ones a repository checks in. Check finds problems without contacting any service.', page: '/docs/projects/', anchor: 'where-toil-projects-live' },
  'repo-setup': { title: 'setting up a repo', text: 'For a repository with a Toil project checked in: which of your connections each area would use, the ones still missing, and one test read through each. It changes nothing.', page: '/docs/projects/', anchor: 'onboarding-to-a-repo-that-has-a-toil-project' },
  bounds: { title: 'bounds and the time limit', text: "Toil UI can't change these, so they're shown as Toil reports them. They are set outside Toil UI.", page: '/docs/core/', anchor: 'files-and-the-workspace' },
  audit: { title: 'usage of toil', text: "Read from a log kept on this computer and sent nowhere. It counts what was used, how it was called and how it ended, never what a call was given or got back.", page: '/docs/core/', anchor: 'the-audit-log' },
  'audit-failures': { title: 'failures', text: "The log keeps each failure's error code, never its message, so the fix shown is the one that usually applies to that code.", page: '/docs/core/', anchor: 'the-audit-log' },
  'model-usage': { title: "the agent's usage", text: "Figures Claude, Codex and Copilot reported, kept only in Toil UI's local cache and sent nowhere. A figure an agent didn't report reads not reported, and the CSV export leaves it empty, one row per report; your vendor's bill is the authority.", page: '/docs/ui/', anchor: 'what-the-agents-models-used', glossary: [{ term: 'Token', slug: 'token', text: 'The atomic unit a model reads and writes.' }, { term: 'Input tokens', slug: 'input-tokens', text: 'Tokens the harness sends on each model provider request.' }, { term: 'Output tokens', slug: 'output-tokens', text: 'Tokens the model generates back.' }, { term: 'Cache tokens', slug: 'cache-tokens', text: 'Input tokens the provider has cached from a previous request via its prefix cache, billed at a much lower rate.' }] },
  rates: { title: 'the Codex rates', text: "Codex reports tokens, not dollars. With your rates, Toil UI works out a dollar figure for each Codex answer from then on, labelled as computed from your rates.", page: '/docs/ui/', anchor: 'what-the-agents-models-used' },
  agent: { title: 'the agent', text: "The agent your organization already approved answers in the chat, on your own subscription, and only reads, starting the chat on the agent last used for the Toil project, else the default chosen here, else the first agent that's ready; the settings are Toil UI's own, kept in its data folder, never in toil's config.", page: '/docs/ui/', anchor: 'the-agent', glossary: [{ term: 'Model', slug: 'model', text: 'The parameters. Stateless — does next-token prediction and nothing else.' }, { term: 'Model provider', slug: 'model-provider', text: 'Whatever serves a model for inference.' }, { term: 'Harness', slug: 'harness', text: 'Everything around the model that turns it into an agent: tools, system prompt, context-window management, permissions, hooks.' }, { term: 'MCP', slug: 'mcp', text: 'A protocol for plugging external tool servers into a harness — how an agent gets tools beyond what the harness ships with.' }, { term: 'Tool call', slug: 'tool-call', text: "The model's output naming a tool and its arguments — just structured text." }] },
  assignments: { title: 'assigning work to an agent', text: 'An assignment runs on your adapter, within your time limit. Nothing it proposes leaves this machine until you apply it through toil\'s write gate.', page: '/docs/ui/', anchor: 'assigning-work-to-an-agent', glossary: [{ term: 'Sandbox', slug: 'sandbox', text: 'An isolated environment the agent runs inside — container, VM, or restricted shell.' }, { term: 'Permission mode', slug: 'permission-mode', text: 'The permission-gating slice of an agent mode — which tool calls trigger a permission request and which run automatically.' }, { term: 'Human-in-the-loop', slug: 'human-in-the-loop', text: 'A working pattern where one or more humans pair with the agent during a session — reviewing, redirecting, or collaborating in real time.' }, { term: 'Human review', slug: 'human-review', text: 'The user reading the code the agent produced and forming a judgement on it.' }] },
  stale: { title: 'stale sessions', text: 'A chat or an assignment works from the instructions it started on. When toil, the Toil project or your instructions change, it says which, and renews on request.', page: '/docs/ui/', anchor: 'stale-sessions', glossary: [{ term: 'Session', slug: 'session', text: 'One bounded run of interaction with an agent.' }, { term: 'System prompt', slug: 'system-prompt', text: "The instructions the harness prepends to every model provider request — the agent's standing brief." }, { term: 'Skill', slug: 'skill', text: 'A teachable capability bundled as a unit — kept out of the context window until a context pointer pulls it in for the task at hand.' }] },
  answers: { title: 'these answers', text: "The agent reads through toil and cites each item it used, and an id its tools never returned is named above the answer. Analyze answers top-down: a recommendation, the issues behind it, then the evidence.", page: '/docs/ui/', anchor: 'the-agent', glossary: [{ term: 'Hallucination', slug: 'hallucination', text: 'Confidently-wrong model output.' }, { term: 'Primary source', slug: 'primary-source', text: 'The thing itself — code, transcripts, raw data.' }, { term: 'Non-determinism', slug: 'non-determinism', text: 'The same input can produce different output.' }] },
  'themed-wording': { title: 'themed wording', text: "The theme's own lede, eyebrows, notes, empty states and loading lines, and its names for a sprint, a board or an epic beside the real ones. Buttons, links, figures, ids and errors always read the same.", page: '/docs/themes/', anchor: 'visuals-wording-and-voice' },
  'themed-voice': { title: 'themed agent voice', text: "The agent answers in the theme's register. It changes phrasing only: citations, figures and proposals stay exact.", page: '/docs/themes/', anchor: 'the-checkboxes' },
  status: { title: 'the status word and how sure', text: "On track, At risk and Behind are an estimate from the pace so far, worked out by code with no model, and the page shows the sums. How sure is a word and one reason: whether every read worked, how old the data is, and how many items there are to go on.", page: '/docs/ui/', anchor: 'the-briefing' },
  setup: { title: 'the setup wizard', text: 'Seven short screens: an optional AI agent that then explains each step in a guide beside it, your tools, and a Toil project. It makes the same changes as Settings, starts every link read-only, never shows the guide a login, and you can skip any step.', page: '/docs/ui/', anchor: 'the-setup-wizard' },
  'first-run': { title: 'getting started', text: "Each step ticks itself off from toil's own state: a connection to a tracker (one made by env vars counts), a Toil project, and a first sync. The list goes once the first sync finishes.", page: '/docs/ui/', anchor: 'first-run' },
  sync: { title: 'syncing', text: 'A sync reads every Toil project through toil, read-only, and keeps what it read in a cache on this machine. Every view reads that cache, so opening one asks no tracker anything, and Jira and Azure DevOps items closed more than the read window ago (the retention period, at least six weeks) are not read.', page: '/docs/ui/', anchor: 'sync-and-the-cache' },
  'sample-data': { title: 'the sample data', text: 'Sample Toil projects, a whole sample team among them, and a scripted agent, with nothing connected to a tracker, to look around first. From a first start, Look around with a sample team opens them without changing anything.', page: '/docs/ui/', anchor: 'start-it' },
  palette: { title: 'the command palette', text: 'Jumps to a Toil project, a tab or a page a step in from one (the board, what blocks what, code reviews), an item in any Toil project, a saved analysis, a setting or a theme, and runs Sync, Analyze and Ask. Items are searched in the cache, never live.', page: '/docs/ui/', anchor: 'the-command-palette' },
  alignments: { title: 'rolled alignments', text: "Each card's alignment is rolled from its name alone, for play, so it says nothing about anyone or their work. Only good and neutral ones are on the list, and themed wording off removes them.", page: '/docs/themes/', anchor: 'rolled-alignments' },
  'rest-days': { title: 'rest days', text: 'A past day with nothing on its page, or no page at all, is a rest: a small camp fire for a short rest on a weekday, a larger one for a long rest at the weekend.', page: '/docs/themes/', anchor: 'rest-days' },
  motion: { title: 'motion and effects', text: "Full plays the theme's animations and particles, Full, no effects leaves its particles off, Subtle plays shorter, smaller animations, and Off stops everything, in this browser. Your system's reduced-motion setting stops them whichever way this is set.", page: '/docs/themes/', anchor: 'motion-and-particles' },
  'simple-marks': { title: 'simple chart marks', text: "Each series on a chart has a colour and a border style, and in the decorative themes a picture frame. With this on, charts use the plain border instead, kept in this browser only.", page: '/docs/themes/', anchor: 'chart-marks' },
  // Toil tips (#419) link here, as well as the (i) beside their settings.
  board: { title: 'the board', text: 'A step in from the Summary or Tickets, with one column per status category, across every tracker, each card with its own status word. Drag a card to another column, or open its menu with a right-click, a long press or M, to move it; where changes are off, the move stays a proposal until you apply it.', page: '/docs/ui/', anchor: 'the-board' },
  analyses: { title: 'earlier briefings', text: "Every briefing kept for this Toil project, newest first; the newest is the one on the Summary. Each one shows what changed since the one before, worked out by code from its snapshot.", page: '/docs/ui/', anchor: 'the-toil-project-page' },
  notifications: { title: 'notifications', text: "A notice when an agent's state changes, never for a tool call. Which states notify, quiet hours and only your own are under Settings, General.", page: '/docs/ui/', anchor: 'notifications' },
  // The bell (#417).
  'notification-history': { title: 'the notification history', text: "The last 50 notices and sync results, kept in this browser and sent nowhere, each linking to what it's about. Mark all read clears the count and keeps them.", page: '/docs/ui/', anchor: 'notification-history' },
  'theme-motion': { title: 'theme motion', text: "How much the theme's splash, loading screens, entrances and moments move: full, subtle or off. Off whenever reduced motion is asked for.", page: '/docs/themes/', anchor: 'theme-moments' },
  tips: { title: 'toil tips', text: 'One line about toil on each loading screen, in plain words, each with a Read more link. Turn them off here; the choice is kept in this browser.', page: '/docs/themes/', anchor: 'toil-tips' },
  classify: { title: 'sorting work into categories', text: 'Lists the items nobody has put in a category, and the ones where a label and a rule disagree. Your answers are saved in your own record; the tracker changes only when you apply them, after seeing every change.', page: '/docs/ui/', anchor: 'sort-work-into-categories' },
  'classify-ask': { title: 'asking your AI agent', text: "Your AI agent reads the items nobody has settled and marks a suggested category on each, with its reason: press the mark to accept it, or another category to overrule it. It can't change anything.", page: '/docs/ui/', anchor: 'sort-work-into-categories' },
  'classify-improve': { title: 'improving the categories', text: 'Your AI agent reads your corrections, proposes a sharper version of the categories, and tries it on answers it has not seen. Nothing changes until you use it.', page: '/docs/ui/', anchor: 'how-its-doing' },
  'classify-doing': { title: 'how the categories are doing', text: 'Counts how often people agreed with the answers they checked, and which source they overrule most. A figure nobody has read yet is a dash, never 0%.', page: '/docs/ui/', anchor: 'how-its-doing' },
  'classification-editor': { title: 'the categories editor', text: 'Edits the categories, rules and guidance a Toil project sorts its work by. A rule shows how many items it would catch, and saving makes a new revision.', page: '/docs/ui/', anchor: 'the-classification-editor' },
} as const satisfies Record<string, HelpTopic>;

export type HelpTopicId = keyof typeof HELP;

export const helpHref = (topic: HelpTopic): string => `${DOCS_SITE}${topic.page}#${topic.anchor}`;

/** The header's Help entry: the docs section for the view in front of you. */
export type HelpView = 'toilProjects' | 'dashboard' | 'prs' | 'people' | 'charts' | 'command-center' | 'classify' | 'worklog' | 'standup' | 'briefings' | 'item' | 'assignment' | 'job' | 'diagram' | 'settings' | 'setup' | 'newProject';
const VIEW_TOPIC: Record<HelpView, HelpTopicId> = {
  toilProjects: 'toilProjects',
  dashboard: 'dashboard',
  prs: 'prs',
  people: 'people',
  charts: 'charts',
  'command-center': 'readiness',
  classify: 'classify',
  worklog: 'worklog',
  standup: 'standup',
  briefings: 'analyses',
  item: 'readiness',
  assignment: 'assignments',
  job: 'jobs',
  diagram: 'diagram',
  settings: 'settings',
  setup: 'setup',
  newProject: 'toil-project-setup',
};
/** Settings pages whose section isn't the settings overview. */
const SETTINGS_TOPIC: Record<string, HelpTopicId> = { appearance: 'themed-wording', agent: 'agent', usage: 'audit', projects: 'toil-project-setup', connections: 'connections' };

export function viewHelpHref(view: HelpView, settingsPage?: string): string {
  const id = view === 'settings' && settingsPage ? (SETTINGS_TOPIC[settingsPage] ?? 'settings') : VIEW_TOPIC[view];
  return helpHref(HELP[id]);
}
