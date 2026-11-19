// @vitest-environment jsdom
// The item page keeps its maybes in a drawer, labelled, which is more than the shared drive ever managed.
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { fixtureAssignments } from '../src/fixtures/assignments.ts';
import { cleanupView, item, open, resetBrowserState } from './views-kit.tsx';

beforeEach(resetBrowserState);

describe("an item's possible duplicates (#657, round 4)", () => {
  it('fold to one line with their count, and open to the list', async () => {
    await open(item('card-payments', 'corp-jira:PAY-103'));
    const panel = await waitFor(() => screen.getByRole('region', { name: /possible duplicate/i }));
    const fold = panel.querySelector<HTMLDetailsElement>('details[data-duplicates]');
    if (!fold) {
      // No duplicates: the heading and the sentence that says so, with nothing to open.
      expect(panel.textContent).toContain('None in card-payments');
      return;
    }
    expect(fold.open).toBe(false);
    const summary = fold.querySelector('summary')!;
    // The chevron alone says it opens (#657): no "· Show" beside it.
    expect(summary.textContent).toMatch(/^\d+ possible duplicates?$/);
    await userEvent.click(summary);
    await waitFor(() => expect(fold.open).toBe(true));
    expect(fold.querySelectorAll('li.duplicate').length).toBeGreaterThan(0);
  });
});

describe("the Ready to start? page's Blocked card (#657, round 4)", () => {
  it('says what it counts, waiting on another item first', async () => {
    await open('#/project/card-payments/command-center');
    await waitFor(() => expect(document.body.textContent).toContain('Waiting on another item, done already, outside the Toil project, or failing a ticket rule.'));
  });
});

describe('a running assignment (#657, round 4)', () => {
  it('leads with the live line, with the record and the transcript out of sight until the run ends', async () => {
    await open('#/project/card-payments/assignment/sample-working-0001', { assignments: fixtureAssignments({ delay: 0 }) });
    await waitFor(() => expect(document.querySelector('[data-assignment-live]')).not.toBeNull(), { timeout: 4000 });
    expect(document.querySelector('.assign-record')).toBeNull();
    expect(document.querySelector('.assign-transcript')).toBeNull();
    // A finished one keeps both as disclosures.
    cleanupView();
    await open('#/project/card-payments/assignment/sample-needsyou-0002', { assignments: fixtureAssignments({ delay: 0 }) });
    await waitFor(() => expect(document.querySelector('.assign-transcript')).not.toBeNull(), { timeout: 4000 });
  });
});
