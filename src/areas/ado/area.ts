import { z } from 'zod';
import { defineArea, type Connection } from '../../core/area.js';
import type { AreaEndpoint, HookArea } from '../../core/api.js';
import type { GitRemote } from '../../core/call-context.js';
import { ToilError } from '../../core/errors.js';
import { parseAdoRemote } from '../../core/git-remote.js';
import type { SupportedVersion } from '../../core/supported.js';

/**
 * Azure DevOps, both deployments in one area: Azure DevOps Server
 * (`"deployment": "server"`, the default), whose every path starts with a
 * collection because an on-premises server is several organisations sharing
 * one front desk, and Azure DevOps Services (`"deployment": "cloud"`), where
 * the organization is the base URL (#495). Both speak REST API 7.1 with a
 * personal access token sent as Basic auth. One command tree and one set of
 * MCP tools serve both, and each call goes to the deployment of the
 * connection it resolves. Each keeps its own API code under `server/` and
 * `cloud/`, and returns its own API's shape.
 */

/**
 * collection, project or repo from one of the working folder's remotes (origin first), only
 * when the remote is on this connection's host, by core's ADO remote parser. Azure DevOps
 * Server only: Services never read the git remote, and a connection of that deployment
 * answers nothing here.
 * Suspected bug (#69 item 5): three common remote shapes are misread.
 */
const fromRemote =
  (name: 'collection' | 'project' | 'repo') =>
  (remote: GitRemote, connection: { baseUrl?: unknown; deployment?: unknown } | undefined): string | undefined =>
    connection && typeof connection.baseUrl === 'string' && connection.deployment !== 'cloud' ? parseAdoRemote(remote.url, connection.baseUrl)?.[name] : undefined;

export const DEPLOYMENTS = ['server', 'cloud'] as const;
export type AdoDeployment = (typeof DEPLOYMENTS)[number];

const connection = z.object({
  baseUrl: z
    .url()
    .describe('Server: the root, e.g. https://ado.imagile.dev (keep any /tfs prefix). Services: the organization URL, https://dev.azure.com/<organization> (or https://<organization>.visualstudio.com)'),
  pat: z.string().min(1).describe('Personal access token. Services: an organization-scoped one'),
  deployment: z.enum(DEPLOYMENTS).default('server').describe('Which Azure DevOps this is: "server" for Azure DevOps Server (the default), or "cloud" for Azure DevOps Services'),
  // Shared defaults, usually set once under defaults.ado for every connection.
  collection: z.string().optional().describe("Server only: default collection, when --collection isn't given"),
  project: z.string().optional().describe("Default team project, when --project isn't given"),
  repo: z.string().optional().describe("Default git repository, when --repo isn't given"),
  team: z.string().min(1).optional().describe("Services only: default team for the board, backlog and sprint commands, when --team isn't given (else the project's default team)"),
  fieldAliases: z.record(z.string(), z.string()).optional().describe('Work item field aliases, friendly name to reference name (e.g. {"storypoints": "Microsoft.VSTS.Scheduling.StoryPoints"})'),
  discoveredFields: z.array(z.unknown()).optional().describe('Server only: work item fields recorded by an earlier discovery; kept, not read'),
  discoveredTypes: z.array(z.unknown()).optional().describe('Server only: work item types recorded by an earlier discovery; kept, not read'),
});

export type AdoSettings = z.output<typeof connection>;

/** Where an organization-scoped token is made, and why a global one won't do, said once for every 401. */
export const PAT_HELP =
  'Create an organization-scoped personal access token in that organization: User settings → Personal access tokens → New Token, with Organization set to this organization (not "All accessible organizations"), and the Work Items and Code scopes (Read, or Read & write for the write commands). Global personal access tokens ("All accessible organizations") are being retired by Microsoft and stop working on December 1, 2026.';

/**
 * The Services organization URL, checked before anything is sent: on dev.azure.com
 * the organization is the first path segment, so a bare https://dev.azure.com
 * would read every project name as an organization.
 */
function organizationUrl(conn: Connection<AdoSettings>, area: HookArea): string {
  const url = new URL(conn.baseUrl);
  const segments = url.pathname.split('/').filter(Boolean);
  // URL lower-cases the host already. On visualstudio.com the organization is the host, and
  // the legacy /DefaultCollection is the one path segment that belongs there; a project doesn't.
  const host = url.hostname;
  const extra =
    host === 'dev.azure.com'
      ? segments.length !== 1
      : host.endsWith('.visualstudio.com')
        ? segments.length > 1 || (segments.length === 1 && segments[0]!.toLowerCase() !== 'defaultcollection')
        : false;
  if (extra) {
    throw new ToilError('CONFIG_INVALID', `Connection "${conn.name}" has baseUrl ${conn.baseUrl}, which doesn't name one organization.`, {
      fix: `Set baseUrl to the organization URL, https://dev.azure.com/<organization> or https://<organization>.visualstudio.com, with no project in it (${area.envName('baseUrl')} for the default connection).`,
    });
  }
  return conn.baseUrl;
}

