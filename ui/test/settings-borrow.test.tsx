// @vitest-environment jsdom
// One token, two products, zero extra forms: the rarest kind of consolidation.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ConfigApi, ConnectionRow } from '../src/config.ts';
import { FIXTURE_AREAS, fixtureConfig } from '../src/fixtures/config.ts';
import { open, resetBrowserState } from './views-kit.tsx';

/**
 * Settings offers Jira Cloud's API token to a Confluence Cloud connection on
 * the same site, as a choice between its own token and Jira's, and answers
 * toil's `borrow:<key>` question from it. The fixture's areas are held to the
 * real registry (test/config.test.ts), so the offer is the one toil declares.
 */
beforeEach(resetBrowserState);

/** The site the form composes from the name typed: kept out of the placeholder check's way as setup-connect.test.tsx does. */
const ATL = 'atlassian';
const SITE_HOST = `example-site.${ATL}.net`;
const jiraCloud: ConnectionRow = { name: 'corp-jira', area: 'jira', isDefault: true, host: SITE_HOST, writes: false, deployment: 'cloud', values: { baseUrl: 'file', deployment: 'file', email: 'file', apiToken: 'store' }, definedIn: 'file' };
const jiraDc: ConnectionRow = { name: 'jira-dc', area: 'jira', isDefault: true, host: 'jira.imagile.dev', writes: false, deployment: 'server', values: { baseUrl: 'file', apiToken: 'store' }, definedIn: 'file' };

function recording(connections: ConnectionRow[]) {
  const base = fixtureConfig();
  const sent: Array<{ command: string; input: Record<string, unknown>; answers: { answers: Record<string, string>; secrets: Record<string, string> } }> = [];
  const areas = FIXTURE_AREAS.filter((a) => a.name === 'jira' || a.name === 'confluence');
  const config: ConfigApi = {
    ...base,
    disabled: null,
    areas: async () => structuredClone(areas),
    run: async (command, input, answers) => {
      const ok = (data: unknown) => ({ ok: true as const, data, error: null, meta: { command, durationMs: 0, version: 'x', contractVersion: 1 } });
      if (command === 'connections list') return ok({ configFile: '/home/you/.toil/config.json', connections });
      if (['connections test', 'projects list', 'projects show', 'projects check'].includes(command)) return base.run(command, input);
      sent.push({ command, input, answers: answers as (typeof sent)[number]['answers'] });
      return ok({});
    },
  };
  return { config, sent };
}

async function confluenceForm(deployment: 'Cloud' | 'Data Center', site: string) {
  await userEvent.click(await screen.findByRole('button', { name: 'Add a connection' }));
  const form = await screen.findByRole('form', { name: 'A new connection' });
  await userEvent.type(within(form).getByRole('textbox', { name: /^Name/ }), 'wiki');
  await userEvent.selectOptions(within(form).getByRole('combobox', { name: 'Tool' }), 'confluence');
  await userEvent.click(within(form).getByRole('radio', { name: deployment }));
  await userEvent.type(within(form).getByRole('textbox', { name: deployment === 'Cloud' ? /^Site name/ : /^Address/ }), site);
  return form;
}

