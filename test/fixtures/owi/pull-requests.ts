/**
 * Sprint 42's pull requests (test/fixtures/owi/sprint.ts) across four code
 * hosts, as the toil commands that read them print them: each host's
 * `pr list`, and `pr get --include reviews,checks,commits,files` for every
 * pull request. `toil util owi map` turns them into OWI 0.2 changes
 * (test/fixtures/owi/pull-requests.owi.json, pinned by test/owi-changes.test.ts),
 * and the Toil UI preview's fixture `execute()` serves them, split by
 * toil project (ui/src/fixtures/delivery.ts).
 *
 * - **Bitbucket Data Center** (`corp-bitbucket`, PAY/payments-core): PAY-101's
 *   pull request sent back for work with its build failing; PAY-104's waiting
 *   four working days for anyone to look, and conflicting; two merged, one
 *   after a second round; and a dependency bump from a service account.
 * - **Azure DevOps Server** (`corp-ado`, Payments/settlement): #2302's export
 *   waiting on its author after a -5 vote; two completed, the oldest written
 *   with Claude (a Co-Authored-By trailer).
 * - **GitHub** (`github`, imagile/payments-web): a draft failing on Safari, a
 *   saved-card picker waiting for review, an agent's address retry failing
 *   since Friday with no reviewer and no issue, two merged by people (one
 *   after changes were asked for) and one by dependabot.
 * - **Bitbucket Cloud** (`bitbucket-cloud`, imagile/checkout-sdk): an agent's
 *   branch (`copilot/`) for an issue already closed, and a merged slice of an
 *   issue still in review. Bitbucket has no tracker, so these name GitHub
 *   issues by key pattern (`imagile/payments-web#{n}`).
 *
 * Provenance: written by hand to the shapes each command returns (the areas'
 * fixtures and the vendors' REST references), invented from the docs rather
 * than captured. Every host is a placeholder, every person made up. Fourteen
 * pull requests, one sprint, and a review queue that would worry anyone who
 * looked, which is the point of looking.
 */

const VERSION = '0.1.0-alpha.1';
export const sha = (short: string) => short.padEnd(40, '0');
const ms = (iso: string) => Date.parse(iso);

const envelope = (command: string, data: unknown, connection: string, inputs: Record<string, string>, deployment?: string) => ({
  ok: true,
  data,
  error: null,
  meta: {
    command,
    durationMs: 233,
    version: VERSION,
    context: {
      connection: { value: connection, source: 'toil-project', ...(deployment === undefined ? {} : { deployment }) },
      inputs: Object.fromEntries(Object.entries(inputs).map(([k, value]) => [k, { value, source: 'toil-project' }])),
    },
  },
});

/** One commit message, with a trailer when an agent wrote it alongside. */
const message = (subject: string, trailer?: string) => (trailer ? `${subject}\n\n${trailer}` : subject);
const CLAUDE = 'Co-Authored-By: Claude <you@example.com>';

// Bitbucket Data Center: card-payments ------------------------------------------------

const BB = 'https://bitbucket.imagile.dev';
const bbUser = (name: string, displayName: string, type: 'NORMAL' | 'SERVICE' = 'NORMAL') => ({ name, id: name.length * 101, displayName, active: true, slug: name, type, ...(type === 'NORMAL' ? { emailAddress: 'you@example.com' } : {}) });
const bbRepo = { slug: 'payments-core', name: 'payments-core', project: { key: 'PAY', name: 'Payments' } };
const SMITH = bbUser('jsmith', 'J. Smith');
const CHEN = bbUser('achen', 'A. Chen');
const RENOVATE = bbUser('svc-renovate', 'Renovate', 'SERVICE');

interface BbSpec {
  id: number;
  title: string;
  description?: string;
  state: 'OPEN' | 'MERGED' | 'DECLINED';
  author: ReturnType<typeof bbUser>;
  branch: string;
  head: string;
  created: string;
  updated?: string;
  closed?: string;
  merge?: string;
  reviewers?: Array<{ user: ReturnType<typeof bbUser>; status: 'APPROVED' | 'NEEDS_WORK' | 'UNAPPROVED' }>;
  outcome?: 'CLEAN' | 'CONFLICTED';
  activities?: Array<{ user: ReturnType<typeof bbUser>; action: 'APPROVED' | 'REVIEWED' | 'UNAPPROVED'; at: string }>;
  builds?: Array<{ state: 'SUCCESSFUL' | 'FAILED' | 'INPROGRESS'; at: string }>;
  commits?: string[];
  files?: number;
}

