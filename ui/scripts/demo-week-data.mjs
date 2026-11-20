// What demo-week.mjs and its tests share, with no side effects on import: the
// sandboxes it may write to, the demo code an agent changes (the same in GitHub's
// toil-sandbox and ADO's settlement-service), and the text of the three
// "ready for an agent" items. ui/test/demo-week.test.ts runs the demo code's own
// tests offline. It also holds the ticket-rule demo (#657): the text the seeded
// stories and bugs carry so the three built-in rule sets (gherkin, user-story,
// bug-repro) find a few named gaps on camera and pass everything else, and a
// small copy of those three checks so the seeds can look before they write.
// Repo tooling only: nothing here ships. The acceptance criteria were written
// before the work, which is how you can tell they are fictional.

export const DEMO_NOTE = 'Made-up demo data for Toil UI recordings.';

/** The only places demo-week writes: the CLAUDE.md test projects, never a flag's choice. */
export const SANDBOX = { owner: 'imagile-dev', repo: 'toil-sandbox', jiraProject: 'SCRUM', adoProject: 'Toil Sandbox' };

// The code an agent can change: tiny, tested, and the same in both repositories.
export const SKELETON = {
  // Two real, old releases with published advisories, so `toil deps scan` and `toil osv vulns`
  // have something true to say; nothing installs or runs them (the tests use none).
  'package.json': JSON.stringify({ name: 'payments-demo', private: true, type: 'module', scripts: { test: 'node --test' }, description: DEMO_NOTE, dependencies: { express: '4.19.2', jsonwebtoken: '8.5.1' } }, null, 2) + '\n',
  'src/money.js': `// Amounts are held in cents. ${DEMO_NOTE}
/** 12.34 -> 1234. */
export function toCents(dollars) {
  return Math.round(dollars * 100);
}

/** 1234 -> "12.34 USD". Negative amounts print as "-12.34 USD" and there are no thousands separators yet. */
export function formatAmount(cents) {
  return \`\${(cents / 100).toFixed(2)} USD\`;
}
`,
  'src/logger.js': `// Request logging for the payments service. ${DEMO_NOTE}
/** Prints a payment method at debug level. It prints the whole object today, card number included. */
export function describePaymentMethod(method) {
  return \`payment method \${JSON.stringify(method)}\`;
}
`,
  'src/refunds.js': `// Refund requests. ${DEMO_NOTE}
export const REASON_CODES = ['duplicate', 'fraudulent', 'requested_by_customer', 'product_not_received'];

/** Builds a refund request. The reason is not checked against REASON_CODES yet. */
export function createRefund({ paymentId, amount, reason }) {
  if (!paymentId) throw new Error('paymentId is required');
  if (!(amount > 0)) throw new Error('amount must be positive');
  return { paymentId, amount, reason, status: 'pending' };
}
`,
  'test/money.test.js': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatAmount, toCents } from '../src/money.js';

test('toCents keeps cents', () => assert.equal(toCents(12.34), 1234));
test('formatAmount prints two decimals', () => assert.equal(formatAmount(1234), '12.34 USD'));
test('formatAmount prints zero', () => assert.equal(formatAmount(0), '0.00 USD'));
`,
  'test/refunds.test.js': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRefund } from '../src/refunds.js';

test('createRefund starts pending', () => assert.equal(createRefund({ paymentId: 'pay_1', amount: 5, reason: 'duplicate' }).status, 'pending'));
test('createRefund refuses a zero amount', () => assert.throws(() => createRefund({ paymentId: 'pay_1', amount: 0, reason: 'duplicate' })));
`,
};

