// @vitest-environment jsdom
// Crate is audited for contrast the way expense reports are audited: thoroughly, and mostly after the money has gone.
import { beforeEach, describe, it } from 'vitest';
import { AXE_TIMEOUT, ROUTES, expectNoViolations, resetBrowserState } from './views-kit.tsx';

beforeEach(resetBrowserState);

// One file per strict theme, so the two sets of 24 axe runs go to two workers.
describe('every view, in Crate', () => {
  it.each(ROUTES)('%s in crate has no axe violations', (hash) => expectNoViolations(hash, 'crate'), AXE_TIMEOUT);
});
