// @vitest-environment node
import { mapOwi } from '@imagile-dev/toil/api';
import { describe, expect, it } from 'vitest';
import { fixtureExecute } from '../src/fixtures/execute.ts';
import { JIRA_CHANGELOGS, JIRA_KEYS, JIRA_SEARCH } from '../src/fixtures/work.ts';
import { splitChangelogs } from '../src/jira-changelog.ts';
import { JQL } from '../src/load.ts';
import type { Envelope } from '../src/toil.ts';

/**
 * `jira issue search --changelog` against one `jira issue history` call per
 * issue: whichever way a history reached the loader, `mapOwi` has to see the
 * same input and give the same items (#493). An adapter that merely looks
 * right is a rounding error with a pull request.
 */

type Rec = Record<string, unknown>;
const read = { readOnly: true, caller: 'toil-ui' };
const searchEnvelope = async (): Promise<Envelope & { ok: true }> => (await fixtureExecute().execute('jira issue search', { toilProject: 'card-payments', jql: JQL('PAY'), changelog: true }, read)) as Envelope & { ok: true };

/** The search with every issue's changelog whole and inline, as Jira sends it for short histories. */
const wholeInline = (search: Envelope & { ok: true }): Envelope => {
  const data = search.data as { issues: Rec[] };
  const issues = data.issues.map((i) => {
    const histories = JIRA_CHANGELOGS[String(i.key)] as unknown[];
    return { ...i, changelog: { startAt: 0, maxResults: 100, total: histories.length, histories } };
  });
  return { ...search, data: { ...data, issues } } as Envelope;
};

/** What the loader gave mapOwi before: the plain search, then each issue's `issue history` envelope wrapped with its key. */
const perIssue = (search: Envelope & { ok: true }) => [
  { ...search, data: JIRA_SEARCH },
  ...JIRA_KEYS.map((key) => ({ key, history: { ...search, data: JIRA_CHANGELOGS[key], meta: { ...search.meta, command: 'jira issue history' } } })),
];

describe('the inline changelog, split back into what mapOwi has always read', () => {
  it('maps to the same items as the search plus one history call per issue', async () => {
    const search = await searchEnvelope();
    const { search: plain, histories, incomplete } = splitChangelogs(wholeInline(search), 'jira issue history');
    expect(incomplete).toEqual([]);
    expect(histories.map((h) => h.key)).toEqual(JIRA_KEYS);
    const before = mapOwi(perIssue(search));
    const after = mapOwi([plain, ...histories]);
    expect(after.items).toEqual(before.items);
    expect(after.warnings).toEqual(before.warnings);
    // Not vacuous: the items carry transitions.
    expect(after.items.some((i) => (i.history?.transitions.length ?? 0) > 0)).toBe(true);
  });

  it('leaves no changelog on the issues it hands mapOwi, so native holds the issue as search sends it without the flag', async () => {
    const { search } = splitChangelogs(wholeInline(await searchEnvelope()), 'jira issue history');
    expect((search.data as { issues: Rec[] }).issues.every((i) => !('changelog' in i))).toBe(true);
  });

  it('turns a changelog that runs newest first round, so the entries come in the order issue history lists them', async () => {
    const base = await searchEnvelope();
    const key = JIRA_KEYS.find((k) => (JIRA_CHANGELOGS[k] as unknown[]).length > 1)!;
    const whole = wholeInline(base);
    const reversed = {
      ...whole,
      data: { ...(whole.data as Rec), issues: (whole.data as { issues: Rec[] }).issues.map((i) => (i.key === key ? { ...i, changelog: { ...(i.changelog as Rec), histories: [...(JIRA_CHANGELOGS[key] as unknown[])].reverse() } } : i)) },
    } as Envelope;
    const { search, histories } = splitChangelogs(reversed, 'jira issue history');
    expect(mapOwi([search, ...histories]).items).toEqual(mapOwi(perIssue(base)).items);
  });

  it('names an issue whose changelog is shorter than Jira says, or missing, so it is read with issue history', async () => {
    const base = wholeInline(await searchEnvelope());
    const data = base.data as { issues: Rec[] };
    const [a, b, ...rest] = data.issues;
    const cut = { ...a!, changelog: { startAt: 0, maxResults: 100, total: 250, histories: [] } };
    const none = { ...b! };
    delete none.changelog;
    const { histories, incomplete, search } = splitChangelogs({ ...base, data: { ...data, issues: [cut, none, ...rest] } } as Envelope, 'jira issue history');
    expect(incomplete).toEqual([String(a!.key), String(b!.key)]);
    expect(histories.map((h) => h.key)).toEqual(rest.map((i) => String(i.key)));
    // Every issue stays in the search, whole or not.
    expect((search.data as { issues: unknown[] }).issues).toHaveLength(data.issues.length);
  });

  // Cloud's documented shape: at most 20 entries on the page, newest first, and total is
  // the number on the page, so a history cut at 20 says total 20 (RFC-61, PageOfChangelogs).
  it('reads an issue with issue history when its changelog fills the page, though total equals the entries', async () => {
    const base = wholeInline(await searchEnvelope());
    const data = base.data as { issues: Rec[] };
    const [a, b, c, ...rest] = data.issues;
    const entry = (n: number) => ({ id: String(n), created: new Date(Date.UTC(2026, 9, 1, 0, 0, 0) + n * 60_000).toISOString(), items: [] });
    const twenty = Array.from({ length: 20 }, (_, i) => entry(20 - i));
    const full = { ...a!, changelog: { startAt: 0, maxResults: 20, total: 20, histories: twenty } };
    const five = { ...b!, changelog: { startAt: 0, maxResults: 20, total: 5, histories: twenty.slice(0, 5) } };
    // Data Center, total missing: nothing says the history is whole.
    const noTotal = { ...c!, changelog: { startAt: 0, maxResults: 100, histories: twenty.slice(0, 3) } };
    const { histories, incomplete } = splitChangelogs({ ...base, data: { ...data, issues: [full, five, noTotal, ...rest] } } as Envelope, 'jira issue history');
    expect(incomplete).toEqual([String(a!.key), String(c!.key)]);
    expect(histories.map((h) => h.key)).toEqual([String(b!.key), ...rest.map((i) => String(i.key))]);
    // 5 of 20 newest first: turned round, oldest first.
    const ids = (histories[0]!.history.data as Rec[]).map((h) => h.id);
    expect(ids).toEqual(['16', '17', '18', '19', '20']);
  });

  it('passes a failed search through untouched', () => {
    const failed = { ok: false, data: null, error: { code: 'HTTP', message: 'down', fix: 'later' }, meta: { command: 'jira issue search' } } as unknown as Envelope;
    expect(splitChangelogs(failed, 'jira issue history')).toEqual({ search: failed, histories: [], incomplete: [] });
  });
});