/** The "ready for an agent" items: small, specified, with the files and the check named. Each passes every ticket rule. */
export const AGENT_ITEMS = {
  github: {
    title: 'Format amounts as US dollars in formatAmount',
    body: `As a merchant reading a statement, I want amounts printed as US dollars, so that statements and the payout preview read like money.

formatAmount in src/money.js prints \`-123450\` cents as "-1234.50 USD". Statements and the payout preview need "-$1,234.50".

### Steps to reproduce
1. On the default branch, call \`formatAmount(-123450)\` from \`src/money.js\`.

### Expected
\`-$1,234.50\`

### Actual
\`-1234.50 USD\`

**Change:** in \`src/money.js\`, make \`formatAmount(cents)\` return a dollar sign, thousands separators and two decimals, with a leading minus for negative amounts. Don't use \`Intl.NumberFormat\` with a locale argument from the environment; the output must not depend on the machine.

### Acceptance criteria
- [ ] Given 123450 cents
  When \`formatAmount\` runs
  Then it returns \`'$1,234.50'\`
- [ ] Given -123450 cents
  When \`formatAmount\` runs
  Then it returns \`'-$1,234.50'\`
- [ ] Given 5 cents, and then 0 cents
  When \`formatAmount\` runs
  Then it returns \`'$0.05'\`, and then \`'$0.00'\`
- [ ] Given 100000000 cents
  When \`formatAmount\` runs
  Then it returns \`'$1,000,000.00'\`
- [ ] Given the change, with its tests updated in \`test/money.test.js\`
  When \`npm test\` runs
  Then it passes, and no other file has changed

Follows the money standard in Confluence (space OD). Ready for an agent: about 30 minutes, one file and its test. ${DEMO_NOTE}`,
  },
  jira: {
    summary: 'Add maskPan() so debug logs never print a full card number',
    description: `As a support engineer reading debug logs, I want card numbers masked to their last four digits, so that no log line ever holds a full card number.

describePaymentMethod in src/logger.js (repository imagile-dev/toil-sandbox) prints the whole payment method, card number included.

Change: add src/mask.js exporting maskPan(pan), which keeps the last four digits and replaces every other digit with "*" ("4242424242424242" becomes "************4242"). Use it in describePaymentMethod for the number field.

Acceptance criteria
Given the card number '4242424242424242'
When maskPan runs on it
Then it returns '************4242'
Given a value with fewer than 4 digits
When maskPan runs on it
Then every digit comes back masked
Given the payment method { number: '4242424242424242', brand: 'visa' }
When describePaymentMethod prints it
Then the output no longer contains the full number
Given the change, with tests in test/mask.test.js
When npm test runs
Then it passes

Ready for an agent: about 30 minutes, two files and a test. ${DEMO_NOTE}`,
  },
  ado: {
    title: 'Refuse a refund whose reason is not a known reason code',
    description: `<p>As a settlement analyst, I want a refund with an unknown reason refused when it's created, so that every refund reaches the ledger with a reason code the dispute webhook understands.</p>
<p>createRefund in src/refunds.js (repository settlement-service) accepts any reason.</p>
<p><b>Change:</b> throw an Error naming the allowed codes when <code>reason</code> is not in <code>REASON_CODES</code>.</p>
<p>Ready for an agent: about 20 minutes, one file and its test. ${DEMO_NOTE}</p>`,
    criteria: `<p>Given a refund for pay_1 of 5 with reason 'duplicate'</p>
<p>When createRefund runs</p>
<p>Then it still returns a pending refund</p>
<p>Given a refund with reason 'other'</p>
<p>When createRefund runs</p>
<p>Then it throws, and the message lists the four codes</p>
<p>Given the change, with tests in test/refunds.test.js</p>
<p>When npm test runs</p>
<p>Then it passes</p>`,
  },
};

// Ticket rules (#657) --------------------------------------------------------------------
//
// What the three built-in rule sets find in the seeded sandboxes. The seeds share
// keys between Jira and Azure DevOps (`seed:cp-pbi-2` is SCRUM-15 and ADO #153), so
// each story's text is written once and laid out per tracker: Jira gets it all in
// the description (toil reads acceptance criteria from its "Acceptance criteria"
// section), ADO puts the story in System.Description and the scenarios in
// Microsoft.VSTS.Common.AcceptanceCriteria. A few named items are left thin on
// purpose, so "Fix with AI agent" has something to fix. Jira's bugs are Tasks
// labelled `bug` (toil reads them as TASK) and GitHub's sandbox issues have no
// issue type (OTHER), so the bug rules land on ADO's Bugs alone, and the one bug
// left without repro steps is ADO's.

/** The rule a miss names, as `standard/rule`. */
export const RULES = {
  gherkin: 'gherkin/scenarios',
  userStory: 'user-story/story-form',
  steps: 'bug-repro/steps',
  expected: 'bug-repro/expected',
  actual: 'bug-repro/actual',
};

