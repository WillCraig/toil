import type { DeploymentOverride } from '../../core/deployments.js';

/**
 * Where Azure DevOps Server and Services say a command differently, said once for both.
 * An agent reads one description to choose a tool, so it is told both halves, and which
 * deployment each half is about. Two statements of one fact need a third to reconcile
 * them; this is the third, and it has been reviewed by neither of the first two.
 */
const BODY = 'Comment text';

export const overrides: Record<string, DeploymentOverride> = {
  'ado whoami': {
    description: 'Show the authenticated user',
    toolDescription:
      "Returns connectionData: the authenticated user (id, display name), the instance and the deployment. On Server it is the collection's (the same output as ado_connection_data); on Services it is the organization's. authenticatedUser.id is the identity id the vote commands use.",
  },
  'ado project list': {
    description: 'List team projects in a collection (Server) or an organization (Services)',
    toolDescription:
      'Lists every team project in the collection (Server) or organization (Services): id, name, state, visibility, following continuation tokens to the end. With limit, returns at most that many; pass meta.page.nextCursor as cursor for the next page.',
  },
  'ado project get': {
    description: 'Get a team project by name',
    toolDescription: 'Returns one team project in the collection (Server) or organization (Services) by name or id.',
    describe: { name: 'Project name (Services also takes an id)' },
  },
  'ado work-item get': {
    toolDescription: 'Returns one work item by id with every field, its relations and links ($expand=all). Services needs no project for it.',
  },
  'ado work-item create': {
    toolDescription:
      'Creates a work item of a type in the project and returns it as created. Title, description, assignee and priority have flags; any other field goes in field as name=value, by reference name (Microsoft.VSTS.Scheduling.StoryPoints) or alias (storypoints). On Server, with parent, a parent link is added afterwards; if that fails the item still exists, the result is the item as created, and an ADO_PARENT_LINK_FAILED warning says so.',
    describe: {
      type: 'Work item type (e.g. Bug, Task, User Story). Required; on Server, unless supplied via --input-file',
      title: 'Work item title. Required; on Server, unless supplied via --input-file',
      description: 'Description (HTML)',
      assignee: 'Assigned to (display name or email)',
      field: 'Additional field as name=value, by reference name or alias (repeatable)',
    },
  },
  'ado work-item update': {
    description: 'Update work item fields',
    toolDescription:
      'Sets fields on a work item (field as name=value, by reference name or alias: state=Active, Microsoft.VSTS.Scheduling.StoryPoints=5; on Server, or an input file of fields) in one JSON Patch and returns the updated item. On Services, with rev, the change is refused if the item has moved past that revision, and no project is needed.',
    describe: { field: 'Field to set as name=value (repeatable)' },
  },
  'ado work-item transition': {
    toolDescription:
      "Sets System.State on a work item and returns it. Give state with an exact state, or to with an intent (start, review, done, reopen) or a state name, and toil resolves it against the states this item's own type has: a pin in the toil project first, then an exact state name, then the intent's state category (start InProgress, review Resolved, done Completed, reopen Proposed), then a single state named for it. No match, or more than one, is refused with the states the type does have; meta.transition says what it resolved to. Services needs no project for it. ado_work_item_states lists the states a type has.",
  },
  'ado work-item history': {
    toolDescription:
      'Lists every revision of a work item, oldest first: each is the whole work item as it stood after that change (id, rev, fields, url), so comparing neighbours gives the history of states, assignees and other fields. Services needs no project for it. With limit, returns at most that many; pass meta.page.nextCursor as cursor for the next page.',
  },
  'ado work-item get-many': {
    toolDescription:
      "Returns several work items by id through the batch endpoint, 200 per request, at most 1000 ids: { count, value, missing }. value holds the items found, in the order asked, with every field and relation unless fields names the ones to return; missing lists each id that doesn't exist or the token can't see, with an ADO_WORK_ITEMS_MISSING warning. Services needs no project for it.",
  },
  'ado work-item comments': {
    toolDescription:
      "Lists the comments on a work item. Server returns the first page of comments, as the server pages them. Services returns every comment in the server's order (newest first in Microsoft's examples): id, text, createdBy, createdDate, modifiedDate, following continuation tokens to the end; with limit, at most that many, and meta.page.nextCursor as cursor for the next page.",
  },
  'ado work-item comment': {
    toolDescription: 'Adds a comment to a work item and returns it. On Services the text may be HTML or plain text.',
  },
  'ado work-item iterations': {
    description: 'List the iteration tree for the project, with start and finish dates',
    toolDescription: "Returns the project's iteration tree (classification nodes) with start and finish dates, to the given depth (10 by default).",
    describe: { depth: 'Depth of the iteration tree to retrieve (default: 10)' },
  },
  'ado work-item states': {
    toolDescription:
      "Lists the states a work item type has (name, color, category). On Services, in the project's process, in workflow order; category (Proposed, InProgress, Resolved, Completed, Removed) is how a custom state is classified, and a type the project doesn't have returns no states, with an ADO_TYPE_UNKNOWN warning.",
  },
  'ado repo list': {
    toolDescription: 'Lists the git repositories in the project (id, name, default branch, urls). The API returns them in one answer. Needs no repo.',
  },
  'ado repo get': {
    description: 'Get a repository',
  },
  'ado pr list': {
    describe: {
      state: 'PR state: active|abandoned|completed|all (default: active)',
      creator: 'Only PRs created by this identity id (a GUID, from ado whoami)',
      reviewer: 'Only PRs with this reviewer identity id (a GUID, from ado whoami)',
      createdAfter: 'Only PRs created at or after this ISO 8601 date (e.g. 2025-01-31); Services also takes a zoned date-time',
      createdBefore: 'Only PRs created before this ISO 8601 date; Services also takes a zoned date-time',
      updatedSince:
        'Only PRs still active, or created or closed at or after this ISO 8601 date (Azure DevOps records no last-updated time on a pull request); Services also takes a zoned date-time',
    },
    flags: { creator: '--creator <id>', reviewer: '--reviewer <id>' },
    toolDescription:
      'Lists every pull request in the repository in one state (active by default), optionally by creator or reviewer identity id (a GUID, from ado_whoami), and by creation date. updatedSince keeps the pull requests still active plus those created or closed at or after that instant: Azure DevOps records no last-updated time on a pull request, so this is a superset of what changed, safe for a sync that merges by pullRequestId. With limit, returns at most that many (counting kept ones only); pass meta.page.nextCursor as cursor for the next page.',
  },
  'ado pr create': {
    toolDescription:
      'Opens a pull request from a source branch to a target (main by default) and returns it. Give branch names without refs/heads/, which toil adds (Services also takes a full ref, refs/..., and sends it as given). reviewers are identity ids, comma-separated.',
    describe: { target: 'Target branch (default: main)', description: 'PR description (Markdown)', reviewers: 'Comma-separated reviewer identity ids' },
  },
  'ado pr update': {
    toolDescription:
      "Changes a pull request's title, description, draft state and, on Server, reviewers or, on Services, target branch, in one PATCH and returns it. draft is true or false (on Server, any text but \"true\" is false). Services doesn't change reviewers this way; the vote commands set the token's own vote.",
  },
  'ado pr merge': {
    toolDescription:
      'Asks the server to complete a pull request with a merge strategy (noFastForward by default), optionally deleting the source branch, and returns the pull request. Services reads the pull request first, to send the source commit the completion is for. Completion is asynchronous: check data.status (and, on Services, data.mergeStatus), which stay active and queued while policies or conflicts hold it.',
    describe: { strategy: 'Merge strategy: noFastForward|squash|rebase|rebaseMerge (default: noFastForward)' },
  },
  'ado pr unapprove': {
    description: 'Remove your vote from a pull request',
  },
  'ado pr comments': {
    toolDescription:
      'Lists every comment on a pull request, flattened from its threads and sorted by publishedDate, each with threadId and threadContext (null for a general comment). Server includes system comments (votes, status changes). Services leaves out deleted threads and comments, and system comments unless includeSystem. inlineOnly or generalOnly narrows it.',
  },
  'ado pr comment': {
    describe: { body: BODY },
  },
  'ado pr comment-inline': {
    toolDescription:
      'Starts an active thread on one line of a file in a pull request (the right, new side unless lineType is left) and returns the thread. Give the path as the server shows it, with a leading / (Services adds it if you leave it out).',
    describe: { body: BODY, lineType: 'Line side: left|right (default: right)' },
  },
  'ado pr reply': {
    toolDescription: 'Adds a reply to a thread on a pull request and returns the new comment. Thread ids come from ado_pr_comments (or, on Services, ado_pr_threads).',
    describe: { body: 'Reply text' },
  },
  'ado pr resolve': {
    description: 'Mark a comment thread as resolved',
    toolDescription:
      "Sets a pull request thread's status and returns the thread: fixed (resolved) on Server. On Services, fixed (which the web UI shows as resolved) by default, or wontFix, closed, byDesign, pending, or active to reopen it.",
  },
};
