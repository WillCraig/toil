import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/App.tsx';
import { plainNote } from '../src/model/briefing.ts';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';
import type { Execute } from '../src/toil.ts';

/**
 * #573: the Overview says what it could not check in two lines, one for a check
 * that did not run and one for a check that ran but could not test some items,
 * each in plain words with no command in them.
 */

beforeEach(() => localStorage.clear());
afterEach(cleanup);

/** The sample with every item unassigned, and the work-in-progress limit kept or gone. */
function withGaps(limit: boolean): Execute {
  const real = fixtureExecute().execute;
  return async (command, input, options) => {
    const e = await real(command, input, options);
    if (!e.ok) return e;
    if (command === 'projects show' && input?.toilProject === 'card-payments') {
      const data = structuredClone(e.data) as { toilProject: Record<string, unknown> };
      if (!limit) delete data.toilProject.wipLimit;
      return { ...e, data } as typeof e;
    }
    if (command === 'jira issue search') {
      const data = structuredClone(e.data) as { issues: Array<{ fields: Record<string, unknown> }> };
      for (const i of data.issues) i.fields.assignee = null;
      return { ...e, data } as typeof e;
    }
    return e;
  };
}

const view = async (limit: boolean) => {
  window.location.hash = '#/project/card-payments';
  render(<App execute={withGaps(limit)} agent={scriptedAgent()} now={FIXTURE_NOW} preview />);
  const region = await screen.findByRole('region', { name: 'Briefing' });
  await waitFor(() => expect(region.querySelector('[data-unchecked], [data-partly-checked]')).not.toBeNull());
  return region;
};
const noCommand = (text: string) => expect(text).not.toMatch(/\(toil |--|wip-limit|map pr/);

describe('the Overview notes on what was not checked', () => {
  it('says a check that ran but could not test some items on its own line, in words with no command', async () => {
    const region = await view(true);
    const partly = region.querySelector('[data-partly-checked]')!;
    expect(partly.textContent).toContain('Partly checked.');
    expect(partly.textContent).toMatch(/have nobody assigned/);
    expect(partly.textContent).not.toContain("Couldn't check");
    // A limit is set, so the check ran and nothing is said to have not run.
    expect(region.querySelector('[data-unchecked]')).toBeNull();
    noCommand(partly.textContent!);
  });

  it('says a missing work-in-progress limit in plain words, with a way to set one', async () => {
    const region = await view(false);
    const unchecked = region.querySelector('[data-unchecked]')!;
    expect(unchecked.textContent).toContain("Couldn't check.");
    expect(unchecked.textContent).toContain('No work-in-progress limit is set.');
    noCommand(unchecked.textContent!);
    expect(unchecked.querySelector('a')!.getAttribute('href')).toBe('#/settings/projects/card-payments/wip');
    // With no limit the load check did not run, so nothing is said to be partly checked for assignees.
    expect(region.querySelector('[data-partly-checked]')?.textContent ?? '').not.toMatch(/nobody assigned/);
  });
});

describe('plainNote', () => {
  type Lens = Parameters<typeof plainNote>[0];
  const lens = (over: Partial<Lens>): Lens => ({ id: 'load', label: 'WIP', on: true, threshold: null, unit: null, test: '', checked: true, untested: 0, note: null, ...over });
  const cases: Array<[string, Partial<Lens>, string]> = [
    ['no limit', { id: 'load', checked: false, note: 'The toil project sets no WIP limit (toil projects wip-limit).' }, 'No work-in-progress limit is set.'],
    ['no sprint', { id: 'sprint', checked: false, note: 'No item is in a sprint running now.' }, 'No item is in a sprint running now.'],
    ['no points', { id: 'sprint', checked: false, note: 'No item in the sprint has a points estimate.' }, 'No item in the sprint has a points estimate.'],
    ['readiness', { id: 'ready', checked: false, note: 'Readiness is worked out in Toil UI, not from OWI records.' }, "Readiness isn't worked out in this summary."],
    ['unassigned, many', { id: 'load', untested: 3, note: "3 items couldn't be tested: no assignee." }, '3 items in progress have nobody assigned.'],
    ['unassigned, one', { id: 'load', untested: 1, note: "1 item couldn't be tested: no assignee." }, '1 item in progress has nobody assigned.'],
    ['no update time', { id: 'stale', untested: 2, note: "2 items couldn't be tested: no updated." }, '2 items in progress have no last-updated time.'],
    ['no checks', { id: 'failing', untested: 1, note: "1 item couldn't be tested: a pull request has no checks read (map pr get --include reviews,checks, not only pr list)." }, 'Some code reviews have no checks read.'],
    ['no reviews', { id: 'waiting', untested: 1, note: "1 item couldn't be tested: a pull request has no reviews read (map pr get --include reviews,checks, not only pr list)." }, 'Some code reviews have no reviews read.'],
  ];
  it.each(cases)('%s', (_name, over, plain) => {
    expect(plainNote(lens(over))).toBe(plain);
  });

  it('keeps the core words for a note it does not know, with the command in parentheses taken out', () => {
    expect(plainNote(lens({ id: 'drift', untested: 2, note: "2 items couldn't be tested: no sizing (toil projects field set)." }))).toBe("2 items couldn't be tested: no sizing.");
    expect(plainNote(lens({ id: 'drift', untested: 2, note: 'Try again (map pr get --include checks).' }))).toBe('Try again.');
  });
});