/** The stories, by seed key: the story line, a line of context, and the scenarios as Given/When/Then lines. */
export const STORIES = {
  'demo-load': {
    story: 'As a payouts on-call engineer, I want the scheduler load tested at three times November volume, so that Black Friday payouts go out on time.',
    context: 'November volume peaked at 41,000 payouts an hour. The test runs against staging with the replica\'s merchants.',
    criteria: ['Given staging at three times November\'s peak hour of payouts', 'When the scheduler runs for an hour', 'Then every payout is scheduled within its window and none is scheduled twice'],
    // Thin on purpose (SCRUM-2): a task written as a story, with no "As a … so that".
    lead: 'Load test the payout scheduler at three times November volume before the Black Friday freeze.',
  },
  'cp-pbi-1': {
    story: 'As a merchant, I want stored card tokens kept in the vault for 13 months, so that a returning customer can pay without typing their card again.',
    criteria: ['Given a card saved at checkout', 'When the vault stores its token', 'Then the token expires 13 months later and the card number is never stored outside the vault'],
  },
  'cp-pbi-2': {
    story: 'As a merchant, I want to charge a stored token, so that subscriptions and repeat orders don\'t need the card again.',
    criteria: ['Given a customer with a stored token', 'When the merchant charges it for $25.00', 'Then the processor captures $25.00 against the token and the card number never leaves the vault'],
    // Thin on purpose (SCRUM-15): criteria as plain bullets, not scenarios.
    plain: ['Charging a stored token works', 'The card number never leaves the vault', 'Errors are handled'],
  },
  'cp-pbi-3': {
    story: 'As a merchant, I want the card scheme looked up from the BIN, so that the right scheme fees apply.',
    criteria: ['Given a card number starting 4242 42', 'When the gateway looks up its BIN', 'Then the scheme is Visa'],
  },
  'cp-pbi-4': {
    story: 'As a security engineer, I want card numbers masked in the gateway logs, so that a log never holds a full card number.',
    criteria: ['Given a payment request with the card number 4242424242424242', 'When the gateway logs it at debug level', 'Then the log shows ************4242 and never the full number'],
  },
  'cp-pbi-5': {
    story: 'As a platform engineer, I want card numbers tokenised at the edge, so that the core service never sees a card number.',
    criteria: ['Given a checkout request with a card number', 'When it passes the edge proxy', 'Then the core service receives a token in its place'],
    // Thin on purpose (SCRUM-17).
    plain: ['Card numbers are tokenised at the edge', 'The core service never sees a card number'],
  },
  'st-pbi-1': {
    story: 'As a settlement analyst, I want settlement batches read from the ledger, so that the daily totals match what finance books.',
    criteria: ['Given yesterday\'s batches in the ledger', 'When the settlement job runs', 'Then each batch total matches the ledger to the cent'],
  },
  'st-pbi-2': {
    story: 'As a merchant, I want fees and interchange on separate lines of my payout statement, so that I can check what each card type cost me.',
    criteria: ['Given a payout with $12.40 in fees and $31.10 in interchange', 'When the merchant opens the payout statement', 'Then fees and interchange show on separate lines that add up to the total deducted'],
    // Thin on purpose (SCRUM-23): a request, not a story.
    lead: 'Finance asked for fees and interchange on separate lines of the payout statement.',
  },
  'st-pbi-3': {
    story: 'As a settlement analyst, I want settlements grouped by merchant, so that each merchant\'s payout comes from one batch.',
    criteria: ['Given a day of captured payments for six merchants', 'When the settlement job groups them', 'Then there is one settlement per merchant and the six add up to the day\'s captures'],
  },
  'st-pbi-4': {
    story: 'As a finance analyst, I want the daily settlement CSV exported, so that I can reconcile it in the general ledger.',
    criteria: ['Given yesterday\'s settlements', 'When the export runs at 06:00 Eastern', 'Then a CSV with one row per settlement is in the finance share, with merchant names quoted'],
  },
  'st-pbi-5': {
    story: 'As a settlement analyst, I want chargebacks reconciled against settlements, so that a disputed payment never pays out twice.',
    criteria: ['Given a chargeback on a payment settled last week', 'When reconciliation runs', 'Then the chargeback is deducted from the merchant\'s next payout'],
  },
  'cw-pbi-1': {
    story: 'As a checkout engineer, I want an end-to-end test for 3-D Secure, so that a change to the challenge flow can\'t ship broken.',
    criteria: ['Given the hosted checkout with a 3-D Secure test card', 'When the shopper completes the challenge', 'Then the payment is captured and the confirmation page shows'],
  },
  'cw-pbi-2': {
    story: 'As a shopper, I want my basket kept when the 3-D Secure challenge times out, so that I can try again without starting over.',
    criteria: ['Given a basket of three items at checkout', 'When the 3-D Secure challenge times out', 'Then the shopper returns to checkout with the same three items'],
  },
  'cw-pbi-3': {
    story: 'As a shopper, I want a declined payment explained in plain words, with what to try next, so that I know whether to retry or use another card.',
    criteria: ['Given a payment declined for insufficient funds', 'When the checkout shows the decline', 'Then it says the bank declined it and suggests another card, without the processor\'s code'],
    // Thin on purpose (SCRUM-32).
    // The bullets carry everything a scenario needs (the decline reason, what the page says, what to try), so a fix
    // can be written without gaps; only the form is missing, which is the point of the demo.
    plain: [
      'A payment declined for insufficient funds is explained on the checkout page as "Your bank declined this payment", never with the processor\'s code',
      'After that decline, the page suggests paying with another card, and keeps the basket as it was',
    ],
  },
  'cw-pbi-4': {
    story: 'As a shopper, I want to see my card brand\'s icon as I type, so that I know the number was read right.',
    criteria: ['Given the card form', 'When the shopper types 4242', 'Then the Visa icon shows, with the text "Visa" for screen readers'],
  },
  'cw-pbi-5': {
    story: 'As a shopper, I want to remove a saved card, so that a card I no longer use isn\'t offered at checkout.',
    criteria: ['Given a shopper with two saved cards', 'When they remove one', 'Then checkout offers only the other, and the vault deletes the removed token'],
  },
  // jira-seed.mjs's stories, kept for classification: their first sentence stays as it was.
  'cls-feature': {
    story: 'As a merchant, I want to choose a weekly payout schedule, so that payouts match how I pay my suppliers.',
    context: 'Merchants can pick daily or weekly payouts on their settings page. Already labelled as new work.',
    criteria: ['Given a merchant on daily payouts', 'When they choose weekly on the settings page', 'Then their next payout is the coming Friday and covers the whole week'],
  },
  'cls-ambiguous': {
    story: 'As a merchant support agent, I want search to tolerate typos, so that I find a merchant whose name I misspell.',
    context: 'The title opens with "Upgrade", so a title signal reads it as upkeep, but it exists to ship a new capability. A person should correct it.',
    criteria: ['Given a merchant called Harbor Books', 'When support searches for "Harbr Boks"', 'Then Harbor Books is the first result'],
  },
  'cls-unsure': {
    story: 'As a merchant, I want the settlement currency on the payout page, so that I know what I\'ll be paid in.',
    context: 'Nothing here says whether this is new work or upkeep: no label, no parent and no telling title.',
    criteria: ['Given a merchant settled in USD', 'When they open the payout page', 'Then each payout shows USD beside its amount'],
  },
};

