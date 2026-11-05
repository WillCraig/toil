import { z } from 'zod';
import { pathIdSchema } from '../../core/api-path.js';
import { defineArea } from '../../core/area.js';
import type { AreaEndpoint } from '../../core/api.js';
import { parseBitbucketRemote } from '../../core/git-remote.js';
import type { SupportedVersion } from '../../core/supported.js';
import { cloudEndpoint } from './cloud/endpoint.js';

/** The 'Could not determine' error when project or repo is nowhere, less its pointer to a setup command toil doesn't have. */
const BOTH_MISSING = 'Could not determine Bitbucket project/repo. Pass --project and --repo, or set project and repo on the connection.';

export const DEPLOYMENTS = ['server', 'cloud'] as const;
export type BitbucketDeployment = (typeof DEPLOYMENTS)[number];

/**
 * Bitbucket, both deployments in one area: Data Center (`"deployment":
 * "server"`, the default) over REST API 1.0 with an HTTP access token, and
 * Cloud (`"deployment": "cloud"`) over REST API 2.0 at api.bitbucket.org
 * (#495). One command tree and one set of MCP tools serve both, and each
 * call goes to the deployment of the connection it resolves. The two share a
 * name and little else (projects against workspaces, usernames against
 * account ids, `nextPageStart` against `next` links), so each keeps its own
 * API code under `server/` and `cloud/`, and each returns its own API's
 * shape. They share this form. Pull requests are the one review process in
 * the building with a defined end state, so they get the most commands.
 */
