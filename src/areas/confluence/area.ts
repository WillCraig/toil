import { z } from 'zod';
import { defineArea } from '../../core/area.js';
import type { AreaEndpoint } from '../../core/api.js';
import { ToilError } from '../../core/errors.js';
import type { SupportedVersion } from '../../core/supported.js';
import { jiraArea } from '../jira/area.js';

/**
 * Confluence, both deployments in one area: Data Center (`"deployment":
 * "server"`, the default) on the Server REST API under `/rest/api`, and Cloud
 * (`"deployment": "cloud"`) on REST API v2 under `/wiki/api/v2`, with v1 under
 * `/wiki/rest/api` for what v2 doesn't cover (CQL search, adding and removing
 * labels, uploads) (#495). One command tree and one set of MCP tools serve
 * both, and each call goes to the deployment of the connection it resolves.
 * The two disagree on paths, paging and ids, so each keeps its own API code
 * under `server/` and `cloud/` and returns its own API's shape. Cloud was built
 * from Atlassian's documented API with no tested contract; the documentation
 * has signed for the delivery and nobody has opened the box.
 */

/** How an attachment id reads, said once for both deployments' arguments and the override that describes the field. */
export const ATTACHMENT_ID = 'Attachment ID: a content ID on Data Center (98765), an att… ID on Cloud (att98765)';

export const DEPLOYMENTS = ['server', 'cloud'] as const;
export type ConfluenceDeployment = (typeof DEPLOYMENTS)[number];

export const confluenceArea = defineArea({
  name: 'confluence',
  description: 'Confluence Data Center and Confluence Cloud: pages, spaces, CQL search, comments, labels and attachments',
  connection: z.object({
    baseUrl: z.url().describe('Confluence root: the Data Center server (https://confluence.imagile.dev), or the Cloud site without /wiki (https://<your-site>.atlassian.net)'),
    apiToken: z.string().min(1).describe('Data Center: a personal access token. Cloud: an Atlassian account API token'),
    deployment: z.enum(DEPLOYMENTS).default('server').describe('Which Confluence this is: "server" for Data Center (the default), or "cloud" for Confluence Cloud'),
    email: z.string().min(1).optional().describe('Confluence Cloud only: the email address of the Atlassian account the API token belongs to'),
  }),
  secrets: ['apiToken'],
  defaults: { deployment: 'server' },
  choices: {
    deployment: {
      question: 'Which one is it?',
      required: true,
      options: [
        { label: 'Cloud', value: 'cloud', hosts: ['*.atlassian.net'] },
        { label: 'Data Center', value: 'server' },
      ],
    },
    baseUrl: {
      options: [
        { label: 'Your Atlassian site', value: null, when: { deployment: 'cloud' }, compose: { prefix: 'https://', suffix: '.atlassian.net', label: 'Site name', placeholder: 'example-site' } },
        { label: 'Your Confluence server', value: null, when: { deployment: 'server' }, placeholder: 'https://confluence.imagile.dev' },
      ],
    },
  },
  variants: {
    by: 'deployment',
    of: {
      server: { label: 'Data Center' },
      cloud: { label: 'Cloud', requires: ['email'] },
    },
  },
  // The token may be the Jira one: one personal access token per person is, in
  // some organizations, already a generous allocation. The default connection
  // falls back to TOIL_JIRA_API_TOKEN, and only from a Jira of the same
  // deployment: a Data Center token is never lent to the Atlassian cloud, nor a
  // Cloud one to a server. Any connection can name a Jira connection to borrow
  // from with apiTokenFrom, which is the user's call. The email is never borrowed.
  shares: { area: jiraArea, keys: ['apiToken'], fallbackWhen: (jira, own) => String(jira.deployment ?? 'server') === String(own.deployment ?? 'server') },
  examples: { email: 'you@example.com' },
  // The current user; Confluence answers an anonymous caller with a 200 and type "anonymous".
  probe: (connection) => ({
    path: connection.deployment === 'cloud' ? '/wiki/rest/api/user/current' : '/rest/api/user/current',
    accepts: (body) => (body as { type?: unknown } | null)?.type !== 'anonymous',
  }),
  // One hook, two credentials: the deployment on the connection picks which.
  request: (connection, area): AreaEndpoint => {
    if (connection.deployment === 'cloud') {
      // toil adds /wiki itself, so a site URL pasted from the browser's address bar
      // would ask for /wiki/wiki/api/v2 and get a 404 that explains nothing.
      if (/\/wiki\/*$/i.test(new URL(connection.baseUrl).pathname)) {
        throw new ToilError('CONFIG_INVALID', `baseUrl on connection "${connection.name}" ends in /wiki (${connection.baseUrl}); it must be the site root, because toil adds /wiki itself.`, {
          fix: `Drop the trailing /wiki: set baseUrl (${area.envName('baseUrl')} for the default connection) to the site root, https://<your-site>.atlassian.net.`,
        });
      }
      return {
        baseUrl: connection.baseUrl,
        // Basic auth with the account's email and API token, as Atlassian documents
        // for scripts: https://developer.atlassian.com/cloud/confluence/basic-auth-for-rest-apis/
        headers: { Authorization: `Basic ${Buffer.from(`${connection.email}:${connection.apiToken}`).toString('base64')}`, Accept: 'application/json' },
        service: 'Confluence Cloud',
        authFix: `Confluence Cloud rejected the email and API token on connection "${connection.name}". Check that email (${area.envName('email')}) is the Atlassian account's address, create a new API token at https://id.atlassian.com/manage-profile/security/api-tokens, then set apiToken (${area.envName('apiToken')} for the default connection). If the token came from Jira Cloud (meta.context.shared says so), check it belongs to that same email.`,
      };
    }
    return {
      baseUrl: connection.baseUrl,
      headers: { Authorization: `Bearer ${connection.apiToken}` },
      service: 'Confluence',
      authFix: `Confluence rejected the personal access token on connection "${connection.name}". Create a new one under your profile picture → Settings → Personal Access Tokens, then set apiToken (${area.envName('apiToken')} for the default connection). If the token came from Jira (meta.context.shared says so), give Confluence its own.`,
    };
  },
});

/** The floor the Data Center credential sets, no release verified yet; Cloud is always current and says so in the note. The skill file and the site's integration data say the same. */
export const confluenceSupported: SupportedVersion = {
  product: 'Confluence Data Center',
  minimum: '7.9',
  api: 'Server REST API',
  note: 'toil authenticates to Data Center with a personal access token, which Confluence Data Center added in 7.9. No release has been verified yet. Confluence Cloud (a connection with deployment cloud) is always current: toil calls REST API v2 (/wiki/api/v2) and, where v2 has no endpoint, v1 (/wiki/rest/api: CQL search, adding and removing labels, attachment uploads), with an Atlassian account email and API token sent as Basic auth. Nothing has been run against a live Cloud site yet.',
};
