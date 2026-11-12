// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/App.tsx';
import { DISCLAIMER } from '../../src/feedback/consent.ts';
import type { FeedbackApi, FeedbackFields } from '../src/feedback.ts';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';
import { fixtureFeedback, fixtureFeedbackEnvelope } from '../src/fixtures/feedback.ts';
import type { Envelope } from '../src/toil.ts';

/**
 * The Feedback dialog (#265): it shows exactly what `toil feedback` would
 * send, then toil's disclaimer and a checkbox; Send works only while the box
 * is ticked for the report on screen, and any edit clears it.
 */

/** An API that previews as the sample does and records every send, which it accepts. */
function recording(): FeedbackApi & { sent: FeedbackFields[] } {
  const sent: FeedbackFields[] = [];
  return {
    sent,
    disabled: null,
    preview: async (fields) => fixtureFeedbackEnvelope({ ...fields }, false),
    send: async (fields) => {
      sent.push(fields);
      const preview = fixtureFeedbackEnvelope({ ...fields }, false) as Envelope & { data: Record<string, unknown> };
      return { ...preview, data: { ...preview.data, sent: true, message: 'Thanks. Your report is queued.' } } as Envelope;
    },
  };
}

async function openDialog(feedback: FeedbackApi, theme = 'plain', scheme = 'light') {
  localStorage.setItem('toil-ui.theme', JSON.stringify({ theme, scheme }));
  window.location.hash = '#/';
  render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} now={FIXTURE_NOW} preview={false} feedback={feedback} />);
  await screen.findByRole('heading', { level: 1 }, { timeout: 3000 });
  await userEvent.click(screen.getByRole('button', { name: 'Feedback' }));
  return screen.findByRole('dialog', { name: 'Send feedback to Imagile' });
}

async function fill(dialog: HTMLElement) {
  await userEvent.type(within(dialog).getByRole('textbox', { name: /Title/ }), 'jira issue search ignores --max-results');
  await userEvent.type(within(dialog).getByRole('textbox', { name: /Details/ }), 'It returns 50.');
  await userEvent.type(within(dialog).getByRole('textbox', { name: /Your email/ }), 'you@example.com');
  return within(dialog).findByRole('checkbox', {}, { timeout: 3000 });
}

/** Only violations are read, so axe skips building the passes (#328). */
async function violations() {
  const result = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
  return result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

// Typing a whole report key by key takes a few seconds on a slow runner.
describe('the Feedback dialog', { timeout: 20_000 }, () => {
  it("shows exactly toil's report, then its disclaimer, and sends only with the box ticked", async () => {
    const api = recording();
    const dialog = await openDialog(api);
    const send = within(dialog).getByRole('button', { name: 'Send' });
    expect(send.hasAttribute('disabled') || send.getAttribute('data-disabled') !== null).toBe(true);
    const box = await fill(dialog);
    const report = within(dialog).getByRole('region', { name: 'Exactly what will be sent' });
    expect(within(report).getByLabelText('The report, as toil would send it').textContent).toBe(
      JSON.stringify({ kind: 'bug', title: 'jira issue search ignores --max-results', body: 'It returns 50.', email: 'you@example.com', consent: 1, version: '0.1.0-alpha.1', commit: 'abc1234500000000000000000000000000000000' }, null, 2),
    );
    expect(within(dialog).getByText(DISCLAIMER)).toBeTruthy();
    expect(send.getAttribute('data-disabled')).not.toBeNull();

    await userEvent.click(box);
    expect(send.getAttribute('data-disabled')).toBeNull();
    // Any edit takes the yes back: it was for the report as it was.
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Details/ }), ' Every time.');
    await waitFor(() => expect((within(dialog).getByRole('checkbox') as HTMLInputElement).checked).toBe(false));
    expect(send.getAttribute('data-disabled')).not.toBeNull();
    expect(api.sent).toEqual([]);

    await userEvent.click(within(dialog).getByRole('checkbox'));
    await userEvent.click(send);
    expect(api.sent).toEqual([{ kind: 'bug', title: 'jira issue search ignores --max-results', body: 'It returns 50. Every time.', email: 'you@example.com' }]);
    expect(await screen.findByRole('heading', { name: 'Feedback sent' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Thanks. Your report is queued.');
  });

  it("says what toil refused, in toil's words", async () => {
    const dialog = await openDialog(recording());
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Title/ }), 't');
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Details/ }), 'b');
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Your email/ }), 'not-an-address');
    expect(await within(dialog).findByText(/"not-an-address" isn't an email address\. Pass yours with --email/, {}, { timeout: 3000 })).toBeTruthy();
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
  });

  it('says plainly when the toil it runs has no feedback command', async () => {
    const old: FeedbackApi = {
      disabled: null,
      preview: async () => ({ ok: false, data: null, error: { code: 'INVALID_INPUT', message: 'toil has no command "feedback".', fix: 'Use a name from registry.commands.' }, meta: { command: 'feedback', durationMs: 0, version: '0.1.0-alpha.2', contractVersion: 1 } }) as Envelope,
      send: async () => {
        throw new Error('not reached');
      },
    };
    const dialog = await openDialog(old);
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Title/ }), 't');
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Details/ }), 'b');
    await userEvent.type(within(dialog).getByRole('textbox', { name: /Your email/ }), 'you@example.com');
    expect(await within(dialog).findByText(/0\.1\.0-alpha\.2\) has no feedback command; it needs a newer toil/, {}, { timeout: 3000 })).toBeTruthy();
  });

  it('sends nothing with sample data, and says why beside Send', async () => {
    const dialog = await openDialog(fixtureFeedback());
    await fill(dialog);
    expect(within(dialog).getByText(/This is sample data, so it sends nothing/)).toBeTruthy();
    await userEvent.click(within(dialog).getByRole('checkbox'));
    expect(within(dialog).getByRole('button', { name: 'Send' }).getAttribute('data-disabled')).not.toBeNull();
  });

  it.each([
    ['plain', 'light'],
    ['plain', 'dark'],
    ['crate', 'dark'],
  ])('has no axe violations in %s (%s), open and filled in', async (theme, scheme) => {
    const dialog = await openDialog(recording(), theme, scheme);
    expect(await violations()).toEqual([]);
    await fill(dialog);
    expect(await violations()).toEqual([]);
  });

  it('closes on Escape and gives focus back to the Feedback button', async () => {
    await openDialog(recording());
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // React Aria gives focus back once the modal has gone, which can be a frame later on a slow runner.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Feedback' })));
  });
});
