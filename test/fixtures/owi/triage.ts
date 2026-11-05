import { sprintEnvelopes } from './sprint.js';

/**
 * A triage inbox for `toil util owi similar`: the Sprint 42 fixture
 * (./sprint.ts) plus a week of newly filed work across Jira Data Center, Jira
 * Cloud, Azure DevOps Server and GitHub Enterprise, as their commands print
 * it. `util owi map` turns the lot into test/fixtures/owi/triage.owi.json,
 * which test/owi-similar.test.ts regenerates and the util examples read.
 *
 * Planted in it, and what the scorer should make of each:
 *
 * - **A cross-source duplicate:** corp-jira:PAY-210 "Card payments time out at
 *   checkout" and github:imagile/payments-web#51 "Checkout times out when
 *   paying by card", the same 504 told twice in different trackers.
 * - **Data Center against Cloud:** cloud-jira:WEB-31, an ADF body, is PAY-97
 *   (a double click charging twice) filed again on the Cloud site.
 * - **Within one tracker:** corp-ado:2312 asks again for 2302's settlement CSV.
 * - **A typo:** payments-web#53 "Recipt page shows wrong curency symbol" is
 *   #44, misspelt; only the title trigrams see two of its words.
 * - **A near-miss:** corp-jira:PAY-211 "Refund emails time out when the mail
 *   server is slow" shares "time out" with PAY-210 and nothing else, and
 *   should stay below the threshold.
 * - Noise: new work that resembles nothing (PAY-212, #52, 2313, WEB-32).
 *
 * Provenance: written by hand to the shapes the jira (Data Center and Cloud), ado and
 * github commands return, like ./sprint.ts; invented, not captured. Every
 * host is a placeholder and every name made up. A backlog with four
 * duplicates in eleven new items is, by industry standards, well kept.
 */

const VERSION = '0.1.0-alpha.1';
const JIRA = 'https://jira.imagile.dev';
const CLOUD = 'https://jira-cloud.imagile.dev';
const ADO = 'https://ado.imagile.dev/DefaultCollection';
const GHE = 'https://ghe.imagile.dev';

const envelope = (command: string, data: unknown, connection: string, inputs: Record<string, string> = {}) => ({
  ok: true,
  data,
  error: null,
  meta: {
    command,
    durationMs: 388,
    version: VERSION,
    context: {
      connection: { value: connection, source: 'default', default: 'named' },
      ...(Object.keys(inputs).length ? { inputs: Object.fromEntries(Object.entries(inputs).map(([k, value]) => [k, { value, source: 'toil-project' }])) } : {}),
    },
  },
});

// Jira Data Center: jira issue search --fields summary,description,status,issuetype,labels,created,updated

const TODO = { name: 'To Do', id: '10000', statusCategory: { id: 2, key: 'new', name: 'To Do' } };
const BUG = { name: 'Bug', id: '1', subtask: false };
const STORY = { name: 'Story', id: '10001', subtask: false };

const jiraIssue = (n: number, key: string, type: typeof BUG, summary: string, description: string, labels: string[], created: string) => ({
  id: String(20300 + n),
  self: `${JIRA}/rest/api/2/issue/${20300 + n}`,
  key,
  fields: {
    summary,
    description,
    issuetype: { self: `${JIRA}/rest/api/2/issuetype/${type.id}`, ...type },
    status: { self: `${JIRA}/rest/api/2/status/${TODO.id}`, ...TODO },
    labels,
    created,
    updated: created,
  },
});

const jiraSearch = {
  startAt: 0,
  maxResults: 50,
  total: 3,
  issues: [
    jiraIssue(
      10,
      'PAY-210',
      BUG,
      'Card payments time out at checkout',
      'Since the 1.6 release, paying by card at checkout times out after 30 seconds.\n\nh3. Steps\n# Add an item to the basket\n# Pay by card\n# The spinner runs, then a *504 Gateway Timeout* from the payment gateway\n\nSee [the gateway dashboard|https://dynatrace.imagile.dev/gateway].',
      ['payments', 'checkout'],
      '2026-10-13T09:10:00.000+0000',
    ),
    jiraIssue(11, 'PAY-211', BUG, 'Refund emails time out when the mail server is slow', 'The refund confirmation job gives up after 10 seconds when SMTP is slow, and the customer never hears back.', ['payments', 'refunds'], '2026-10-13T11:40:00.000+0000'),
    jiraIssue(12, 'PAY-212', STORY, 'Let merchants download invoices as PDF', 'Merchants want a PDF of each monthly invoice from the portal.', ['payments', 'invoicing'], '2026-10-14T08:05:00.000+0000'),
  ],
};

// Jira Cloud: jira issue search on a Cloud connection, with the description in Atlassian Document Format

const adf = (...paragraphs: string[]) => ({ type: 'doc', version: 1, content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })) });