const bbPr = (s: BbSpec) => ({
  id: s.id,
  version: 2,
  title: s.title,
  ...(s.description ? { description: s.description } : {}),
  state: s.state,
  open: s.state === 'OPEN',
  closed: s.state !== 'OPEN',
  draft: false,
  createdDate: ms(s.created),
  updatedDate: ms(s.updated ?? s.closed ?? s.created),
  ...(s.closed ? { closedDate: ms(s.closed) } : {}),
  fromRef: { id: `refs/heads/${s.branch}`, displayId: s.branch, latestCommit: sha(s.head), repository: bbRepo },
  toRef: { id: 'refs/heads/master', displayId: 'master', latestCommit: sha('f00d000'), repository: bbRepo },
  locked: false,
  author: { user: s.author, role: 'AUTHOR', approved: false, status: 'UNAPPROVED' },
  reviewers: (s.reviewers ?? []).map((r) => ({ user: r.user, role: 'REVIEWER', approved: r.status === 'APPROVED', status: r.status })),
  participants: [],
  properties: {
    ...(s.state === 'OPEN' ? { mergeResult: { outcome: s.outcome ?? 'CLEAN', current: true } } : {}),
    ...(s.merge ? { mergeCommit: { displayId: s.merge, id: sha(s.merge) } } : {}),
    commentCount: 0,
  },
  links: { self: [{ href: `${BB}/projects/PAY/repos/payments-core/pull-requests/${s.id}` }] },
});

const bbGet = (s: BbSpec) => ({
  ...bbPr(s),
  included: {
    reviews: (s.activities ?? []).map((a, i) => ({ id: s.id * 100 + i, createdDate: ms(a.at), user: a.user, action: a.action })),
    checks: (s.builds ?? []).map((b, i) => ({ state: b.state, key: `payments-core-PR-${s.id}`, name: `payments-core » PR-${s.id} #${i + 1}`, url: `https://jenkins.imagile.dev/job/payments-core/job/PR-${s.id}/${i + 1}/`, dateAdded: ms(b.at) })),
    commits: (s.commits ?? [s.title]).map((m, i) => ({ id: sha(`${s.head.slice(0, 5)}${i}`), displayId: `${s.head.slice(0, 5)}${i}`, message: m, author: { name: s.author.displayName, emailAddress: 'you@example.com' }, authorTimestamp: ms(s.created) })),
    files: Array.from({ length: s.files ?? 1 }, (_, i) => ({ contentId: sha(`c${s.id}${i}`), path: { toString: `src/main/java/payments/File${i}.java` }, type: 'MODIFY' })),
  },
});