/** ADO's bugs, by seed key: the steps, what should happen, and what happens. */
export const BUGS = {
  'cp-bug-1': { steps: ['Save a card that expires 12/2027', 'Charge the stored token'], expected: 'The card is read as expiring December 2027 and the charge goes through.', actual: 'The card is read as expiring December 2026 and the charge is declined as expired.' },
  'cp-bug-2': { steps: ['Make the processor sandbox time out', 'Submit a card payment', 'Read the gateway log'], expected: 'The log has the masked card number and no CVV.', actual: 'The timeout line prints the CVV.' },
  'cp-bug-3': { steps: ['Open the hosted checkout with a test card', 'Double-click Pay'], expected: 'One capture.', actual: 'Two captures on the same idempotency key.' },
  'cp-bug-4': { steps: ['Store a card for a merchant that settles in CAD', 'Charge the stored token'], expected: 'The charge is in CAD.', actual: 'The charge is in USD.' },
  'st-bug-1': { steps: ['Open a chargeback in EUR on a payment from last week', 'Run reconciliation'], expected: 'The chargeback is counted at the rate on the day of the payment.', actual: 'It is counted at today\'s rate.' },
  'st-bug-2': { steps: ['Set a merchant\'s time zone to UTC-5', 'Capture a payment at 20:00 local time', 'Run the settlement job'], expected: 'The payment settles in that day\'s batch.', actual: 'It settles in the next day\'s batch, a day early on the statement.' },
  'st-bug-3': { steps: ['Capture $100.00 and refund $20.00 the same day', 'Run the settlement job'], expected: 'The batch total is $80.00.', actual: 'The batch total is $100.00.' },
  'st-bug-4': { steps: ['Settle a payment for the merchant "Paper Crane, Stationery"', 'Export the daily CSV'], expected: 'One row, with the name quoted.', actual: 'The name is split across two columns.' },
  'cw-bug-1': { steps: ['Pay in Safari', 'Press Back on the confirmation page'], expected: 'The confirmation page stays, or the basket shows as paid.', actual: 'The card form shows again and invites a second payment.' },
  'cw-bug-2': { steps: ['Open the hosted checkout at 375 px wide', 'Pay with a 3-D Secure test card'], expected: 'The challenge fits the screen.', actual: 'The right third of the challenge is cut off.' },
  'cw-bug-3': { steps: ['Sign in as a shopper with one expired and one current saved card', 'Open checkout'], expected: 'The current card is first and the expired one is marked expired.', actual: 'The expired card is first and selected.' },
  'cw-bug-4': {
    steps: ['Pay for a basket from a merchant that settles in CAD', 'Open the receipt'],
    expected: 'The receipt shows CA$.',
    actual: 'The receipt shows $.',
    // Thin on purpose (ADO #193): a report, with no steps, expected or actual.
    thin: 'Seen on a customer\'s receipt last week; nobody has reproduced it yet.',
  },
};

