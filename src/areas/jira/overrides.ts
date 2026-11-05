import type { DeploymentOverride } from '../../core/deployments.js';

/**
 * Where Data Center and Cloud say a command differently, said once for both.
 * Both are in the one description an agent reads to choose a tool, because an
 * agent that is told only half of it will use the half it was told on the other.
 * Two statements of one fact need a third to reconcile them; this is the third,
 * and it has been reviewed by neither of the first two.
 */
const ASSIGNEE = 'Assignee: a username on Data Center, an accountId on Cloud (find one with jira user search)';

export const overrides: Record<string, DeploymentOverride> = {
  'jira issue get': {
    toolDescription:
      "Returns one Jira issue by key: every field as Jira returns it, with registered custom fields under their friendly names. On Cloud the description is Atlassian Document Format and descriptionText is it as plain text. With a list of up to 100 keys it returns { issues, errors } instead: the issues in the order asked, and each key that couldn't be read with its code and message. Use jira_issue_search to find issues by JQL instead.",
  },
  'jira issue history': {
    toolDescription:
      "Returns a Jira issue's change history as Jira records it: each entry with id, author (a username on Data Center, an accountId on Cloud), created and items (field, fieldtype, from, fromString, to, toString, and fieldId on Cloud), so status transitions and field changes can be replayed. Without limit it returns every entry; with limit, pass meta.page.nextCursor as cursor for the next page.",
  },
  'jira issue create': {
    toolDescription:
      'Creates a Jira issue and returns it as Jira stores it (on Cloud, plus descriptionText, the description as plain text). Project, issue type and priority fall back to the connection defaults. On Cloud, description is plain text sent as ADF paragraphs (Markdown is not interpreted) and assignee is an accountId; on Data Center assignee is a username. Custom fields go in field ("Name=value"). Does not check for duplicates: after a timeout, search for the summary before retrying.',
    describe: { assignee: ASSIGNEE, description: 'Issue description. Cloud: plain text, blank lines separate paragraphs, sent as ADF' },
    flags: { assignee: '--assignee <user>' },
  },
  'jira issue update': {
    toolDescription:
      'Changes fields on an existing Jira issue and returns { updated: key }. Only the fields you pass are sent. assignee is a username on Data Center and an accountId on Cloud, where description is plain text sent as ADF. labels replaces every label: to add or remove single labels use jira_issue_label or jira_issue_unlabel, and to change status use jira_issue_transition.',
    describe: { assignee: ASSIGNEE, description: 'New description. Cloud: plain text, sent as ADF' },
    flags: { assignee: '--assignee <user>' },
  },
  'jira issue transition': {
    toolDescription:
      "Moves a Jira issue through its workflow. Give to with an intent (start, review, done, reopen) or a status name, and toil resolves it against the transitions this issue offers right now, by its own issue type's workflow: a pin in the toil project first, then an exact status name, then the intent's status category, then a single transition named for it. No match, or more than one, is refused with the transitions the issue does offer; meta.transition says what it resolved to. Or give transition with a transition name (case-insensitive) or id. Use jira_issue_transitions to see the transitions.",
  },
  'jira issue comment': {
    toolDescription: 'Adds a comment to a Jira issue and returns the comment Jira created. On Cloud the body is plain text sent as ADF paragraphs (Markdown is not interpreted), and the result adds bodyText, the body as plain text.',
    describe: { body: 'Comment text: Jira wiki markup on Data Center; plain text on Cloud, where blank lines separate paragraphs' },
  },
  'jira issue log-work': {
    toolDescription:
      'Logs time against a Jira issue and returns the worklog Jira created (on Cloud, plus commentText, the comment as plain text). timeSpent uses Jira durations ("2h 30m", "1d"). started is optional on Data Center, where it defaults to now, and required on Cloud. On Cloud, comment is plain text sent as ADF.',
    describe: {
      started: 'When the work started, e.g. 2026-01-15T09:00:00.000+0000. Optional on Data Center (defaults to now); required on Cloud',
      comment: 'Worklog comment. Cloud: plain text, sent as ADF',
    },
  },
  'jira issue comments': {
    toolDescription:
      'Returns the comments on a Jira issue, oldest first (on Cloud, each with its ADF body and bodyText, the body as plain text). Without limit it returns every comment; with limit, pass meta.page.nextCursor as cursor for the next page.',
  },
  'jira issue assign': {
    description: 'Assign a Jira issue to a user (a username on Data Center, an accountId on Cloud)',
    toolDescription: 'Assigns a Jira issue to a user: a username on Data Center, an accountId on Cloud (find one with jira_user_search). Returns { assigned, assignee }.',
    describe: { assignee: ASSIGNEE },
    flags: { assignee: '--assignee <user>' },
  },
  'jira issue search': {
    toolDescription:
      'Searches Jira issues with JQL. Data Center returns { issues, total, startAt, maxResults }; Cloud returns { issues, maxResults, isLast } and reports no total (maxResults is how many came back, isLast whether that was everything). Without limit it pages through every match, so bound broad queries. With limit, pass meta.page.nextCursor as cursor to get the next page (Data Center also takes startAt). updatedSince adds updated >= that instant to the JQL, in the time zone of your Jira profile. Use jira_issue_get for one issue by key.',
    describe: { cursor: 'meta.page.nextCursor from the previous page, to carry on from there. Data Center: the same as startAt. Cloud: needs limit' },
  },
  'jira issue download': {
    toolDescription:
      'Saves one attachment from a Jira issue to a local directory (default .toil in the working directory) and returns { saved, filename, size }. Get the id from jira_issue_attachments. Never replaces an existing file.',
  },
  'jira board list': {
    describe: { project: 'Project key (or id on Cloud)' },
  },
  'jira check-toil-project': {
    toolDescription:
      'Checks the Jira sections of the toil project that applies to this call (or the one named in toil project) against Jira: each project key it names exists, and each field alias points at a field id Jira has. Returns ok and one check per value, with its key path; the CLI exits 1 when one is missing. Read only.',
  },
};