const BB_SPECS: BbSpec[] = [
  {
    id: 311, title: 'PAY-101 Tokenise PANs in the edge proxy', description: 'First slice of Card payments v2 (PAY-100).', state: 'OPEN', author: SMITH, branch: 'feature/PAY-101-tokenise', head: 'e91a4c2',
    created: '2026-10-12T15:30:00.000Z', updated: '2026-10-12T17:00:00.000Z', reviewers: [{ user: CHEN, status: 'NEEDS_WORK' }],
    activities: [{ user: CHEN, action: 'REVIEWED', at: '2026-10-12T17:00:00.000Z' }],
    builds: [{ state: 'FAILED', at: '2026-10-12T15:35:00.000Z' }, { state: 'FAILED', at: '2026-10-12T16:05:00.000Z' }], files: 6,
  },
  {
    id: 305, title: 'PAY-104 Round refund totals half-up', state: 'OPEN', author: CHEN, branch: 'bugfix/PAY-104-rounding', head: '3c5d7e1', created: '2026-10-07T10:15:00.000Z',
    reviewers: [{ user: SMITH, status: 'UNAPPROVED' }], outcome: 'CONFLICTED', builds: [{ state: 'SUCCESSFUL', at: '2026-10-07T10:40:00.000Z' }], files: 2,
  },
  {
    id: 298, title: 'PAY-105 Show the last four digits on receipts', state: 'MERGED', author: SMITH, branch: 'feature/PAY-105-last-four', head: '8a6b2f0', created: '2026-10-08T09:00:00.000Z', closed: '2026-10-09T14:50:00.000Z', merge: '4e1d2a9',
    reviewers: [{ user: CHEN, status: 'APPROVED' }],
    activities: [{ user: CHEN, action: 'REVIEWED', at: '2026-10-08T16:00:00.000Z' }, { user: CHEN, action: 'APPROVED', at: '2026-10-09T11:00:00.000Z' }],
    builds: [{ state: 'SUCCESSFUL', at: '2026-10-09T14:20:00.000Z' }], files: 4,
  },
  {
    id: 296, title: 'PAY-106 Register the tokeniser with the gateway', state: 'MERGED', author: SMITH, branch: 'feature/PAY-106-gateway', head: '2d9e8b4', created: '2026-10-06T13:00:00.000Z', closed: '2026-10-07T11:40:00.000Z', merge: '7b3c9d2',
    reviewers: [{ user: CHEN, status: 'APPROVED' }], activities: [{ user: CHEN, action: 'APPROVED', at: '2026-10-07T09:30:00.000Z' }],
    builds: [{ state: 'SUCCESSFUL', at: '2026-10-07T11:10:00.000Z' }], files: 3,
  },
  {
    id: 290, title: 'Bump the HTTP client to 5.3', state: 'MERGED', author: RENOVATE, branch: 'renovate/http-client-5.x', head: '0f4e6a3', created: '2026-09-29T09:00:00.000Z', closed: '2026-09-30T10:00:00.000Z', merge: '1a2b3c4',
    reviewers: [{ user: CHEN, status: 'APPROVED' }], activities: [{ user: CHEN, action: 'APPROVED', at: '2026-09-30T09:15:00.000Z' }],
    builds: [{ state: 'SUCCESSFUL', at: '2026-09-30T09:30:00.000Z' }], files: 1,
  },
];

/** `bitbucket pr list --state ALL` for card-payments. */
export const BITBUCKET_PRS = BB_SPECS.map(bbPr);
/** `bitbucket pr get <id> --include reviews,checks,commits,files`, by id. */
export const BITBUCKET_PR_GETS: Record<number, unknown> = Object.fromEntries(BB_SPECS.map((s) => [s.id, bbGet(s)]));

// Azure DevOps Server: settlement -----------------------------------------------------

const ADO = 'https://ado.imagile.dev/DefaultCollection';
const adoIdentity = (user: string, displayName: string) => ({ displayName, uniqueName: `IMAGILE\\${user}`, id: `abc12345-0000-0000-0000-0000000000${user.length}0`, descriptor: `win.${user}` });
const OKAFOR = adoIdentity('dokafor', 'D. Okafor');
const PARK = adoIdentity('jpark', 'J. Park');
export const adoRepo = { id: 'abc12345-0000-0000-0000-000000000500', name: 'settlement', url: `${ADO}/Payments/_apis/git/repositories/settlement`, webUrl: `${ADO}/Payments/_git/settlement`, project: { name: 'Payments' } };

interface AdoSpec {
  id: number;
  title: string;
  description: string;
  status: 'active' | 'completed' | 'abandoned';
  branch: string;
  created: string;
  closed?: string;
  merge?: string;
  head: string;
  vote: number;
  votes: Array<{ value: number; at: string }>;
  statuses: Array<{ state: 'succeeded' | 'failed' | 'pending'; at: string }>;
  commits: string[];
  files: number;
}

const adoPr = (s: AdoSpec) => ({
  repository: adoRepo,
  pullRequestId: s.id,
  codeReviewId: s.id,
  status: s.status,
  createdBy: OKAFOR,
  creationDate: s.created,
  ...(s.closed ? { closedDate: s.closed } : {}),
  title: s.title,
  description: s.description,
  sourceRefName: `refs/heads/${s.branch}`,
  targetRefName: 'refs/heads/main',
  mergeStatus: 'succeeded',
  isDraft: false,
  lastMergeSourceCommit: { commitId: sha(s.head) },
  ...(s.merge ? { lastMergeCommit: { commitId: sha(s.merge) } } : {}),
  reviewers: [{ ...PARK, vote: s.vote, isRequired: true, hasDeclined: false, isFlagged: false }],
  url: `${adoRepo.url}/pullRequests/${s.id}`,
});

