import type { DeploymentOverride } from '../../core/deployments.js';

/**
 * Where Data Center and Cloud say a command differently, said once for both.
 * An agent that reads only the half that fits its own site will use that half
 * on the other, so the one description carries both, and the shapes that differ
 * are named. The two original descriptions are retired with full honours.
 */
const BODY = 'Page body: storage-format XHTML, or wiki markup with --representation wiki. Data Center also takes Markdown with --markdown';
const NEW_BODY = 'New page body: storage-format XHTML, or wiki markup with --representation wiki. Data Center also takes Markdown with --markdown';
const REPRESENTATION = 'Body format: storage (default) or wiki, which Confluence converts to storage';

export const overrides: Record<string, DeploymentOverride> = {
  'confluence page get': {
    description: 'Get a Confluence page by ID, with its storage-format body',
    toolDescription:
      'Returns a Confluence page by id, with its storage-format body. Data Center returns it as the Server REST API does, with the fields named in expand (default body.storage, version, space, ancestors). Cloud returns it as REST API v2 does (title, spaceId, parentId, version, body.storage), plus bodyText, the body as plain text; expand is Data Center only.',
  },
  'confluence page find': {
    description: 'Find a Confluence page by space key and exact title',
  },
  'confluence page list': {
    description: 'List pages in a Confluence space (consider --output-file for large results)',
    toolDescription:
      'Lists the pages in a Confluence space (id, title, version; Cloud adds parentId; no bodies). Without limit it returns every page, which can be large; set limit to bound it. To carry on after a limit, Data Center takes offset and Cloud takes meta.page.nextCursor as cursor.',
  },
  'confluence page children': {
    description: 'Get child pages of a Confluence page',
    toolDescription:
      "Returns a page's direct children. Data Center returns the child pages; Cloud returns id, title, type and status, where type is page for child pages and folders, whiteboards, databases and embeds are listed too.",
  },
  'confluence page history': {
    description: 'Get the version history of a Confluence page',
    toolDescription:
      'Returns the version history of a page, no bodies. Data Center returns the history metadata as the Server REST API does; Cloud returns every version (number, createdAt, authorId, message, minorEdit), newest first as Confluence sorts them.',
  },
  'confluence page search': {
    description: 'Search Confluence with CQL',
    toolDescription:
      "Runs a CQL query and returns Confluence's search result as it came (results, each with content, title and excerpt). One page: on Data Center raise limit or advance offset for more; on Cloud pass meta.page.nextCursor as cursor for the next.",
    describe: {
      limit: 'Maximum number of results (default: 25)',
      expand: 'Comma-separated fields to expand (Data Center e.g. space,version; Cloud e.g. content.space,content.version)',
    },
  },
  'confluence page create': {
    description: 'Create a new Confluence page',
    toolDescription:
      'Creates a page in a space, optionally under a parent page, and returns the page Confluence created. The body is storage-format XHTML, or wiki markup with representation wiki; Data Center can also convert Markdown (markdown). On Cloud the page is published, goes under the space homepage without parentId, and the result adds bodyText, the body as plain text.',
    describe: { body: BODY, representation: REPRESENTATION },
  },
  'confluence page update': {
    description: 'Update a Confluence page (fetches the current version automatically)',
    toolDescription:
      "Updates a page's title, body or status. Reads the current version first and sends the next one, keeping the title unless one is given. With no body, Data Center sends none; Cloud, which requires one on every update, sends the current body back unchanged. On Cloud, status draft turns the page into a draft and deletes any draft it already has.",
    describe: {
      body: NEW_BODY,
      representation: REPRESENTATION,
      status: 'Page status: current (default) or draft. On Cloud, draft deletes any draft the page already has',
    },
  },
  'confluence page delete': {
    description: 'Delete a Confluence page (on Cloud it goes to the trash and is not purged)',
  },
  'confluence page comments': {
    description: 'List comments on a Confluence page',
    toolDescription:
      'Returns the top-level comments on a page, each with its storage-format body and version (on Cloud, the footer comments, plus bodyText, the body as plain text). Replies are not included, nor are inline comments.',
  },
  'confluence page comment': {
    description: 'Add a comment to a Confluence page (a footer comment on Cloud)',
    describe: { body: 'Comment body (storage-format XHTML, or wiki markup with --representation wiki)', representation: 'Body format: storage (default) or wiki' },
  },
  'confluence page labels': { description: 'Get labels on a Confluence page' },
  'confluence page label': { description: 'Add labels to a Confluence page' },
  'confluence page unlabel': { description: 'Remove a label from a Confluence page' },
  'confluence space list': {
    description: 'List Confluence spaces',
    toolDescription:
      'Lists the Confluence spaces this account can see. Without limit it returns every space; with limit, Cloud takes meta.page.nextCursor as cursor for the next page (Cloud returns id, key, name, type and status).',
    describe: { type: 'Space type: global or personal' },
  },
  'confluence space get': { description: 'Get a Confluence space by key' },
  'confluence page attachments': {
    description: 'List attachments on a Confluence page',
    toolDescription:
      'Returns every attachment on a page (id, title and a download link; Data Center adds metadata, Cloud adds mediaType and fileSize). Use confluence_attachment_download with an id to save one.',
  },
  'confluence page attach': {
    description: 'Upload a file as an attachment to a Confluence page',
    toolDescription:
      'Uploads a local file to a page as a new attachment and returns what Confluence created. inputFile is a path inside the workspace. A file name already on the page is not versioned: Data Center does not version it, and Cloud refuses it.',
  },
  'confluence attachment download': {
    description: 'Download a Confluence attachment to .toil/ (or --dir)',
    toolDescription:
      'Saves one Confluence attachment to a directory inside the workspace (default .toil) and returns { saved, filename, size }. Never replaces an existing file. Get the id from confluence_page_attachments.',
    describe: { dir: 'Output directory (default: .toil in the workspace)' },
  },
  'confluence attachment delete': {
    description: 'Delete a Confluence attachment by its ID (moves it to the trash; does not purge it)',
  },
};