/** The items left thin on purpose, by tracker and seed key, and what each misses. Everything else seeded passes. */
export const RULE_GAPS = {
  jira: {
    'cp-pbi-2': [RULES.gherkin], // SCRUM-15 Charge a stored token
    'cp-pbi-5': [RULES.gherkin], // SCRUM-17 Tokenise card numbers at the edge
    'cw-pbi-3': [RULES.gherkin], // SCRUM-32 Explain a declined payment in plain words
    'demo-load': [RULES.userStory], // SCRUM-2 Load test the payout scheduler
    'st-pbi-2': [RULES.userStory], // SCRUM-23 Show fees and interchange separately
  },
  ado: {
    'cw-bug-4': [RULES.steps, RULES.expected, RULES.actual], // #193 Receipt page shows the wrong currency symbol
  },
};

const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A Jira story's description, as plain text (toil sends it as ADF paragraphs, a line break kept as a hard break). */
export function jiraStory(key) {
  const s = STORIES[key];
  const gaps = RULE_GAPS.jira[key] ?? [];
  const first = gaps.includes(RULES.userStory) ? s.lead : s.story;
  const criteria = gaps.includes(RULES.gherkin) ? s.plain.map((l) => `- ${l}`) : s.criteria;
  return [first, s.context, `Acceptance criteria\n${criteria.join('\n')}`, DEMO_NOTE].filter(Boolean).join('\n\n');
}

/** An ADO story's System.Description and AcceptanceCriteria, as HTML. ADO's stories have no gaps. */
export function adoStory(key) {
  const s = STORIES[key];
  return {
    description: [s.story, s.context, DEMO_NOTE].filter(Boolean).map((l) => `<p>${escapeHtml(l)}</p>`).join(''),
    criteria: s.criteria.map((l) => `<p>${escapeHtml(l)}</p>`).join(''),
  };
}

/** An ADO bug's Microsoft.VSTS.TCM.ReproSteps, as HTML: three headed sections, or the thin report. */
export function adoRepro(key) {
  const b = BUGS[key];
  if (RULE_GAPS.ado[key]?.length) return `<p>${escapeHtml(b.thin)}</p>`;
  return `<h3>Steps to reproduce</h3><ol>${b.steps.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ol><h3>Expected</h3><p>${escapeHtml(b.expected)}</p><h3>Actual</h3><p>${escapeHtml(b.actual)}</p>`;
}

// A small copy of the three built-in rule sets (src/core/standards/builtin.ts),
// so the seeds can look before they write; ui/test/demo-week.test.ts holds the
// copy to the original. Two check kinds are all the presets use: every pattern
// must hit, or one of the headings must have words under it.

