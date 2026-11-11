import { Validator } from '@cfworker/json-schema';
import { describe, expect, it } from 'vitest';
import schema from '../../docs/owi/schema.json';
import { CANNED, CARD_JIRA_FIELDS, fixtureExecute } from '../src/fixtures/execute.ts';
import { JQL } from '../src/load.ts';
import { NAMES, loaded } from './harness.ts';

/**
 * The fixture `execute()` behaves as the real one does from the outside: an
 * envelope for every call, never a throw, a refusal with a fix for what it
 * can't answer, and nothing but reads. What it serves is placeholder data,
 * and the work items the dashboards map from it are valid OWI records.
 */

const read = { readOnly: true, caller: 'toil-ui' };

describe('the fixture execute()', () => {
  it('answers a canned call with its envelope, Toil project context included', async () => {
    const { execute } = fixtureExecute();
    const env = await execute('jira issue search', { jql: JQL('PAY'), changelog: true, fields: CARD_JIRA_FIELDS, toilProject: 'card-payments' }, read);
    expect(env.ok).toBe(true);
    expect(env.meta.command).toBe('jira issue search');
    expect(env.meta.contractVersion).toBe(1);
    expect(env.meta.context?.toilProject?.name).toBe('card-payments');
    expect(env.meta.context?.connection).toEqual({ value: 'corp-jira', source: 'toil-project' });
  });

  it("refuses, as an envelope with a fix, a call it has no answer for", async () => {
    const { execute, calls } = fixtureExecute();
    const env = await execute('jira issue search', { toilProject: 'card-payments', jql: 'project = NOPE' }, read);
    expect(env.ok).toBe(false);
    expect(!env.ok && env.error.code).toBe('INVALID_INPUT');
    expect(!env.ok && env.error.fix).toMatch(/CANNED/);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.ok).toBe(false);
  });

  it('refuses any call that is not read-only', async () => {
    const { execute } = fixtureExecute();
    const env = await execute('projects list', {}, { caller: 'toil-ui' });
    expect(!env.ok && env.error.code).toBe('WRITE_DISABLED');
  });

  it('hands out copies, so a view cannot change the next answer', async () => {
    const { execute } = fixtureExecute();
    const a = await execute('projects list', {}, read);
    (a.data as { toilProjects: unknown[] }).toilProjects.length = 0;
    const b = await execute('projects list', {}, read);
    expect((b.data as { toilProjects: unknown[] }).toilProjects).toHaveLength(3);
  });
});

describe('what it serves', () => {
  const strings = (v: unknown): string[] => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []);
  const text = CANNED.flatMap((c) => strings(c.data));

  it('names only placeholder hosts', () => {
    const urls = text.flatMap((s) => [...s.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0]));
    expect(urls.length).toBeGreaterThan(50);
    for (const url of urls) expect(new URL(url).hostname, url).toMatch(/\.imagile\.dev$/);
    const images = text.filter((s) => /^[\w.-]+\/[\w./-]+:[\w.-]+$/.test(s));
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) expect(image).toMatch(/^artifactory\.imagile\.dev\//);
  });

  it('has no email address but the placeholder one', () => {
    const emails = text.flatMap((s) => [...s.matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+/g)].map((m) => m[0])).filter((e) => !e.startsWith('git@'));
    for (const e of emails) expect(e).toBe('you@example.com');
  });
});

describe.each(NAMES)('the %s Toil project', (name) => {
  it('maps to work items that validate against docs/owi/schema.json', async () => {
    const { data } = await loaded(name);
    const validator = new Validator(schema as object, '2020-12', false);
    expect(data.items.length).toBeGreaterThan(0);
    for (const item of data.items) {
      const result = validator.validate(item);
      expect(result.errors.map((e) => `${e.instanceLocation} ${e.error}`), item.id).toEqual([]);
    }
  });
});

describe('the Toil projects together', () => {
  it('hold the OWI sprint fixture, split three ways', async () => {
    const sprint = (await import('../../test/fixtures/owi/sprint-42.owi.json')).default as { items: Array<{ id: string; title: string }> };
    const ids = (await Promise.all(NAMES.map(loaded))).flatMap(({ data }) => data.items.map((i) => i.id));
    expect(ids.sort()).toEqual(sprint.items.map((i) => i.id).sort());
  });
});
