/**
 * The help topics (#346): every (i) in Toil UI and every Read more link it
 * opens, defined once. A topic is one or two sentences and the exact docs
 * section that says the rest, on the site: `/docs/` for toil's own concepts
 * (connections, dossiers, writes, the audit log) and `/docs/ui/` and
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
export type DocsPage = '/docs/ui/' | '/docs/themes/' | '/docs/core/' | '/docs/dossiers/';

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
  dossiers: { title: 'dossiers', text: 'A dossier names the repositories, tracker, pipelines and environments of one body of work. Each card is read from the cache a sync filled, so opening this page asks no tracker anything.', plainNote: 'On the command line, a Toil project is called a dossier.', page: '/docs/ui/', anchor: 'the-dossiers-view' },
  dashboard: { title: 'this dashboard', text: "Every panel is read through toil, read-only, and says which commands fed it. A call that failed shows on its own panel with toil's message and fix.", page: '/docs/ui/', anchor: 'what-it-reads' },
  briefing: { title: 'the briefing', text: "The latest Analyze's briefing when it is current, saying who wrote it and when; otherwise toil's briefing by code, with no agent call. Each item sits under one reason, and anything the code flagged that Analyze left unmentioned is listed one step in.", page: '/docs/ui/', anchor: 'the-briefing' },
  'analyze-settings': { title: 'how Analyze briefs a dossier', text: "Each dossier sets its goal, its reader, its lenses in order with their thresholds, and what to watch for or leave out, while toil's rules and the answer's shape stay fixed. Clearing a setting is a delete, made in a terminal with toil dossiers analyze set --clear or --reset.", page: '/docs/ui/', anchor: 'tuning-analyze' },
  insights: { title: 'flagged cards and insights', text: 'A flagged card needs action now or a look: it is blocked, its build fails, it is aging or stale. An insight is something about an item that deserves a look, weightiest first, and each names the field, history or command it rests on.', page: '/docs/ui/', anchor: 'insights' },
  prs: { title: 'pull requests', text: "Read from every code host the dossier names, the open ones ranked by how long each has waited and on what. Flow figures are the team's, never one person's.", page: '/docs/ui/', anchor: 'pull-requests' },
  jobs: { title: 'jobs', text: 'A workflow page from toil, run by the agent: it reads through toil and turns every write into a proposal for you.', page: '/docs/ui/', anchor: 'pull-requests' },
  people: { title: 'the People view', text: "What is on each person's plate, from the dossier's people section and the same items and pull requests as the dashboard. It never ranks or scores anyone.", page: '/docs/ui/', anchor: 'people' },
  readiness: { title: 'the Command Center', text: 'Each verdict is worked out from the cached records, with no model call and no live read. Only ready items are slated, in the dossier\'s order.', page: '/docs/ui/', anchor: 'readiness-and-the-command-center' },
  worklog: { title: 'the worklog', text: "One page a day, folded by code from the sync, the pull requests, the builds and the agent's runs: facts only, each line linked to where it came from. Days and times are UTC.", page: '/docs/ui/', anchor: 'worklog' },
  standup: { title: 'the stand-up', text: 'Built by code from the worklog\'s days, facts only, so the same days always give the same report. Days and times are UTC.', page: '/docs/ui/', anchor: 'stand-up' },
  proposal: { title: 'the write gate', text: "Nothing changes until you run the command yourself. toil's write gate then needs writes on for the connection and --allow-write on the call.", page: '/docs/core/', anchor: 'writes' },
  settings: { title: "toil's configuration", text: "Changes run toil's own connections and dossiers commands, never an edit to a file, and each is in toil's audit log as toil-ui. Nothing here writes to a tracker.", plainNote: "Every change goes through toil's own checks, the same as on the command line (toil connections, toil dossiers).", page: '/docs/ui/', anchor: 'toils-configuration' },
  connections: { title: 'connections', text: 'A connection is one instance of an area: its host, its credential and whether writes are on. toil connections list never returns a secret, which stays in the OS credential store.', page: '/docs/core/', anchor: 'configuration' },
  'dossier-setup': { title: 'dossier setup', text: "Each form runs one toil dossiers command, which checks the file before writing it and refuses to add what's already there unless you tick Replace. A dossier holds no secret and can't turn writes on.", page: '/docs/dossiers/', anchor: 'create-check-use-share' },
  'dossier-list': { title: 'where dossiers come from', text: 'Your own dossiers, any folders you listed, and the ones a repository checks in. Check finds problems without contacting any service.', page: '/docs/dossiers/', anchor: 'where-dossiers-live' },
  'repo-setup': { title: 'setting up a repo', text: 'For a repository with a dossier checked in: which of your connections each area would use, the ones still missing, and one test read through each. It changes nothing.', page: '/docs/dossiers/', anchor: 'onboarding-to-a-repo-that-has-a-dossier' },
  bounds: { title: 'bounds and the time limit', text: "toil has no command to change these, and Toil UI never edits toil's files, so they're shown as toil reports them. Only your own config file can relax a bound, and only the file workspace.", page: '/docs/core/', anchor: 'files-and-the-workspace' },
  audit: { title: 'usage of toil', text: "From toil audit stats, which reads only toil's audit log on this machine and sends it nowhere. It counts the command, how it was called and how it ended, never what a call was given or got back.", page: '/docs/core/', anchor: 'the-audit-log' },
  'audit-failures': { title: 'failures', text: "The log keeps each failure's error code, never its message, so the fix shown is the one that usually applies to that code.", page: '/docs/core/', anchor: 'the-audit-log' },
  'model-usage': { title: "the agent's usage", text: "Figures the Claude, Codex and Copilot SDKs reported, kept only in Toil UI's local cache and sent nowhere. A figure an SDK didn't report reads not reported; your vendor's bill is the authority.", page: '/docs/ui/', anchor: 'what-the-agents-models-used', glossary: [{ term: 'Token', slug: 'token', text: 'The atomic unit a model reads and writes.' }, { term: 'Input tokens', slug: 'input-tokens', text: 'Tokens the harness sends on each model provider request.' }, { term: 'Output tokens', slug: 'output-tokens', text: 'Tokens the model generates back.' }, { term: 'Cache tokens', slug: 'cache-tokens', text: 'Input tokens the provider has cached from a previous request via its prefix cache, billed at a much lower rate.' }] },
  caps: { title: 'caps', text: 'At 80% the chat says so; at 100% the question stops, naming the cap. A cap counts only what the SDK reports, so it guards against a runaway and is not a budget.', page: '/docs/ui/', anchor: 'what-the-agents-models-used', glossary: [{ term: 'Context window', slug: 'context-window', text: 'Everything the model sees on each model provider request.' }, { term: 'Effort', slug: 'effort', text: 'A dial for how much reasoning the model does before it answers.' }] },
  agent: { title: 'the agent', text: "The agent your organization already approved answers in the chat, on your own subscription, and only reads, starting the chat on the agent last used for the dossier, else the default chosen here, else the first agent that's ready; the settings are Toil UI's own, kept in its data folder, never in toil's config.", page: '/docs/ui/', anchor: 'the-agent', glossary: [{ term: 'Model', slug: 'model', text: 'The parameters. Stateless — does next-token prediction and nothing else.' }, { term: 'Model provider', slug: 'model-provider', text: 'Whatever serves a model for inference.' }, { term: 'Harness', slug: 'harness', text: 'Everything around the model that turns it into an agent: tools, system prompt, context-window management, permissions, hooks.' }, { term: 'MCP', slug: 'mcp', text: 'A protocol for plugging external tool servers into a harness — how an agent gets tools beyond what the harness ships with.' }, { term: 'Tool call', slug: 'tool-call', text: "The model's output naming a tool and its arguments — just structured text." }] },
  assignments: { title: 'assigning work to an agent', text: 'An assignment runs on your adapter, within your time limit and usage caps. Nothing it proposes leaves this machine until you apply it through toil\'s write gate.', page: '/docs/ui/', anchor: 'assigning-work-to-an-agent', glossary: [{ term: 'Sandbox', slug: 'sandbox', text: 'An isolated environment the agent runs inside — container, VM, or restricted shell.' }, { term: 'Permission mode', slug: 'permission-mode', text: 'The permission-gating slice of an agent mode — which tool calls trigger a permission request and which run automatically.' }, { term: 'Human-in-the-loop', slug: 'human-in-the-loop', text: 'A working pattern where one or more humans pair with the agent during a session — reviewing, redirecting, or collaborating in real time.' }, { term: 'Human review', slug: 'human-review', text: 'The user reading the code the agent produced and forming a judgement on it.' }] },
  stale: { title: 'stale sessions', text: 'A chat or an assignment works from the instructions it started on. When toil, the dossier or your instructions change, it says which, and renews on request.', page: '/docs/ui/', anchor: 'stale-sessions', glossary: [{ term: 'Session', slug: 'session', text: 'One bounded run of interaction with an agent.' }, { term: 'System prompt', slug: 'system-prompt', text: "The instructions the harness prepends to every model provider request — the agent's standing brief." }, { term: 'Skill', slug: 'skill', text: 'A teachable capability bundled as a unit — kept out of the context window until a context pointer pulls it in for the task at hand.' }] },
  answers: { title: 'these answers', text: "The agent reads through toil and cites each item it used, and an id its tools never returned is named above the answer. Analyze answers top-down: a recommendation, the issues behind it, then the evidence.", page: '/docs/ui/', anchor: 'the-agent', glossary: [{ term: 'Hallucination', slug: 'hallucination', text: 'Confidently-wrong model output.' }, { term: 'Primary source', slug: 'primary-source', text: 'The thing itself — code, transcripts, raw data.' }, { term: 'Non-determinism', slug: 'non-determinism', text: 'The same input can produce different output.' }] },
  'themed-wording': { title: 'themed wording', text: "The theme's own lede, eyebrows, notes, empty states and loading lines, and its names for a sprint, a board or an epic beside the real ones. Buttons, links, figures, ids, commands and errors always read the same.", page: '/docs/themes/', anchor: 'visuals-wording-and-voice' },
  'themed-voice': { title: 'themed agent voice', text: "The agent answers in the theme's register. It changes phrasing only: citations, figures and proposals stay exact.", page: '/docs/themes/', anchor: 'the-checkboxes' },
  'plain-words': { title: 'plain words', text: "Renames toil's jargon in tabs, headings and copy as everyday words, with the exact term on hover, and leaves facts, numbers, commands and errors as they are. It is on until you turn it off, and the choice is kept in this browser.", page: '/docs/ui/', anchor: 'plain-words' },
  status: { title: 'the status word and how sure', text: "On track, At risk and Behind are an estimate from the pace so far, worked out by code with no model, and the page shows the sums. How sure is a word and one reason: whether every read worked, how old the data is, and how many items there are to go on.", page: '/docs/ui/', anchor: 'the-briefing' },
  'first-run': { title: 'getting started', text: "Each step ticks itself off from toil's own state: a connection to a tracker (one made by env vars counts), a dossier, and a first sync. The list goes once the first sync finishes.", page: '/docs/ui/', anchor: 'first-run' },
  sync: { title: 'syncing', text: 'A sync reads every dossier through toil, read-only, and keeps what it read in a cache on this machine. Every view reads that cache, so opening one asks no tracker anything, and Jira and Azure DevOps items closed more than the read window ago (the retention period, at least six weeks) are not read.', page: '/docs/ui/', anchor: 'sync-and-the-cache' },
  'sample-data': { title: 'the sample data', text: 'Sample dossiers and a scripted agent, with nothing connected to a tracker. Stop this Toil UI with Ctrl+C and start it again with this command to look around first.', page: '/docs/ui/', anchor: 'start-it' },
  palette: { title: 'the command palette', text: 'Jumps to a dossier, a tab, an item in any dossier, a saved analysis, a setting or a theme, and runs Sync, Analyze and Ask. Items are searched in the cache, never live.', page: '/docs/ui/', anchor: 'the-command-palette' },
  alignments: { title: 'rolled alignments', text: "Each card's alignment is rolled from its name alone, for play, so it says nothing about anyone or their work. Only good and neutral ones are on the list, and themed wording off removes them.", page: '/docs/themes/', anchor: 'rolled-alignments' },
  'rest-days': { title: 'rest days', text: 'A past day with nothing on its page, or no page at all, is a rest: a small camp fire for a short rest on a weekday, a larger one for a long rest at the weekend.', page: '/docs/themes/', anchor: 'rest-days' },
  motion: { title: 'motion and effects', text: "Reduce motion stops the themes' animations and particles in this browser. Your system's reduced-motion setting stops them whichever way this is set.", page: '/docs/themes/', anchor: 'motion-and-particles' },
  // Toil tips (#419) link here, as well as the (i) beside their settings.
  board: { title: 'the board', text: 'One column per status category, across every tracker, each card with its own status word. Drag a card to another column, or open its menu with a right-click, a long press or M, to propose a move: nothing changes until someone applies it with toil.', page: '/docs/ui/', anchor: 'the-board' },
  analyses: { title: 'the Analyses tab', text: "Analyze asks the agent for a pulse check, top-down: a recommendation, the issues behind it, then the evidence. Each one is kept here with what changed since the one before, worked out by code from each one's snapshot.", page: '/docs/ui/', anchor: 'the-dossier-page' },
  notifications: { title: 'notifications', text: "A notice when an agent's state changes, never for a tool call. Which states notify, quiet hours and only your own are under Settings, General.", page: '/docs/ui/', anchor: 'notifications' },
  // The bell (#417).
  'notification-history': { title: 'the notification history', text: "The last 50 notices and sync results, kept in this browser and sent nowhere, each linking to what it's about. Mark all read clears the count and keeps them.", page: '/docs/ui/', anchor: 'notification-history' },
  'theme-motion': { title: 'theme motion', text: "How much the theme's splash, loading screens, entrances and moments move: full, subtle or off. Off whenever reduced motion is asked for.", page: '/docs/themes/', anchor: 'theme-moments' },
  tips: { title: 'toil tips', text: 'One line about toil on each loading screen, in plain words, each with a Read more link. Turn them off here; the choice is kept in this browser.', page: '/docs/themes/', anchor: 'toil-tips' },
} as const satisfies Record<string, HelpTopic>;

export type HelpTopicId = keyof typeof HELP;

export const helpHref = (topic: HelpTopic): string => `${DOCS_SITE}${topic.page}#${topic.anchor}`;

/** The header's Help entry: the docs section for the view in front of you. */
export type HelpView = 'dossiers' | 'dashboard' | 'prs' | 'people' | 'command-center' | 'worklog' | 'standup' | 'item' | 'assignment' | 'job' | 'settings';
const VIEW_TOPIC: Record<HelpView, HelpTopicId> = {
  dossiers: 'dossiers',
  dashboard: 'dashboard',
  prs: 'prs',
  people: 'people',
  'command-center': 'readiness',
  worklog: 'worklog',
  standup: 'standup',
  item: 'readiness',
  assignment: 'assignments',
  job: 'jobs',
  settings: 'settings',
};
/** Settings pages whose section isn't the settings overview. */
const SETTINGS_TOPIC: Record<string, HelpTopicId> = { 'agent-usage': 'model-usage', agent: 'agent', usage: 'audit', dossiers: 'dossier-setup', connections: 'connections' };

export function viewHelpHref(view: HelpView, settingsPage?: string): string {
  const id = view === 'settings' && settingsPage ? (SETTINGS_TOPIC[settingsPage] ?? 'settings') : VIEW_TOPIC[view];
  return helpHref(HELP[id]);
}
