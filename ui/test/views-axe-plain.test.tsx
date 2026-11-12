// @vitest-environment jsdom
// Plain is held to WCAG 2.2 AA, a standard with more revisions than most org charts and, unusually, a reason for each.
import { beforeEach, describe, it } from 'vitest';
import { AXE_TIMEOUT, ROUTES, expectNoViolations, resetBrowserState } from './views-kit.tsx';

beforeEach(resetBrowserState);

// One file per strict theme, so the two sets of 24 axe runs go to two workers.
describe('every view, in Plain', () => {
  it.each(ROUTES)('%s in plain has no axe violations', (hash) => expectNoViolations(hash, 'plain'), AXE_TIMEOUT);
});