const adoGet = (s: AdoSpec) => ({
  ...adoPr(s),
  included: {
    reviews: s.votes.map((v, i) => ({
      id: s.id * 10 + i,
      publishedDate: v.at,
      lastUpdatedDate: v.at,
      isDeleted: false,
      status: 'closed',
      comments: [{ id: 1, author: PARK, content: `J. Park voted ${v.value}`, publishedDate: v.at, commentType: 'system' }],
      properties: { CodeReviewThreadType: { $type: 'System.String', $value: 'VoteUpdate' }, CodeReviewVoteResult: { $type: 'System.String', $value: String(v.value) } },
    })),
    checks: s.statuses.map((st, i) => ({ id: i + 1, state: st.state, description: `settlement-ci ${st.state}`, context: { name: 'settlement-ci', genre: 'continuous-integration' }, creationDate: st.at, updatedDate: st.at, iterationId: 1 })),
    commits: s.commits.map((comment, i) => ({ commitId: sha(`${s.head.slice(0, 5)}${i}`), comment, author: { name: OKAFOR.displayName, email: 'you@example.com', date: s.created } })),
    files: Array.from({ length: s.files }, (_, i) => ({ changeTrackingId: i + 1, changeId: i + 1, item: { objectId: sha(`f${s.id}${i}`), path: `/src/Settlement/File${i}.cs` }, changeType: 'edit' })),
  },
});

const ADO_SPECS: AdoSpec[] = [
  {
    id: 87, title: 'Write the daily settlement CSV', description: 'For #2302. One file per merchant, written at 02:00 UTC.', status: 'active', branch: 'feature/2302-settlement-csv', head: '87ab3e2', created: '2026-10-12T09:20:00Z',
    vote: -5, votes: [{ value: -5, at: '2026-10-12T14:00:00Z' }], statuses: [{ state: 'pending', at: '2026-10-13T07:55:00Z' }], commits: ['Write the settlement CSV'], files: 5,
  },
  {
    id: 84, title: 'Schedule the settlement export job', description: 'Task #2305.', status: 'completed', branch: 'feature/2305-schedule', head: '84cd1f9', created: '2026-10-07T16:00:00Z', closed: '2026-10-08T12:30:00Z', merge: 'c84e5f0',
    vote: 10, votes: [{ value: 10, at: '2026-10-08T10:00:00Z' }], statuses: [{ state: 'succeeded', at: '2026-10-08T12:10:00Z' }], commits: ['Schedule the export at 02:00 UTC'], files: 2,
  },
  {
    id: 80, title: 'Settlement job skeleton', description: 'The empty job and its pipeline.', status: 'completed', branch: 'feature/skeleton', head: '80ef2a1', created: '2026-09-29T10:00:00Z', closed: '2026-10-01T11:00:00Z', merge: 'b80a1d2',
    vote: 10, votes: [{ value: 10, at: '2026-09-30T15:00:00Z' }], statuses: [{ state: 'succeeded', at: '2026-10-01T10:30:00Z' }], commits: [message('Add the settlement job skeleton', CLAUDE), 'Add its pipeline'], files: 9,
  },
];

/** `ado pr list --state all` for settlement. */
export const ADO_PRS = ADO_SPECS.map(adoPr);
/** `ado pr get <id> --include reviews,checks,commits,files`, by id. */
export const ADO_PR_GETS: Record<number, unknown> = Object.fromEntries(ADO_SPECS.map((s) => [s.id, adoGet(s)]));

// GitHub: checkout-web ----------------------------------------------------------------

const GHE = 'https://ghe.imagile.dev';
const GHE_API = `${GHE}/api/v3`;
const ghUser = (login: string, id: number, type: 'User' | 'Bot' = 'User') => ({ login, id, avatar_url: `${GHE}/avatars/u/${id}`, type });
const ADA = ghUser('ada-dev', 11);
const BO = ghUser('bo-web', 12);
const DEPENDABOT = ghUser('dependabot[bot]', 49699333, 'Bot');
const ghRepo = { full_name: 'imagile/payments-web', name: 'payments-web', owner: { login: 'imagile' } };