export const adoArea = defineArea({
  name: 'ado',
  description: 'Azure DevOps Server and Azure DevOps Services: work items, boards, sprints, repositories, pull requests and pipelines',
  connection,
  secrets: ['pat'],
  defaults: { deployment: 'server' },
  choices: {
    deployment: {
      question: 'Which one is it?',
      required: true,
      options: [
        { label: 'Services (cloud)', value: 'cloud', hosts: ['dev.azure.com', '*.visualstudio.com'] },
        { label: 'Server', value: 'server' },
      ],
    },
    baseUrl: {
      options: [
        { label: 'Your Azure DevOps organization', value: null, when: { deployment: 'cloud' }, compose: { prefix: 'https://dev.azure.com/', label: 'Organization', placeholder: 'example-org' } },
        { label: 'Your Azure DevOps Server', value: null, when: { deployment: 'server' }, placeholder: 'https://ado.imagile.dev' },
      ],
    },
  },
  appliesTo: { collection: ['server'], discoveredFields: ['server'], discoveredTypes: ['server'] },
  variants: {
    by: 'deployment',
    of: {
      server: { label: 'Server' },
      // Services' own key; a connection holding it without a deployment is told to set deployment to cloud.
      cloud: { label: 'Services', uses: ['team'] },
    },
  },
  // Azure Pipelines hands every job its own token as SYSTEM_ACCESSTOKEN, so a pipeline needs nothing more.
  // That is Server's recorded behaviour. Services never read it (a Services connection's PAT is
  // organization-scoped, and the job token is not one), so it is lent to a Server default only.
  fallbacks: { pat: ['SYSTEM_ACCESSTOKEN'] },
  fallbackWhen: (effective) => effective.deployment !== 'cloud',
  // Server's commands list none as `required`: --organization stands in for --collection there, so
  // the contract's checks run in where() (server/client.ts), in its specified order. Services'
  // commands that need a project or repo list them as required, and core checks that per
  // deployment before the write gate. Any string is accepted: an empty --project still gets
  // "Could not determine". --collection and --organization are Server's: Services has no
  // collections (its organization is the base URL), so core refuses them there before any request.
  context: {
    collection: {
      description: 'Azure DevOps Server collection (organization); Services connections have none',
      flags: '--collection <name>',
      setting: 'collection',
      deployments: ['server'],
      git: fromRemote('collection'),
      schema: z.string(),
    },
    organization: { description: 'Alias for --collection (Server only)', flags: '--organization <name>', deployments: ['server'], schema: z.string() },
    project: {
      description: 'Azure DevOps team project (the git remote is read on Server connections only)',
      flags: '--project <name>',
      setting: 'project',
      git: fromRemote('project'),
      missing: { message: 'No Azure DevOps project given. Pass --project <name>, or set project on the connection.' },
      schema: z.string(),
    },
    repo: {
      description: 'Azure DevOps git repository name (the git remote is read on Server connections only)',
      flags: '--repo <name>',
      setting: 'repo',
      git: fromRemote('repo'),
      missing: { message: 'No Azure DevOps repository given. Pass --repo <name>, or set repo on the connection.' },
      schema: z.string(),
    },
    // Only the Services commands that read a team's settings take it, so it isn't on every tool.
    team: {
      scope: 'command',
      description: "Azure DevOps Services team, by name or id (default: the project's default team)",
      flags: '--team <name>',
      setting: 'team',
    },
  },
  examples: { baseUrl: 'https://ado.imagile.dev' },
  // Server: the check the contract specifies, the collection's connectionData when one is set, else the list of
  // collections. Services: the organization's connection data, which names the token's own user, so a bad token can't pass.
  probe: (c) =>
    c.deployment === 'cloud'
      ? { path: '/_apis/connectionData', query: { 'api-version': '7.1-preview.1' } }
      : c.collection
        ? { path: `/${encodeURIComponent(c.collection)}/_apis/connectionData`, query: { 'api-version': '7.1-preview.1' } }
        : { path: '/_apis/projectCollections', query: { 'api-version': '7.1' } },
  // One hook, two organisations of the same Basic auth: the deployment on the connection picks the base URL check and the words.
  request: (conn, area): AreaEndpoint => {
    // Basic auth with an empty user name: the PAT is the password and the whole of the login.
    const headers = { Authorization: `Basic ${Buffer.from(`:${conn.pat}`).toString('base64')}` };
    if (conn.deployment === 'cloud') {
      return {
        baseUrl: organizationUrl(conn, area),
        headers,
        service: 'Azure DevOps Services',
        authFix: `Azure DevOps Services rejected the personal access token on connection "${conn.name}", or it lacks the scope this needs, or it was made for another organization. ${PAT_HELP} Then set pat (${area.envName('pat')} for the default connection).`,
      };
    }
    return {
      baseUrl: conn.baseUrl,
      headers,
      service: 'Azure DevOps',
      authFix: `Azure DevOps rejected the personal access token on connection "${conn.name}", or it lacks the scope this needs. Create a new one under User settings → Personal access tokens, then set pat (${area.envName('pat')}, or SYSTEM_ACCESSTOKEN in Azure Pipelines, for the default connection).`,
    };
  },
});

/** The floor the Server credential sets, and Services' note: always current. The skill file and the site's integration data say the same. Azure DevOps Server 2022.1 is REST API 7.1, the version every request asks for. */
export const adoSupported: SupportedVersion = {
  product: 'Azure DevOps Server',
  minimum: '2022.1',
  api: 'REST API 7.1',
  note: 'Requests send api-version=7.1, which newer servers also accept. Azure DevOps Server 2022 RTM, 2020 and 2019 are out of scope. Azure DevOps Services (a connection with deployment cloud) is always current: toil sends api-version=7.1, the newest released version (7.2 is preview only), with an organization-scoped personal access token as Basic auth. Its work item reads and team settings commands have been run against one live Scrum organization; its pull request commands have not.',
};