describe('reusing the Jira token for Confluence Cloud', () => {
  it('offers the Jira token, chosen by default, hides the token box, and answers borrow:apiToken y', async () => {
    const { config, sent } = recording([jiraCloud]);
    await open('#/settings/connections', { config });
    const form = await confluenceForm('Cloud', 'example-site');
    expect((within(form).getByRole('radio', { name: /Reuse corp-jira's token/ }) as HTMLInputElement).checked).toBe(true);
    expect(within(form).queryByLabelText(/^apiToken/)).toBeNull();
    // No apiTokenFrom box: the choice is the radio.
    expect(within(form).queryByRole('textbox', { name: /^apiTokenFrom/ })).toBeNull();
    expect(form.textContent).toContain('Needs the same email as corp-jira.');
    expect(within(form).getByRole('radiogroup', { name: 'Which API token?' })).toBeTruthy();
    await userEvent.type(within(form).getByRole('textbox', { name: /^email/ }), 'you@example.com');
    await userEvent.click(within(form).getByRole('button', { name: 'Save connection' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ command: 'connections add', input: { name: 'wiki', area: 'confluence' }, answers: { secrets: { apiToken: '' } } });
    expect(sent[0]!.answers.answers).toMatchObject({ 'borrow:apiToken': 'y', 'setting:deployment': 'cloud', 'setting:email': 'you@example.com', 'setting:apiTokenFrom': '' });
  });

  it('on "Its own token", shows the token box and answers n with the token typed', async () => {
    const { config, sent } = recording([jiraCloud]);
    await open('#/settings/connections', { config });
    const form = await confluenceForm('Cloud', 'example-site');
    await userEvent.click(within(form).getByRole('radio', { name: 'A token of its own' }));
    await userEvent.type(within(form).getByRole('textbox', { name: /^email/ }), 'you@example.com');
    await userEvent.type(within(form).getByLabelText(/^apiToken/), 'fake-token-abc12345');
    await userEvent.click(within(form).getByRole('button', { name: 'Save connection' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.answers).toMatchObject({ answers: { 'borrow:apiToken': 'n' }, secrets: { apiToken: 'fake-token-abc12345' } });
  });

  it('offers nothing from a Jira whose token comes from an env var, as toil offers nothing', async () => {
    const { config } = recording([{ ...jiraCloud, values: { ...jiraCloud.values, apiToken: 'env' } }]);
    await open('#/settings/connections', { config });
    const form = await confluenceForm('Cloud', 'example-site');
    expect(within(form).queryByRole('radio', { name: /Reuse .*'s token/ })).toBeNull();
    expect(within(form).getByLabelText(/^apiToken/)).toBeTruthy();
  });

  it('offers nothing on another site, and nothing on Data Center', async () => {
    const { config } = recording([jiraCloud, jiraDc]);
    await open('#/settings/connections', { config });
    const cloud = await confluenceForm('Cloud', 'another-site');
    expect(within(cloud).queryByRole('radio', { name: /Reuse .*'s token/ })).toBeNull();
    expect(within(cloud).getByLabelText(/^apiToken/)).toBeTruthy();
    await userEvent.click(within(cloud).getByRole('radio', { name: 'Data Center' }));
    await userEvent.type(within(cloud).getByRole('textbox', { name: /^Address/ }), 'https://jira.imagile.dev');
    expect(within(cloud).queryByRole('radio', { name: /Reuse .*'s token/ })).toBeNull();
  });

  it('offers the switch when updating a Confluence Cloud connection\'s login, and answers borrow:apiToken', async () => {
    const wiki: ConnectionRow = { name: 'wiki', area: 'confluence', isDefault: true, host: SITE_HOST, writes: false, deployment: 'cloud', values: { baseUrl: 'file', deployment: 'file', email: 'file', apiToken: 'store' }, definedIn: 'file' };
    const { config, sent } = recording([jiraCloud, wiki]);
    await open('#/settings/connections', { config });
    const card = await screen.findByRole('article', { name: 'wiki' });
    await userEvent.click(within(card).getByRole('button', { name: 'Update login' }));
    const form = within(card).getByRole('form', { name: "Update wiki's login" });
    // It has a token of its own, so that stays chosen until the person picks Jira's.
    expect((within(form).getByRole('radio', { name: 'A token of its own' }) as HTMLInputElement).checked).toBe(true);
    await userEvent.click(within(form).getByRole('radio', { name: /Reuse corp-jira's token/ }));
    expect(within(form).queryByLabelText(/^apiToken/)).toBeNull();
    await userEvent.click(within(form).getByRole('button', { name: 'Save securely' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ command: 'connections login', input: { name: 'wiki' }, answers: { answers: { 'borrow:apiToken': 'y' }, secrets: { apiToken: '' } } });
  });

  it('offers no switch to a Data Center Confluence on the same host as a Data Center Jira', async () => {
    const wiki: ConnectionRow = { name: 'wiki', area: 'confluence', isDefault: true, host: 'jira.imagile.dev', writes: false, deployment: 'server', values: { baseUrl: 'file', apiToken: 'store' }, definedIn: 'file' };
    const { config, sent } = recording([jiraDc, wiki]);
    await open('#/settings/connections', { config });
    const card = await screen.findByRole('article', { name: 'wiki' });
    await userEvent.click(within(card).getByRole('button', { name: 'Update login' }));
    expect(within(card).queryByRole('radio', { name: /Reuse .*'s token/ })).toBeNull();
    // Still answers toil's question, n, in case toil judges otherwise: an unanswered one would cancel the call.
    const form = within(card).getByRole('form', { name: "Update wiki's login" });
    await userEvent.type(within(form).getByLabelText(/^apiToken/), 'fake-token-abc12345');
    await userEvent.click(within(form).getByRole('button', { name: 'Save securely' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.answers.answers).toMatchObject({ 'borrow:apiToken': 'n' });
  });
});