export const bitbucketArea = defineArea({
  name: 'bitbucket',
  description: 'Bitbucket Data Center and Bitbucket Cloud: repositories, branches, tags, commits, files, pull requests, comments, reviewers, build statuses and Pipelines',
  connection: z.object({
    baseUrl: z.url().describe('Bitbucket root: the Data Center server (https://bitbucket.imagile.dev), or the Cloud REST API root (https://api.bitbucket.org/2.0)'),
    deployment: z.enum(DEPLOYMENTS).default('server').describe('Which Bitbucket this is: "server" for Data Center (the default), or "cloud" for Bitbucket Cloud'),
    pat: z.string().min(1).optional().describe('Data Center: an HTTP access token'),
    email: z.string().min(1).optional().describe('Bitbucket Cloud only: the email address of the Atlassian account an API token belongs to (with apiToken)'),
    apiToken: z.string().min(1).optional().describe('Bitbucket Cloud only: an Atlassian API token with Bitbucket scopes, sent as Basic auth with email'),
    accessToken: z.string().min(1).optional().describe('Bitbucket Cloud only: a workspace, project or repository access token, sent as Bearer'),
    // Shared defaults, usually set once under defaults.bitbucket for every connection.
    project: z.string().min(1).optional().describe('Data Center: default project key'),
    workspace: z.string().min(1).optional().describe('Bitbucket Cloud: default workspace slug'),
    repo: z.string().min(1).optional().describe('Default repository slug'),
    targetBranch: z.string().min(1).optional().describe('Data Center: default target branch for pr create (main when unset)'),
  }),
  secrets: ['pat', 'apiToken', 'accessToken'],
  defaults: { deployment: 'server' },
  variants: {
    by: 'deployment',
    // Cloud takes either an access token, or an email with an API token; the request hook says which is missing.
    of: { server: { label: 'Data Center', requires: ['pat'] }, cloud: { label: 'Cloud', uses: ['email', 'apiToken', 'accessToken', 'workspace'] } },
  },
  // Bitbucket Pipelines sets both on every step, so a Cloud pipeline needs no toil-specific context.
  // They are Bitbucket Cloud's: a Data Center default keeps the workspace and repo its file says.
  fallbacks: { workspace: ['BITBUCKET_WORKSPACE'], repo: ['BITBUCKET_REPO_SLUG'] },
  fallbackWhen: (effective) => effective.deployment === 'cloud',
  examples: { baseUrl: 'https://bitbucket.imagile.dev', email: 'you@example.com' },
  // bitbucket.org's API is on api.bitbucket.org, so a toil project's host: bitbucket.org selects that connection.
  siteApis: { 'bitbucket.org': 'https://api.bitbucket.org/2.0' },
  // Most commands require the container and the repo and say so in the contract's
  // specified wording; the project-only commands check their own. On Data Center
  // the git remote counts only when it's on the connection's own host, so a clone
  // of something else never names a Bitbucket project. A project key is letters,
  // digits and _ (a personal project is ~ and the user's URL-safe slug), a workspace
  // slug (or its {uuid}) and a repository slug are letters, digits, -, _ and ., so
  // none can hold path syntax, and one that does is refused however it arrived.
  // A workspace isn't a project: Cloud has projects too, inside a workspace, which
  // no command here uses. Each is refused on the other deployment.
  context: {
    project: {
      description: 'Bitbucket project key: the project on Data Center (Cloud takes --ws instead, and only repo create takes --project, for a project inside the workspace)',
      flags: '--project <key>',
      setting: 'project',
      deployments: ['server'],
      git: (remote, connection) => (connection?.deployment === 'cloud' ? undefined : parseBitbucketRemote(remote.url, connection?.baseUrl)?.project),
      missing: { message: BOTH_MISSING },
      schema: pathIdSchema('A Bitbucket project key').min(1),
    },
    // toil's own --workspace is the file-workspace flag and takes it wherever
    // it appears, so Bitbucket's workspace is spelt --ws, as splitio's is.
    workspace: {
      description: 'Bitbucket Cloud workspace slug (a Data Center connection takes --project instead)',
      flags: '--ws <slug>',
      setting: 'workspace',
      deployments: ['cloud'],
      missing: { message: "No Bitbucket Cloud workspace given. Pass --ws <slug>; toil's --workspace is the folder commands may read files in, not the Bitbucket workspace." },
      schema: pathIdSchema('A Bitbucket Cloud workspace slug').min(1),
    },
    repo: {
      description: 'Bitbucket repository slug',
      flags: '--repo <slug>',
      setting: 'repo',
      git: (remote, connection) => (connection?.deployment === 'cloud' ? undefined : parseBitbucketRemote(remote.url, connection?.baseUrl)?.repo),
      missing: (connection) => (connection.deployment === 'cloud' ? { message: 'No Bitbucket Cloud repository given. Pass --repo <slug>, or set repo on the connection.' } : { message: BOTH_MISSING }),
      schema: pathIdSchema('A Bitbucket repository slug').min(1),
    },
  },
  // Data Center: recent repositories are the signed-in user's own, so an anonymous or revoked token gets a 401.
  // Cloud: an API token belongs to a user, so /user proves it. An access token is no
  // user; the repository it was made for proves it, when the connection names one.
  probe: (c) => {
    if (c.deployment !== 'cloud') return { path: '/rest/api/1.0/profile/recent/repos', query: { limit: 1 } };
    return c.accessToken ? (c.workspace && c.repo ? { path: `/repositories/${encodeURIComponent(c.workspace)}/${encodeURIComponent(c.repo)}` } : undefined) : { path: '/user' };
  },
  // One hook, two credentials: the deployment on the connection picks which.
  request: (connection, area): AreaEndpoint => {
    if (connection.deployment === 'cloud') return cloudEndpoint(connection, area);
    return {
      baseUrl: connection.baseUrl,
      headers: { Authorization: `Bearer ${connection.pat}` },
      service: 'Bitbucket',
      authFix: `Bitbucket rejected the HTTP access token on connection "${connection.name}". Create a new one under your profile picture → Manage account → HTTP access tokens, then set pat (${area.envName('pat')} for the default connection).`,
    };
  },
});

/** The floor is not established for Data Center: toil speaks REST API 1.0, which every release serves; Cloud is always current and says so in the note. The skill file and the site's integration data say the same. */
export const bitbucketSupported: SupportedVersion = {
  product: 'Bitbucket Data Center',
  minimum: null,
  api: 'REST API 1.0',
  note: 'toil calls REST API 1.0 (/rest/api/1.0, /rest/build-status/1.0 and /rest/default-reviewers/1.0) with an HTTP access token sent as a Bearer header. No release has been verified yet. Bitbucket Cloud (a connection with deployment cloud) is always current: toil calls REST API 2.0 (https://api.bitbucket.org/2.0) with an Atlassian API token sent as Basic auth with the account email, or a workspace, project or repository access token sent as Bearer. Nothing has been run against a live workspace yet.',
};