interface GhSpec {
  number: number;
  title: string;
  body: string;
  user: ReturnType<typeof ghUser>;
  branch: string;
  draft?: boolean;
  head: string;
  created: string;
  updated?: string;
  merged?: string;
  merge: string;
  requested?: Array<ReturnType<typeof ghUser>>;
  reviews?: Array<{ user: ReturnType<typeof ghUser>; state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED'; at: string }>;
  checks: Array<{ name: string; conclusion: 'success' | 'failure' | null; at: string }>;
  commits: string[];
  files: Array<{ path: string; additions: number; deletions: number }>;
  mergeable?: boolean | null;
}

const ghPr = (s: GhSpec) => ({
  url: `${GHE_API}/repos/imagile/payments-web/pulls/${s.number}`,
  id: 7000 + s.number,
  number: s.number,
  state: s.merged ? 'closed' : 'open',
  locked: false,
  title: s.title,
  user: s.user,
  body: s.body,
  draft: s.draft ?? false,
  html_url: `${GHE}/imagile/payments-web/pull/${s.number}`,
  created_at: s.created,
  updated_at: s.updated ?? s.merged ?? s.created,
  closed_at: s.merged ?? null,
  merged_at: s.merged ?? null,
  // GitHub sets this on open pull requests too, to the test merge; only merged_at says it merged.
  merge_commit_sha: sha(s.merge),
  requested_reviewers: s.requested ?? [],
  requested_teams: [],
  labels: [],
  head: { label: `imagile:${s.branch}`, ref: s.branch, sha: sha(s.head), repo: ghRepo },
  base: { label: 'imagile:main', ref: 'main', sha: sha('0a0a0a0'), repo: ghRepo },
});

const ghGet = (s: GhSpec) => ({
  ...ghPr(s),
  merged: Boolean(s.merged),
  mergeable: s.merged ? null : (s.mergeable === undefined ? true : s.mergeable),
  mergeable_state: s.merged ? 'unknown' : 'clean',
  comments: 0,
  review_comments: 0,
  commits: s.commits.length,
  additions: s.files.reduce((n, f) => n + f.additions, 0),
  deletions: s.files.reduce((n, f) => n + f.deletions, 0),
  changed_files: s.files.length,
  included: {
    reviews: (s.reviews ?? []).map((r, i) => ({ id: 90000 + s.number * 10 + i, user: r.user, body: '', state: r.state, submitted_at: r.at, commit_id: sha(s.head), author_association: 'MEMBER' })),
    checks: s.checks.map((c, i) => ({
      id: 8000 + s.number * 10 + i,
      name: c.name,
      head_sha: sha(s.head),
      status: c.conclusion === null ? 'in_progress' : 'completed',
      conclusion: c.conclusion,
      html_url: `${GHE}/imagile/payments-web/actions/runs/${8000 + s.number * 10 + i}/job/${8001 + s.number * 10 + i}`,
      started_at: c.at,
      completed_at: c.conclusion === null ? null : c.at,
      app: { slug: 'github-actions', name: 'GitHub Actions' },
    })),
    commits: s.commits.map((m, i) => ({ sha: sha(`${s.head.slice(0, 5)}${i}`), commit: { message: m, author: { name: s.user.login, email: 'you@example.com', date: s.created } }, author: s.user })),
    files: s.files.map((f) => ({ filename: f.path, status: 'modified', additions: f.additions, deletions: f.deletions, changes: f.additions + f.deletions })),
  },
});

const GH_SPECS: GhSpec[] = [
  {
    number: 53, title: 'Keep focus in the card form on Safari', body: 'Fixes #43.', user: BO, branch: 'fix/43-safari-focus', draft: true, head: '53d0e12', created: '2026-10-12T13:00:00Z', updated: '2026-10-12T13:25:00Z', merge: '53f9a00',
    checks: [{ name: 'test', conclusion: 'success', at: '2026-10-12T13:15:00Z' }, { name: 'e2e-safari', conclusion: 'failure', at: '2026-10-12T13:25:00Z' }],
    commits: ['Keep focus in the expiry field'], files: [{ path: 'src/checkout/card-form.tsx', additions: 18, deletions: 6 }],
  },
  {
    number: 52, title: 'Saved-card picker', body: 'Closes #42. Part of #41.', user: BO, branch: 'feature/saved-cards', head: '52c4b88', created: '2026-10-11T10:00:00Z', updated: '2026-10-11T10:28:00Z', merge: '52e7d00', requested: [ADA],
    checks: [{ name: 'test', conclusion: 'success', at: '2026-10-11T10:20:00Z' }, { name: 'e2e-safari', conclusion: 'success', at: '2026-10-11T10:28:00Z' }],
    commits: ['Add the saved-card picker', 'Show the expiry beside each card'],
    files: [{ path: 'src/checkout/saved-cards.tsx', additions: 210, deletions: 4 }, { path: 'src/checkout/saved-cards.test.tsx', additions: 96, deletions: 0 }, { path: 'src/checkout/card-form.tsx', additions: 12, deletions: 3 }],
  },
  {
    number: 51, title: 'Retry the address lookup once', body: 'The lookup service times out under load; retry once after 300 ms.', user: ADA, branch: 'claude/address-retry', head: '51a7f30', created: '2026-10-08T09:00:00Z', updated: '2026-10-09T08:10:00Z', merge: '51b0c00',
    checks: [{ name: 'test', conclusion: 'failure', at: '2026-10-09T08:10:00Z' }],
    commits: [message('Retry the address lookup once', CLAUDE)], files: [{ path: 'src/address/lookup.ts', additions: 31, deletions: 5 }, { path: 'src/address/lookup.test.ts', additions: 40, deletions: 0 }],
  },
  {
    number: 50, title: 'Use the order currency on receipts', body: 'Closes #44.', user: ADA, branch: 'fix/44-receipt-currency', head: '50b1c77', created: '2026-10-12T14:30:00Z', merged: '2026-10-12T15:55:00Z', merge: '5a7e3f1',
    reviews: [{ user: BO, state: 'APPROVED', at: '2026-10-12T15:20:00Z' }], checks: [{ name: 'test', conclusion: 'success', at: '2026-10-12T15:40:00Z' }],
    commits: ['Format receipts in the order currency'], files: [{ path: 'src/receipt/total.tsx', additions: 9, deletions: 4 }],
  },
  {
    number: 49, title: 'Bump vite from 7.1.2 to 7.1.5', body: 'Bumps vite from 7.1.2 to 7.1.5.', user: DEPENDABOT, branch: 'dependabot/npm_and_yarn/vite-7.1.5', head: '49c2d11', created: '2026-10-03T06:00:00Z', merged: '2026-10-05T09:30:00Z', merge: '49e0a00',
    reviews: [{ user: ADA, state: 'APPROVED', at: '2026-10-05T09:10:00Z' }], checks: [{ name: 'test', conclusion: 'success', at: '2026-10-03T06:20:00Z' }],
    commits: ['Bump vite from 7.1.2 to 7.1.5'], files: [{ path: 'package.json', additions: 1, deletions: 1 }, { path: 'package-lock.json', additions: 12, deletions: 12 }],
  },
  {
    number: 48, title: 'Order summary panel', body: 'From the checkout refresh designs.', user: ADA, branch: 'feature/order-summary', head: '48a9e66', created: '2026-10-01T09:00:00Z', merged: '2026-10-02T10:00:00Z', merge: '1c9b8e4',
    reviews: [{ user: BO, state: 'CHANGES_REQUESTED', at: '2026-10-01T14:00:00Z' }, { user: BO, state: 'APPROVED', at: '2026-10-02T09:00:00Z' }],
    checks: [{ name: 'test', conclusion: 'success', at: '2026-10-01T09:20:00Z' }],
    commits: ['Add the order summary panel', 'Round the subtotal as the designs show'], files: [{ path: 'src/checkout/summary.tsx', additions: 140, deletions: 2 }, { path: 'src/checkout/card-form.tsx', additions: 6, deletions: 1 }],
  },
];

/** `github pr list --state all` for checkout-web. */
export const GITHUB_PRS = GH_SPECS.map(ghPr);
/** `github pr get <number> --include reviews,checks,commits,files`, by number. */
export const GITHUB_PR_GETS: Record<number, unknown> = Object.fromEntries(GH_SPECS.map((s) => [s.number, ghGet(s)]));

/** The repository's CODEOWNERS, as `github repo file .github/CODEOWNERS` returns it: GitHub's contents record, and its text. */
export const CODEOWNERS_TEXT = '# Who reviews what\n* @ada-dev\nsrc/checkout/ @bo-web\nsrc/address/ @bo-web @ada-dev\n';
export const GITHUB_CODEOWNERS = {
  type: 'file',
  encoding: 'base64',
  size: CODEOWNERS_TEXT.length,
  name: 'CODEOWNERS',
  path: '.github/CODEOWNERS',
  // btoa, not Buffer: the Toil UI preview runs this fixture in a browser.
  content: btoa(CODEOWNERS_TEXT),
  sha: sha('c0de0e5'),
  html_url: `${GHE}/imagile/payments-web/blob/main/.github/CODEOWNERS`,
  text: CODEOWNERS_TEXT,
};

// Bitbucket Cloud: checkout-web's SDK ---------------------------------------------------

const BBC = 'https://bitbucket-cloud.imagile.dev';
const bbcUser = (nickname: string, display_name: string, n: number) => ({ display_name, nickname, type: 'user', uuid: `{abc12345-0000-0000-0000-0000000000${n}0}`, account_id: `557058:abc12345-0000-0000-0000-0000000000${n}0` });
const BO_C = bbcUser('bo-web', 'Bo W.', 1);
const ADA_C = bbcUser('ada-dev', 'Ada D.', 2);
const bbcRepo = { full_name: 'imagile/checkout-sdk', name: 'checkout-sdk', type: 'repository', uuid: '{abc12345-0000-0000-0000-000000000700}' };

interface BbcSpec {
  id: number;
  title: string;
  description: string;
  state: 'OPEN' | 'MERGED';
  author: ReturnType<typeof bbcUser>;
  branch: string;
  head: string;
  created: string;
  updated: string;
  merge?: string;
  reviewers: Array<{ user: ReturnType<typeof bbcUser>; state: 'approved' | 'changes_requested' | null }>;
  approvals: Array<{ user: ReturnType<typeof bbcUser>; at: string }>;
  statuses: Array<{ state: 'SUCCESSFUL' | 'FAILED' | 'INPROGRESS'; at: string }>;
  commits: string[];
  files: Array<{ path: string; added: number; removed: number }>;
}

const bbcPr = (s: BbcSpec) => ({
  type: 'pullrequest',
  id: s.id,
  title: s.title,
  description: s.description,
  summary: { type: 'rendered', raw: s.description, markup: 'markdown' },
  state: s.state,
  draft: false,
  author: s.author,
  source: { branch: { name: s.branch }, commit: { hash: s.head.padEnd(12, '0') }, repository: bbcRepo },
  destination: { branch: { name: 'main' }, commit: { hash: 'a0a0a0a0a0a0' }, repository: bbcRepo },
  ...(s.merge ? { merge_commit: { hash: s.merge.padEnd(12, '0') } } : { merge_commit: null }),
  comment_count: 0,
  task_count: 0,
  close_source_branch: true,
  created_on: s.created,
  updated_on: s.updated,
  reviewers: s.reviewers.map((r) => r.user),
  participants: s.reviewers.map((r) => ({ type: 'participant', user: r.user, role: 'REVIEWER', approved: r.state === 'approved', state: r.state, participated_on: r.state ? s.updated : null })),
  links: { html: { href: `${BBC}/imagile/checkout-sdk/pull-requests/${s.id}` }, self: { href: `${BBC}/2.0/repositories/imagile/checkout-sdk/pullrequests/${s.id}` } },
});

const bbcGet = (s: BbcSpec) => ({
  ...bbcPr(s),
  included: {
    reviews: s.approvals.map((a) => ({ approval: { date: a.at, user: a.user, pullrequest: { id: s.id, type: 'pullrequest' } }, pull_request: { id: s.id, type: 'pullrequest' } })),
    checks: s.statuses.map((st, i) => ({ type: 'commitstatus', key: `checkout-sdk-ci-${i}`, name: 'checkout-sdk CI', state: st.state, url: `${BBC}/imagile/checkout-sdk/pipelines/results/${s.id * 10 + i}`, created_on: st.at, updated_on: st.at })),
    commits: s.commits.map((m, i) => ({ type: 'commit', hash: `${s.head}${i}`.padEnd(40, '0'), message: m, author: { type: 'author', raw: `${s.author.display_name} <you@example.com>` }, date: s.created })),
    files: s.files.map((f) => ({ type: 'diffstat', status: 'modified', lines_added: f.added, lines_removed: f.removed, old: { path: f.path, type: 'commit_file' }, new: { path: f.path, type: 'commit_file' } })),
  },
});

const BBC_SPECS: BbcSpec[] = [
  {
    id: 12, title: 'Format receipt totals in the order currency', description: 'The SDK side of imagile/payments-web#44.', state: 'OPEN', author: BO_C, branch: 'copilot/receipt-currency', head: '12ab3c4',
    created: '2026-10-10T11:00:00.000000+00:00', updated: '2026-10-10T11:25:00.000000+00:00', reviewers: [{ user: ADA_C, state: null }], approvals: [],
    statuses: [{ state: 'SUCCESSFUL', at: '2026-10-10T11:25:00.000000+00:00' }], commits: ['Format totals with Intl.NumberFormat'], files: [{ path: 'src/money.ts', added: 22, removed: 7 }],
  },
  {
    id: 9, title: 'Saved-card hooks', description: 'useSavedCards and useDefaultCard, for imagile/payments-web#42.', state: 'MERGED', author: ADA_C, branch: 'feature/saved-card-hooks', head: '09cd5e6', merge: '9f1e2d3',
    created: '2026-10-06T08:30:00.000000+00:00', updated: '2026-10-07T12:00:00.000000+00:00', reviewers: [{ user: BO_C, state: 'approved' }], approvals: [{ user: BO_C, at: '2026-10-07T10:00:00.000000+00:00' }],
    statuses: [{ state: 'SUCCESSFUL', at: '2026-10-06T08:50:00.000000+00:00' }], commits: ['Add useSavedCards', 'Add useDefaultCard'],
    files: [{ path: 'src/hooks/saved-cards.ts', added: 120, removed: 0 }, { path: 'src/hooks/saved-cards.test.ts', added: 64, removed: 0 }],
  },
];

/** `bitbucket pr list --state ALL` on a Cloud connection for checkout-web's SDK. */
export const BITBUCKET_CLOUD_PRS = BBC_SPECS.map(bbcPr);
/** `bitbucket pr get <id> --include reviews,checks,commits,files`, by id. */
export const BITBUCKET_CLOUD_PR_GETS: Record<number, unknown> = Object.fromEntries(BBC_SPECS.map((s) => [s.id, bbcGet(s)]));

// As util owi map reads them ------------------------------------------------------------

const BB_AT = { project: 'PAY', repo: 'payments-core' };
const ADO_AT = { collection: 'DefaultCollection', project: 'Payments', repo: 'settlement' };
const GH_AT = { owner: 'imagile', repo: 'payments-web' };
const BBC_AT = { workspace: 'imagile', repo: 'checkout-sdk' };

/** Every list and get above, as envelopes: what `util owi map` maps to changes. */
export const prEnvelopes: unknown[] = [
  envelope('bitbucket pr list', BITBUCKET_PRS, 'corp-bitbucket', BB_AT, 'server'),
  ...Object.values(BITBUCKET_PR_GETS).map((d) => envelope('bitbucket pr get', d, 'corp-bitbucket', BB_AT, 'server')),
  envelope('ado pr list', ADO_PRS, 'corp-ado', ADO_AT),
  ...Object.values(ADO_PR_GETS).map((d) => envelope('ado pr get', d, 'corp-ado', ADO_AT)),
  envelope('github pr list', GITHUB_PRS, 'github', GH_AT),
  ...Object.values(GITHUB_PR_GETS).map((d) => envelope('github pr get', d, 'github', GH_AT)),
  envelope('bitbucket pr list', BITBUCKET_CLOUD_PRS, 'bitbucket-cloud', BBC_AT, 'cloud'),
  ...Object.values(BITBUCKET_CLOUD_PR_GETS).map((d) => envelope('bitbucket pr get', d, 'bitbucket-cloud', BBC_AT, 'cloud')),
];

/** The key patterns the toil projects give: Jira's PAY project, and the GitHub issues the SDK's pull requests name. */
export const PR_KEY_PATTERNS = ['PAY-{n}=corp-jira', 'imagile/payments-web#{n}=github'];

/** One envelope a line, as util owi map's example reads it (owi/pull-requests.jsonl). */
export const prJsonl = `${prEnvelopes.map((e) => JSON.stringify(e)).join('\n')}\n`;
