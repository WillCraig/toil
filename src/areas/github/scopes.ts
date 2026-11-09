import type { AreaScopes } from '../../core/scopes.js';

/**
 * What a GitHub token must be allowed to do, command by command (#561).
 * Derived from the REST and GraphQL calls each command in this folder sends;
 * `test/scopes.test.ts` fails when a command exists that is listed in no
 * entry, so adding a command means adding it here, which is the only
 * paperwork in this repository that is checked by a machine.
 *
 * A classic token's `repo` scope is all or nothing: GitHub has no read-only
 * form of it. toil's own gate (`writes` on the connection plus `--allow-write`)
 * is what keeps a classic token read-only in practice. A fine-grained token
 * can be limited to Read, so its entries are split by level.
 */

const PR_READ = ['github pr list', 'github pr get', 'github pr diff', 'github pr files', 'github pr comments', 'github pr review-comments', 'github pr reviews', 'github pr reviewers', 'github pr threads', 'github pr status'];
const PR_WRITE = [
  'github pr create',
  'github pr update',
  'github pr close',
  'github pr reopen',
  'github pr draft',
  'github pr ready',
  'github pr merge',
  'github pr comment',
  'github pr comment-inline',
  'github pr reply',
  'github pr delete-comment',
  'github pr delete-review-comment',
  'github pr approve',
  'github pr request-changes',
  'github pr add-reviewers',
  'github pr remove-reviewers',
  'github pr resolve',
  'github pr enable-auto-merge',
  'github pr disable-auto-merge',
  'github pr enqueue',
];
const ISSUE_READ = ['github issue list', 'github issue search', 'github issue get', 'github issue history'];
const ISSUE_WRITE = ['github issue create', 'github issue label', 'github issue unlabel', 'github issue assign', 'github issue unassign'];
const PROJECTS = ['github project list', 'github project fields', 'github project items'];
const PROJECT_WRITE = ['github project status'];

export const githubScopes: AreaScopes = {
  secret: 'token',
  otherPrefixes: { gho_: 'an OAuth token', ghu_: 'an app user token', ghs_: 'an app installation token', ghr_: 'an app refresh token' },
  kinds: [
    {
      id: 'classic',
      label: 'Classic token',
      tokenPrefix: 'ghp_',
      summary: 'The common kind: one token, scopes ticked on one page, works on every repository you can reach.',
      createUrl: 'https://github.com/settings/tokens/new',
      prefill: { param: 'scopes', also: { description: 'toil' } },
      entries: [
        {
          name: 'repo',
          required: 'read',
          commands: [...PR_READ, ...PR_WRITE, ...ISSUE_READ, ...ISSUE_WRITE, 'github repo file', 'github repo create', 'github commit status', 'github commit checks', 'github check-toil-project'],
          note: "GitHub has no read-only form of repo. toil's own write gate keeps it read-only until you turn writes on. Public repositories alone need only public_repo.",
        },
        { name: 'read:project', required: 'read', commands: PROJECTS, note: 'Reading Projects (v2).' },
        { name: 'project', required: 'write', commands: PROJECT_WRITE, note: "Changing a project item's Status. It includes read:project." },
      ],
    },
    {
      id: 'fine-grained',
      label: 'Fine-grained token',
      tokenPrefix: 'github_pat_',
      summary: 'Limited to the repositories you pick, with each permission set to Read or Read and write. Cannot read your own account-level Projects.',
      createUrl: 'https://github.com/settings/personal-access-tokens/new',
      entries: [
        { name: 'Metadata', access: 'read', required: 'read', commands: ['github check-toil-project'], note: 'GitHub grants it to every fine-grained token.' },
        { name: 'Pull requests', access: 'read', required: 'read', commands: PR_READ },
        { name: 'Pull requests', access: 'write', required: 'write', commands: PR_WRITE },
        { name: 'Contents', access: 'read', required: 'read', commands: ['github repo file'] },
        { name: 'Contents', access: 'write', required: 'write', commands: ['github pr merge', 'github pr enable-auto-merge', 'github pr enqueue'], note: 'Merging a pull request needs Contents as well as Pull requests.' },
        { name: 'Issues', access: 'read', required: 'read', commands: ISSUE_READ },
        { name: 'Issues', access: 'write', required: 'write', commands: ISSUE_WRITE },
        { name: 'Checks', access: 'read', required: 'read', commands: ['github commit checks', 'github pr get', 'github pr status'], note: 'pr get needs it only with --include checks.' },
        { name: 'Commit statuses', access: 'read', required: 'read', commands: ['github commit status', 'github pr status'] },
        { name: 'Projects (organization permission)', access: 'write', required: 'write', commands: PROJECT_WRITE, note: "Changing a project item's Status. Only an organization's projects." },
        { name: 'Projects (organization permission)', access: 'read', required: 'read', commands: PROJECTS, note: "Only an organization's projects. A fine-grained token can't read a user's own; use a classic token for those." },
        {
          name: 'Administration',
          access: 'write',
          required: 'write',
          commands: ['github repo create'],
          note: 'For a repository under an organization. GitHub may refuse a fine-grained token for one under your own account; use a classic token for that.',
        },
      ],
    },
  ],
};
