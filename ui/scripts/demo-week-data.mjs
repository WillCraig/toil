// What demo-week.mjs and its tests share, with no side effects on import: the
// sandboxes it may write to, the demo code an agent changes (the same in GitHub's
// toil-sandbox and ADO's settlement-service), and the text of the three
// "ready for an agent" items. ui/test/demo-week.test.ts runs the demo code's own
// tests offline. Repo tooling only: nothing here ships. The acceptance criteria
// were written before the work, which is how you can tell they are fictional.

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

/** The "ready for an agent" items: small, specified, with the files and the check named. */
export const AGENT_ITEMS = {
  github: {
    title: 'Format amounts as US dollars in formatAmount',
    body: `formatAmount in src/money.js prints \`-123450\` cents as "-1234.50 USD". Statements and the payout preview need "-$1,234.50".

**Change:** in \`src/money.js\`, make \`formatAmount(cents)\` return a dollar sign, thousands separators and two decimals, with a leading minus for negative amounts. Don't use \`Intl.NumberFormat\` with a locale argument from the environment; the output must not depend on the machine.

**Acceptance criteria**
- [ ] \`formatAmount(123450) === '$1,234.50'\`
- [ ] \`formatAmount(-123450) === '-$1,234.50'\`
- [ ] \`formatAmount(5) === '$0.05'\` and \`formatAmount(0) === '$0.00'\`
- [ ] \`formatAmount(100000000) === '$1,000,000.00'\`
- [ ] Tests updated in \`test/money.test.js\`; \`npm test\` passes
- [ ] No other file changes

Follows the money standard in Confluence (space OD). Ready for an agent: about 30 minutes, one file and its test. ${DEMO_NOTE}`,
  },
  jira: {
    summary: 'Add maskPan() so debug logs never print a full card number',
    description: `describePaymentMethod in src/logger.js (repository imagile-dev/toil-sandbox) prints the whole payment method, card number included.

Change: add src/mask.js exporting maskPan(pan), which keeps the last four digits and replaces every other digit with "*" ("4242424242424242" becomes "************4242"). Use it in describePaymentMethod for the number field.

Acceptance criteria:
- maskPan('4242424242424242') returns '************4242'
- maskPan of a value with fewer than 4 digits returns it all masked
- describePaymentMethod({ number: '4242424242424242', brand: 'visa' }) no longer contains the full number
- Tests in test/mask.test.js; npm test passes

Ready for an agent: about 30 minutes, two files and a test. ${DEMO_NOTE}`,
  },
  ado: {
    title: 'Refuse a refund whose reason is not a known reason code',
    description: `<p>createRefund in src/refunds.js (repository settlement-service) accepts any reason.</p>
<p><b>Change:</b> throw an Error naming the allowed codes when <code>reason</code> is not in <code>REASON_CODES</code>.</p>
<p><b>Acceptance criteria</b></p>
<ul><li>createRefund with reason 'duplicate' still returns a pending refund</li>
<li>createRefund with reason 'other' throws, and the message lists the four codes</li>
<li>Tests in test/refunds.test.js; npm test passes</li></ul>
<p>Ready for an agent: about 20 minutes, one file and its test. ${DEMO_NOTE}</p>`,
  },
};
