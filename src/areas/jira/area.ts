import { z } from 'zod';
import { defineArea } from '../../core/area.js';
import type { AreaEndpoint } from '../../core/api.js';
import { pathIdSchema } from '../../core/api-path.js';
import type { SupportedVersion } from '../../core/supported.js';

/**
 * Jira, both deployments in one area: Data Center (`"deployment": "server"`,
 * the default) on `/rest/api/2` and the Agile API, and Cloud (`"deployment":
 * "cloud"`) on `/rest/api/3` and the Agile API (#495). One command tree and one
 * set of MCP tools serve both, and each call goes to the deployment of the
 * connection it resolves. The two still disagree on what a user is (a username
 * here, an accountId there) and what a description is (a string, an Atlassian
 * Document Format tree), so each keeps its own API code under `server/` and
 * `cloud/`, and each returns its own API's shape. They share this form.
 */

/** How a `--field` value is shaped for Jira's API. Omitted means the raw string. `multi-user` is Cloud's (accountIds); Data Center refuses it. */
export const CUSTOM_FIELD_TYPES = [
  'string',
  'number',
  'date',
  'datetime',
  'select',
  'multi-select',
  'option-id',
  'cascading-select',
  'user',
  'multi-user',
  'labels',
  'url',
  'textarea',
] as const;

export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export const customFieldSchema = z.object({
  id: z.string().min(1).describe('Jira field id, e.g. customfield_10032'),
  name: z.string().min(1).describe('Friendly name used in --field, --fields-file, --input-file, JQL and output'),
  type: z.enum(CUSTOM_FIELD_TYPES).optional().describe('How a --field value is shaped; omitted sends the raw string'),
  description: z.string().optional(),
  examples: z.array(z.string()).optional(),
});

export type CustomFieldDefinition = z.output<typeof customFieldSchema>;

export const DEPLOYMENTS = ['server', 'cloud'] as const;
export type JiraDeployment = (typeof DEPLOYMENTS)[number];

export const jiraArea = defineArea({
  name: 'jira',
  description: 'Jira Data Center and Jira Cloud: issues, JQL search, transitions, comments, worklogs, attachments, custom fields, projects, users, boards and sprints',
  connection: z.object({
    baseUrl: z.url().describe('Jira root: the Data Center server (https://jira.imagile.dev), or the Cloud site (https://<your-site>.atlassian.net)'),
    apiToken: z.string().min(1).describe('Data Center: a personal access token. Cloud: an Atlassian account API token'),
    deployment: z.enum(DEPLOYMENTS).default('server').describe('Which Jira this is: "server" for Data Center (the default), or "cloud" for Jira Cloud'),
    email: z.string().min(1).optional().describe('Jira Cloud only: the email address of the Atlassian account the API token belongs to'),
    customFields: z.array(customFieldSchema).default([]).describe('Custom fields addressable by friendly name'),
    // Shared defaults, usually set once under defaults.jira for every connection.
    project: z.string().min(1).optional().describe('Default project key for issue create'),
    issueType: z.string().min(1).optional().describe('Default issue type for issue create (Task when unset)'),
    priority: z.string().min(1).optional().describe('Default priority for issue create'),
  }),
  secrets: ['apiToken'],
  defaults: { deployment: 'server' },
  // The deployment decides what the form asks for and how the address is made: a Cloud site is a name, Data Center is a URL.
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
        { label: 'Your Jira server', value: null, when: { deployment: 'server' }, placeholder: 'https://jira.imagile.dev' },
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
  examples: { email: 'you@example.com' },
  context: {
    // Only issue create lists it: the other --project flags never fell back to
    // a configured project, and a context input always would.
    project: {
      scope: 'command',
      flags: '--project <key>',
      description: 'Project key (or "project" in --input-file)',
      setting: 'project',
      // A project key is letters, digits and underscores, and it goes into the
      // createmeta and project paths, so path syntax is refused however it
      // arrives. Empty still passes, so an empty --project gets issue create's own error.
      schema: pathIdSchema('The project key'),
    },
  },
  probe: (connection) => ({ path: connection.deployment === 'cloud' ? '/rest/api/3/myself' : '/rest/api/2/myself' }),
  // One hook, two credentials: the deployment on the connection picks which.
  request: (connection, area): AreaEndpoint => {
    if (connection.deployment === 'cloud') {
      return {
        baseUrl: connection.baseUrl,
        // Basic auth with the account's email and API token, as Atlassian documents
        // for scripts: https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/
        headers: { Authorization: `Basic ${Buffer.from(`${connection.email}:${connection.apiToken}`).toString('base64')}`, Accept: 'application/json' },
        service: 'Jira Cloud',
        authFix: `Jira Cloud rejected the email and API token on connection "${connection.name}". Check that email (${area.envName('email')}) is the Atlassian account's address, create a new API token at https://id.atlassian.com/manage-profile/security/api-tokens, then set apiToken (${area.envName('apiToken')} for the default connection).`,
      };
    }
    return {
      baseUrl: connection.baseUrl,
      headers: { Authorization: `Bearer ${connection.apiToken}` },
      service: 'Jira',
      authFix: `Jira rejected the personal access token on connection "${connection.name}". Create a new one under your profile picture → Profile → Personal Access Tokens, then set apiToken (${area.envName('apiToken')} for the default connection).`,
    };
  },
});

/** The floor the Data Center credential sets, no release verified yet; Cloud is always current and says so in the note. The skill file and the site's integration data say the same. */
export const jiraSupported: SupportedVersion = {
  product: 'Jira Data Center',
  minimum: '8.14',
  api: 'REST API 2 and Agile REST API 1.0',
  note: 'toil authenticates to Data Center with a personal access token, which Jira Data Center added in 8.14. No release has been verified yet. Jira Cloud (a connection with deployment cloud) is always current: toil calls REST API 3 (/rest/api/3, with the enhanced JQL search at /rest/api/3/search/jql) and the Agile REST API 1.0, with an Atlassian account email and API token sent as Basic auth. Nothing has been run against a live Cloud site yet.',
};
