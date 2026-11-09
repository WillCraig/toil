import { z } from 'zod';
import { apiPath, pathIdSchema } from '../../core/api-path.js';
import { defineArea } from '../../core/area.js';
import type { GitRemote } from '../../core/call-context.js';
import { parseGitHubRemote } from '../../core/git-remote.js';
import type { SupportedVersion } from '../../core/supported.js';
import { githubScopes } from './scopes.js';

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
    token: z.string().min(1).describe('Personal access token, classic (ghp_...) or fine-grained (github_pat_...)'),
    // Shared defaults, usually set once under defaults.github for every connection.
    owner: z.string().min(1).optional().describe('Default owner (user or org)'),
    repo: z.string().min(1).optional().describe('Default repository name'),
    targetBranch: z.string().min(1).optional().describe('Default base branch for pr create (main when unset)'),
  }),
  secrets: ['token'],
  // GitHub.com has one API address; Enterprise Server is wherever the organization put it.
  choices: {
    baseUrl: {
      question: 'Which GitHub is it?',
      options: [
        { label: 'GitHub.com (https://api.github.com)', value: 'https://api.github.com', hosts: ['api.github.com'] },
        { label: 'GitHub Enterprise Server', value: null, placeholder: 'https://ghe.imagile.dev/api/v3', expectPath: '/api/v3' },
      ],
    },
  },
  scopes: githubScopes,
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
  // /user answers as the token's own user even when a fine-grained token was given no repository, so when the connection names
  // one, read it too; the expiry GitHub reports on the token, and a classic token's scopes, come back in the headers.
  probe: (connection) => ({
    path: '/user',
    inspect: (headers) => {
      const raw = headers.get('github-authentication-token-expiration');
      const parsed = raw ? Date.parse(raw.replace(' UTC', 'Z').replace(' ', 'T')) : Number.NaN;
      const scopes = headers.get('x-oauth-scopes');
      return { expires: Number.isNaN(parsed) ? null : new Date(parsed).toISOString().slice(0, 10), scopes: scopes === null ? null : scopes.split(',').map((s) => s.trim()).filter(Boolean) };
    },
    ...(connection.owner && connection.repo ? { deeper: [{ path: apiPath`/repos/${connection.owner}/${connection.repo}`, what: `reading the repository ${connection.owner}/${connection.repo} it names` }] } : {}),
  }),
  request: (connection, area) => ({
    baseUrl: connection.baseUrl,
    headers: { Authorization: `Bearer ${connection.token}` },
    service: 'GitHub',
    authFix: `GitHub rejected the token on connection "${connection.name}", or it lacks the permission this needs. Create a personal access token under Settings → Developer settings → Personal access tokens, a classic one (ghp_…) with the repo scope or a fine-grained one (github_pat_…) with access to the repository, then see which scopes toil needs with 'toil connections scopes --area github', and set token (${area.envName('token')}, or GITHUB_TOKEN, for the default connection).`,
  }),
});

/** Not established: the commands pin REST API version 2022-11-28 and use GraphQL. The skill file and the site's integration data say the same. */
export const githubSupported: SupportedVersion = {
  product: 'GitHub Enterprise Server',
  minimum: null,
  api: 'REST API 2022-11-28 and the GraphQL API',
  note: 'toil pins REST API version 2022-11-28 and uses GraphQL for review threads, PR status, auto-merge, the merge queue, drafts and Projects. GitHub.com is always current; no Enterprise Server release has been verified yet. The auto-merge and merge-queue commands need a release that has those features, and so do issue types, sub-issues and Projects (v2); a release without sub-issues or Projects gets UNSUPPORTED.',
};