/** The presets' rules: which work item type each applies to, where it looks, and its check. */
export const PRESET_RULES = [
  { rule: RULES.gherkin, type: 'STORY', in: ['criteria'], match: ['^\\W*given\\b', '^\\W*when\\b', '^\\W*then\\b'], flags: 'im' },
  { rule: RULES.userStory, type: 'STORY', in: ['description'], match: ['\\bas an? [^,\\n]{1,80},? i want\\b[^\\n]{1,300}\\bso that\\b'], flags: 'i' },
  { rule: RULES.steps, type: 'BUG', in: ['field:Microsoft.VSTS.TCM.ReproSteps', 'description'], heading: ['Steps to reproduce', 'Repro steps', 'Steps'] },
  { rule: RULES.expected, type: 'BUG', in: ['field:Microsoft.VSTS.TCM.ReproSteps', 'description'], heading: ['Expected', 'Expected result', 'Expected behavior'] },
  { rule: RULES.actual, type: 'BUG', in: ['field:Microsoft.VSTS.TCM.ReproSteps', 'description'], heading: ['Actual', 'Actual result', 'Actual behavior'] },
];

const isRec = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const htmlText = (html) =>
  html
    .replace(/<h([1-6])\b[^>]*>/gi, (_, n) => `\n${'#'.repeat(Number(n))} `)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/ul|\/ol)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|[a-z]+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m)));
const adfText = (node) => {
  if (!isRec(node)) return '';
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return '\n';
  const inner = (node.content ?? []).map(adfText).join('');
  if (node.type === 'heading') return `\n${'#'.repeat(node.attrs?.level ?? 1)} ${inner}\n`;
  if (node.type === 'listItem') return `\n- ${inner}\n`;
  return ['paragraph', 'blockquote', 'codeBlock'].includes(node.type) ? `\n${inner}\n` : inner;
};

/** A body or field as lines of text: Atlassian Document Format, HTML or plain. */
export function textOf(value) {
  if (isRec(value)) return adfText(value);
  if (typeof value !== 'string') return '';
  return /<\/?[a-z][\s\S]*?>/i.test(value) ? htmlText(value) : value;
}

/** A body's words with the layout gone, to tell whether a tracker holds the text a seed wrote (ADO reflows HTML, Jira stores ADF). */
export const flatText = (value) => textOf(value).replace(/\s+/g, ' ').trim();

const WORDS = /[\p{L}\p{N}]/u;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// As src/core/standards/text.ts reads a section: a heading line (`## Expected`, `**Expected**`,
// `Expected:`, `Expected: text`), then the lines up to the next heading-shaped line.
const SECTION_BREAK = /^\s*(?:#{1,6}\s+\S.*|\*{1,2}[^*\n]{1,80}\*{1,2}:?\s*|[^:\n]{1,40}:\s*)$/;
/** The text under the first line that is one of `headings`, or undefined. */
function sectionUnder(text, headings) {
  const re = new RegExp(`^(?:#{1,6} *)?(?:\\*{1,2})?(${headings.map(escapeRe).join('|')}) *(?:\\*{1,2})?(?: *: *(?:\\*{1,2})? *(.*))?$`, 'i');
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i].trim());
    if (!m) continue;
    const under = m[2] ? [m[2]] : [];
    for (let j = i + 1; j < lines.length && !SECTION_BREAK.test(lines[j]); j++) under.push(lines[j]);
    return under.join('\n');
  }
  return undefined;
}
const hasWords = (text) => WORDS.test(text ?? '');
/** The acceptance criteria: ADO's field when it has words, else the description's "Acceptance criteria" section, else the whole description. */
function criteriaOf(description, criteria) {
  if (hasWords(criteria)) return criteria;
  const section = sectionUnder(description, ['Acceptance criteria', 'Acceptance criterion', 'Definition of done', 'Done when']);
  return hasWords(section) ? section : description;
}

/**
 * The rules an item misses, as `standard/rule`, in PRESET_RULES order. `type` is
 * toil's (STORY, BUG); the texts are the raw values (ADF, HTML or plain), each
 * optional.
 */
export function ruleMisses({ type, description, criteria, reproSteps }) {
  const d = textOf(description);
  const places = { description: d, criteria: criteriaOf(d, textOf(criteria)), 'field:Microsoft.VSTS.TCM.ReproSteps': textOf(reproSteps) };
  return PRESET_RULES.filter((r) => r.type === type)
    .filter((r) => {
      const text = r.in.map((p) => places[p] ?? '').join('\n');
      return r.match ? !r.match.every((m) => new RegExp(m, r.flags).test(text)) : !hasWords(sectionUnder(text, r.heading));
    })
    .map((r) => r.rule);
}

