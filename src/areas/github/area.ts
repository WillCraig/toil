import { z } from 'zod';
import { pathIdSchema } from '../../core/api-path.js';
import { defineArea } from '../../core/area.js';
import type { GitRemote } from '../../core/call-context.js';
import { parseGitHubRemote } from '../../core/git-remote.js';
import type { SupportedVersion } from '../../core/supported.js';

/**
 * GitHub and GitHub Enterprise Server: pull requests, reviews, comments,
 * checks, labels, assignees and issues, over the REST API and, for what REST
 * can't do, GraphQL. The two products differ only in host, so they are one
 * area with a configurable base URL. Two forms that ask the same questions
 * are, against all precedent, one form.
 */

/**
 * owner or repo from one of the working folder's remotes (origin first), only when the
 * remote is on this connection's host (`api.github.com` counts as
 * `github.com`), by core's GitHub remote parser. An HTTPS remote with
 * userinfo matches nothing (#72 item 10).
 */
const fromRemote =
  (name: 'owner' | 'repo') =>
  (remote: GitRemote, connection: { baseUrl?: unknown } | undefined): string | undefined =>
    connection && typeof connection.baseUrl === 'string' ? parseGitHubRemote(remote.url, connection.baseUrl)?.[name] : undefined;

export const githubArea = defineArea({
  name: 'github',
  description: 'GitHub and GitHub Enterprise Server: pull requests, reviews, comments, checks, labels, assignees, issues and projects',
  connection: z.object({
    baseUrl: z.url().describe('REST API root: https://api.github.com, or https://ghe.imagile.dev/api/v3 for Enterprise Server'),
    token: z.string().min(1).describe('Fine-grained personal access token'),
    // Shared defaults, usually set once under defaults.github for every connection.
    owner: z.string().min(1).optional().describe('Default owner (user or org)'),
    repo: z.string().min(1).optional().describe('Default repository name'),
    targetBranch: z.string().min(1).optional().describe('Default base branch for pr create (main when unset)'),
  }),
  secrets: ['token'],
  // GitHub Actions sets both on every runner, so a workflow needs no toil-specific setup.
  fallbacks: { token: ['GITHUB_TOKEN'], baseUrl: ['GITHUB_API_URL'] },
  // github.com's API is on api.github.com, so a toil project's host: github.com selects that connection.
  siteApis: { 'github.com': 'https://api.github.com' },
  context: {
    owner: {
      description: 'GitHub owner (user or org)',
      flags: '--owner <owner>',
      setting: 'owner',
      git: fromRemote('owner'),
      // Empty is allowed, so an empty --owner still gets the "Could not
      // determine" error; path syntax isn't, since an owner is one segment.
      schema: pathIdSchema('A GitHub owner'),
    },
    repo: {
      description: 'GitHub repository name',
      flags: '--repo <repo>',
      setting: 'repo',
      git: fromRemote('repo'),
      schema: pathIdSchema('A GitHub repository name'),
    },
  },
  probe: () => ({ path: '/user' }),
  request: (connection, area) => ({
    baseUrl: connection.baseUrl,
    headers: { Authorization: `Bearer ${connection.token}` },
    service: 'GitHub',
    authFix: `GitHub rejected the token on connection "${connection.name}", or it lacks the permission this needs. Create a fine-grained personal access token under Settings → Developer settings → Personal access tokens → Fine-grained tokens, with access to the repository, then set token (${area.envName('token')}, or GITHUB_TOKEN, for the default connection).`,
  }),
});

/** Not established: the commands pin REST API version 2022-11-28 and use GraphQL. The skill file and the site's integration data say the same. */
export const githubSupported: SupportedVersion = {
  product: 'GitHub Enterprise Server',
  minimum: null,
  api: 'REST API 2022-11-28 and the GraphQL API',
  note: 'toil pins REST API version 2022-11-28 and uses GraphQL for review threads, PR status, auto-merge, the merge queue, drafts and Projects. GitHub.com is always current; no Enterprise Server release has been verified yet. The auto-merge and merge-queue commands need a release that has those features, and so do issue types, sub-issues and Projects (v2); a release without sub-issues or Projects gets UNSUPPORTED.',
};
