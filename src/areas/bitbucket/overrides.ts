import type { DeploymentOverride } from '../../core/deployments.js';

/**
 * Where Data Center and Cloud say a command differently, said once for both.
 * Both are in the one description an agent reads to choose a tool, because an
 * agent that is told only half of it will use the half it was told on the other.
 * Two statements of one fact need a third to reconcile them; this is the third,
 * and it has been reviewed by neither of the first two.
 */
const REVIEWERS = 'Comma-separated reviewers: usernames on Data Center, account ids or {uuid}s on Cloud';
const MARKDOWN = (text: string) => `${text} (Markdown on Cloud)`;

export const overrides: Record<string, DeploymentOverride> = {
  'bitbucket repo create': {
    description: 'Create a new repository in a project (Data Center) or a workspace (Cloud)',
    toolDescription:
      "Creates a git repository and returns it as Bitbucket stores it. On Data Center it needs only the project, not a repo. On Cloud it is created private in the workspace (public with public true); project, if given, puts it in that project of the workspace, and without it Bitbucket uses the workspace's oldest project. name becomes the repository slug.",
  },
  'bitbucket pr list': {
    toolDescription:
      'Lists the pull requests in a repository in one state (OPEN by default). Data Center: optionally by author or reviewer username, by creation date and by last update (updatedSince); Bitbucket has no date filter there, so the dates are applied to each page as it is read. Cloud: ALL for every state, newest activity first as Bitbucket orders them; query is a Bitbucket query (author.account_id = "…", source.branch.name = "…"), and updatedSince is sent to Bitbucket as updated_on >= <instant> in the query. Without limit every page is read; with limit, pass meta.page.nextCursor as cursor for the next page.',
    describe: {
      state: 'PR state: OPEN|MERGED|DECLINED|ALL (default: OPEN); Cloud also has SUPERSEDED',
      updatedSince: 'Only PRs updated on/after this instant: an ISO 8601 date (2026-10-01, midnight UTC on Cloud) or, on Cloud, a date and time with a zone (2026-10-01T09:30:00Z)',
    },
  },
  'bitbucket pr get': {
    toolDescription:
      'Returns one pull request by ID: title, description, state, author, reviewers and their status, source and target branches, and links (on Data Center also its version, on Cloud the participants with their approval state). include adds an `included` object holding only the lists asked for, each as Bitbucket returns them: reviews (Data Center: the APPROVED, UNAPPROVED and REVIEWED activities, where REVIEWED is needs-work; Cloud: the activity entries holding an approval or changes_requested), checks (the build statuses, as pr builds reads them; one page of the newest commit on Data Center), commits, and files (the changes; on Cloud the diffstat entries with lines_added and lines_removed). Every page is read except for checks on Data Center. Each list costs more requests.',
  },
  'bitbucket pr create': {
    toolDescription:
      "Opens a pull request from source to target and returns it. target defaults to the connection's targetBranch, then main, on Data Center, and to the repository's main branch on Cloud. reviewers are comma-separated usernames on Data Center and Atlassian account ids (or {uuid}s in braces) on Cloud; without them, the repository's default reviewers apply. On Data Center, for a personal repository the project is ~username. On Cloud, closeSourceBranch deletes the source branch when it merges, and draft opens a draft.",
    describe: {
      target: "Target branch (Data Center: the connection's targetBranch, then main; Cloud: the repository's main branch)",
      description: MARKDOWN('PR description'),
      reviewers: REVIEWERS,
    },
    flags: { reviewers: '--reviewers <users>' },
  },
  'bitbucket pr update': {
    toolDescription:
      "Changes a pull request's title, description or reviewers (and on Cloud, an open one's target branch) and returns it. Reads the PR first and resends the current values for anything not given, since Bitbucket clears what a PUT leaves out. reviewers replaces the whole list: usernames on Data Center, account ids or {uuid}s on Cloud.",
    describe: {
      description: MARKDOWN('New description'),
      reviewers: `${REVIEWERS}; replaces the list`,
    },
    flags: { reviewers: '--reviewers <users>' },
  },
  'bitbucket pr merge': {
    toolDescription:
      "Merges a pull request and returns it. strategy is Bitbucket's merge strategy id (on Data Center merge, squash or ff; on Cloud one of its six, default the repository's). Data Center merges at the pull request's current version, and deleteBranch does not delete the source branch there: it sets Bitbucket's autoSubject, and a BITBUCKET_BRANCH_NOT_DELETED warning says so. On Cloud deleteBranch deletes the source branch after the merge, message sets the merge commit message, and when Bitbucket queues the merge or takes too long (202), data is { pending: true, taskStatus } with the task-status path to read with bitbucket_api, and a BITBUCKET_CLOUD_MERGE_PENDING warning.",
    describe: {
      strategy: 'Merge strategy. Data Center: merge|squash|ff. Cloud: merge_commit|squash|fast_forward|squash_fast_forward|rebase_fast_forward|rebase_merge',
    },
  },
  'bitbucket pr decline': {
    toolDescription: 'Declines an open pull request (at its current version on Data Center) and returns it.',
  },
  'bitbucket pr current': {
    toolDescription:
      "Returns the open pull request whose source branch is the workspace's current git branch, or null when there is none. On Data Center the repository can also come from the git remote, and with no Bitbucket connection set up it succeeds with a message saying so instead. On Cloud it comes from workspace and repo (or the connection), not from the git remote.",
  },
  'bitbucket pr comments': {
    toolDescription:
      'Lists the comments on a pull request, oldest first, replies included. On Data Center the replies are flattened into the list, each carrying parentId, and withReplies false returns top-level comments only, unsorted, with replies still nested. On Cloud each reply carries parent.id and each inline comment carries inline (path, from, to), and withReplies false keeps top-level comments only. inlineOnly and generalOnly keep only file-anchored or only general comments.',
  },
  'bitbucket pr comment': {
    toolDescription: 'Adds a general comment to a pull request and returns it. Use bitbucket_pr_comment_inline for a comment on a line of a file.',
    describe: { body: MARKDOWN('Comment text') },
  },
  'bitbucket pr comment-inline': {
    toolDescription:
      "Adds a comment on one line of a file in a pull request's diff and returns it. lineType is ADDED (default), REMOVED or CONTEXT. On Data Center the line is always numbered in the new version of the file; on Cloud ADDED and CONTEXT number it in the new version, and REMOVED in the old.",
    describe: { body: MARKDOWN('Comment text') },
  },
  'bitbucket pr reply': {
    describe: { body: MARKDOWN('Reply text') },
  },
  'bitbucket pr resolve': {
    toolDescription:
      "Resolves a comment thread on a pull request, given the thread's root comment ID. Data Center also takes the comment's current version from bitbucket_pr_comments (commentVersion, default 0) and returns { resolved: true }. Cloud returns Bitbucket's resolution record, and a thread that is already resolved is an HTTP 409.",
  },
  'bitbucket pr delete-comment': {
    toolDescription: "Deletes a comment on a pull request and returns { deleted: true }. Data Center deletes it at the comment's current version (commentVersion, default 0).",
  },
  'bitbucket pr diff': {
    description: 'Get the diff of a pull request (on Cloud, or of a commit spec)',
    describe: { id: 'Pull request ID (on Cloud, spec can stand in for it)' },
    toolDescription:
      "Returns { diff } for a pull request: id names it, file limits the diff to one path, and contextLines sets the lines of context. Data Center returns Bitbucket's JSON diff structure (diffs, hunks, segments) serialized to a string, not unified diff text, and always needs id. Cloud returns unified git diff text (the pull request's changes against the target, as Bitbucket shows them) and takes either id or spec: a commit (against its first parent) or a..b.",
  },
  'bitbucket pr files': {
    toolDescription:
      "Lists the files a pull request changes. Data Center lists the changes from one request of up to 1000, each entry the change's path as Bitbucket returns it: a plain string, or else Bitbucket's path object serialized to a JSON string (its toString field holds the path). Cloud lists each change's new path as a string, or its old path for a deletion, reading every page of Bitbucket's diffstat.",
  },
  'bitbucket pr approve': {
    toolDescription: "Approves a pull request as the credential's user and returns Bitbucket's participant record. On Data Center it adds them as a reviewer if they aren't one.",
  },
  'bitbucket pr unapprove': {
    toolDescription: "Withdraws the credential's user's approval of a pull request. Data Center returns Bitbucket's participant record; Cloud returns { unapproved: true }.",
  },
  'bitbucket pr needs-work': {
    description: 'Mark a pull request as needs-work (Cloud: request changes)',
    toolDescription:
      "Marks a pull request as needs-work (Cloud calls it changes requested) for the credential's user and returns Bitbucket's participant record. Data Center allows that only for reviewers, so a user who isn't one is first added as a reviewer; that addition stays even if the status change then fails. On the CLI, request-changes is the same command.",
  },
  'bitbucket pr reviewers': {
    toolDescription:
      "Lists a pull request's reviewers: each one's user and whether they approved. Data Center adds a status (APPROVED, NEEDS_WORK or UNAPPROVED); Cloud lists them as participants with a state (approved, changes_requested or null).",
  },
  'bitbucket repo default-reviewers': {
    description: "List a repository's default reviewers (Data Center: its default-reviewer conditions)",
    toolDescription:
      "Lists a repository's default reviewers. Data Center returns the default-reviewer conditions: which reviewers Bitbucket adds to pull requests between which branches, and how many approvals each condition needs. Cloud returns the users it adds to every new pull request in the repository (the repository's own list, not those inherited from its project).",
  },
  'bitbucket pr builds': {
    toolDescription:
      "Lists the build statuses of a pull request. Data Center reads the newest commit's (one page, at Bitbucket's default size), or [] when it has no commits. Cloud lists every build status reported on the pull request's commits (key, name, state, url, description, created_on, updated_on).",
  },
  'bitbucket commit status': {
    description: 'Get build statuses for a commit SHA',
    toolDescription:
      "Lists the build statuses reported for one commit. Data Center reads one page, at Bitbucket's default size, and still needs a project and repo, though the lookup doesn't use them. Cloud lists every one (key, name, state, url, description, created_on, updated_on).",
  },
  'bitbucket check-toil-project': {
    toolDescription:
      "Checks the Bitbucket sections of the toil project that applies to this call (or the one named in toil project): each project key it names exists, and each repository in its project. Returns ok, one check per value with its key path, and any value that couldn't be checked; the CLI exits 1 when one is missing or unchecked. Read only. Data Center only.",
  },
};