/** toil's type for a tracker's type name, for the types the rules look at. */
export const typeOfName = (name) => ({ story: 'STORY', 'user story': 'STORY', 'product backlog item': 'STORY', requirement: 'STORY', bug: 'BUG', defect: 'BUG' })[String(name).toLowerCase()] ?? 'OTHER';

// The sprint plan ----------------------------------------------------------------------
//
// What the blocker timeline (Dependencies tab) draws: each chain's items due one after
// another across the sprint's ten working days, so the sprint reads as a plan as well
// as a history, and one blocked item (SCRUM-15, held by the vault work) already past
// its due date. The day is the sprint's working day, 0 for its first Monday, so a new
// --ends moves the plan with it. Jira holds a due date on every issue; Azure DevOps'
// Scrum stories and bugs may have no Target Date, so its writes are tried and a
// refusal is said, not fatal. GitHub issues have no due date toil reads, so the
// GitHub chain (#11 -> #12 -> #17 -> #18) shows its waits and no plan.

/** Jira issue key to the working day of the sprint it is due. Done issues have none. */
export const JIRA_DUE_DAYS = {
  'SCRUM-15': 1, // Charge a stored token: due Tuesday, still waiting on the vault (SCRUM-14)
  'SCRUM-14': 3, // Store tokens in the vault
  'SCRUM-43': 3, // Backfill three months of settlement batches
  'SCRUM-24': 4, // Group settlements by merchant, after the vault
  'SCRUM-17': 5, // Tokenise card numbers at the edge, after the vault
  'SCRUM-23': 5, // Show fees and interchange separately
  'SCRUM-18': 6, // Expiry month 12, after the edge
  'SCRUM-21': 7, // Stored-card charge currency, after the edge
  'SCRUM-33': 7, // Show card brand icons
  'SCRUM-25': 8, // Export the daily settlement CSV, after fees and the backfill
  'SCRUM-30': 9, // End-to-end test for 3-D Secure, last
};

/**
 * Blocks links demo-week makes in Jira, as [blocker, blocked]. With the seed's own
 * (SCRUM-14 blocks 15, 17 and 24; 17 blocks 18, 21 and 30) they make the vault chain
 * SCRUM-14 -> 17 -> 18 -> 21 -> 30, 18 points, the heaviest chain of open blockers, so
 * the critical chain is the one with a plan to draw.
 */
export const JIRA_BLOCKS = [
  ['SCRUM-14', 'SCRUM-15'],
  ['SCRUM-18', 'SCRUM-21'],
  ['SCRUM-21', 'SCRUM-30'],
];

/**
 * The GitHub estimate demo-week sets, by title prefix: the rolling reserve is 3 points,
 * not seed-sandbox's 8, so the GitHub chain #11 -> #12 -> #17 -> #18 holds 16 points
 * and the Jira vault chain's 18 lead.
 */
export const GITHUB_POINTS = { 'Rolling reserve': 3 };

/** ADO seed key to the working day it is due (Microsoft.VSTS.Scheduling.TargetDate). */
export const ADO_DUE_DAYS = { 'cp-pbi-1': 4, 'st-pbi-3': 6 };

/**
 * The ado-seed's dependency links that copy a Jira chain item for item (the same
 * stories are in both trackers), as [blocker, blocked] seed keys. The timeline
 * would draw each chain twice, so demo-week takes these off; #152 -> #169
 * (cp-pbi-1 -> st-pbi-3), the one the demo story names, stays.
 */
export const ADO_DUPLICATE_BLOCKS = [
  ['cp-pbi-1', 'cp-pbi-5'],
  ['cp-pbi-5', 'cp-bug-1'],
  ['cp-pbi-5', 'cw-pbi-1'],
  ['st-bug-1', 'st-pbi-2'],
  ['st-pbi-2', 'st-pbi-4'],
  ['cw-pbi-5', 'cw-pbi-4'],
  ['cw-pbi-4', 'cw-bug-2'],
];

/** The date (YYYY-MM-DD) of working day `n` of the sprint ending on `ends`, which starts on the Monday 11 days before. */
export function sprintDay(ends, n) {
  let at = Date.parse(`${ends}T00:00:00Z`) - 11 * 24 * 60 * 60 * 1000;
  for (let left = n; ; at += 24 * 60 * 60 * 1000) {
    const weekday = new Date(at).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    if (left-- === 0) return new Date(at).toISOString().slice(0, 10);
  }
}