const cloudIssue = (n: number, key: string, type: typeof BUG, summary: string, description: ReturnType<typeof adf>, labels: string[], created: string) => ({
  id: String(10500 + n),
  self: `${CLOUD}/rest/api/3/issue/${10500 + n}`,
  key,
  fields: {
    summary,
    description,
    issuetype: { self: `${CLOUD}/rest/api/3/issuetype/${type.id}`, ...type },
    status: { self: `${CLOUD}/rest/api/3/status/${TODO.id}`, ...TODO },
    labels,
    created,
    updated: created,
  },
});

const cloudSearch = {
  issues: [
    cloudIssue(1, 'WEB-31', BUG, 'Double click on Pay charges the card twice', adf('Clicking Pay twice quickly sends two charges.', 'The customer is charged twice for one order.'), ['payments'], '2026-10-14T13:20:00.000+0000'),
    cloudIssue(2, 'WEB-32', STORY, 'Dark mode for the merchant portal', adf('Offer a dark theme in the portal settings.'), ['portal'], '2026-10-15T10:00:00.000+0000'),
  ],
  nextPageToken: null,
  isLast: true,
};

// Azure DevOps Server: ado work-item get-many

const adoItem = (id: number, type: string, title: string, description: string, tags: string, created: string) => ({
  id,
  rev: 1,
  fields: {
    'System.AreaPath': 'Payments\\Settlement',
    'System.TeamProject': 'Payments',
    'System.IterationPath': 'Payments',
    'System.WorkItemType': type,
    'System.State': 'New',
    'System.Reason': 'New',
    'System.CreatedDate': created,
    'System.ChangedDate': created,
    'System.Title': title,
    'System.Description': description,
    'System.Tags': tags,
  },
  relations: [],
  _links: { self: { href: `${ADO}/_apis/wit/workItems/${id}` }, html: { href: `${ADO}/Payments/_workitems/edit/${id}` } },
  url: `${ADO}/_apis/wit/workItems/${id}`,
});

const adoBatch = {
  count: 2,
  value: [
    adoItem(2312, 'User Story', 'Export daily settlement CSV per merchant', '<p>Write one <b>CSV</b> per merchant every night at 02:00 UTC, for the daily settlement.</p>', 'settlement', '2026-10-13T10:00:00Z'),
    adoItem(2313, 'Bug', 'Chargeback import skips rows with a BOM', '<div>The chargeback file from the acquirer starts with a byte-order mark, and the first row is dropped.</div>', 'settlement; chargebacks', '2026-10-15T14:30:00Z'),
  ],
  missing: [],
};

// GitHub Enterprise: github issue list

const ghIssue = (number: number, title: string, body: string, labels: string[], created: string) => ({
  id: 9000 + number,
  number,
  title,
  state: 'open',
  state_reason: null,
  body,
  html_url: `${GHE}/imagile/payments-web/issues/${number}`,
  repository_url: `${GHE}/api/v3/repos/imagile/payments-web`,
  user: { login: 'ada-dev', id: 11, type: 'User' },
  labels: labels.map((name, i) => ({ id: 600 + i, name, color: 'd73a4a', description: null })),
  assignees: [],
  type: { id: 2, name: 'Bug', node_id: 'IT_kwDOabc12345Bug', description: null, color: 'gray' },
  parent_issue_url: null,
  created_at: created,
  updated_at: created,
  closed_at: null,
});

const ghIssues = [
  ghIssue(51, 'Checkout times out when paying by card', 'Customers paying by **card** see a spinner at checkout, then a `504 Gateway Timeout`.\n\nStarted after release 1.6. [Trace](https://ghe.imagile.dev/imagile/payments-web/actions/runs/88).', ['bug', 'checkout'], '2026-10-14T07:55:00Z'),
  ghIssue(52, 'Add Apple Pay to checkout', 'Offer Apple Pay as a payment method on Safari and iOS.', ['checkout'], '2026-10-14T09:30:00Z'),
  ghIssue(53, 'Recipt page shows wrong curency symbol', 'Euro receipts display a dollar sign.', ['bug'], '2026-10-15T16:45:00Z'),
];

/** The new week's envelopes alone. */
export const triageEnvelopes: unknown[] = [
  envelope('jira issue search', jiraSearch, 'corp-jira'),
  envelope('jira issue search', cloudSearch, 'cloud-jira'),
  envelope('ado work-item get-many', adoBatch, 'corp-ado', { collection: 'DefaultCollection', project: 'Payments' }),
  envelope('github issue list', ghIssues, 'github', { owner: 'imagile', repo: 'payments-web' }),
];

/** Sprint 42 and the new week, one envelope a line: the input `util owi map` turns into triage.owi.json. */
export const triageJsonl = `${[...sprintEnvelopes, ...triageEnvelopes].map((e) => JSON.stringify(e)).join('\n')}\n`;
