import { describe, expect, it } from 'vitest';
import { accountsIn, isMapped, suggestPeople, type Account } from '../src/core/people-match.js';

const acct = (area: string, id: string, name: string | null = null, email: string | null = null): Account => ({ area, id, name, email });
const pat = { name: 'Pat Example', email: 'you@example.com', ids: {} as Record<string, string> };

describe('who is probably who', () => {
  it("matches by email first, including an email held as another area's identity", () => {
    const r = suggestPeople('pay', [{ ...pat, ids: { ado: 'you@example.com' } }], [acct('jira', 'acct-1', null, 'YOU@example.com'), acct('github', 'unrelated', null, null)]);
    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0]).toMatchObject({ person: 'Pat Example', reason: 'email', command: 'toil projects person pay "Pat Example" --id jira=acct-1' });
    expect(r.unmapped.map((a) => a.id)).toEqual(['unrelated']);
  });

  it('matches a display name in any order, and a login that reads as the name', () => {
    const r = suggestPeople('pay', [pat], [acct('bitbucket', 'b1', 'Example, Pat'), acct('github', 'pexample'), acct('jira', 'someone-else', 'Sam Other')]);
    expect(r.suggestions.map((s) => [s.accounts[0]!.area, s.reason])).toEqual([
      ['bitbucket', 'name'],
      ['github', 'login'],
    ]);
    expect(r.unmapped.map((a) => a.id)).toEqual(['someone-else']);
  });

  it('suggests nothing for an account that fits two people, or for an area where the person already has an identity', () => {
    const r = suggestPeople('pay', [{ name: 'Pat Example', ids: {} }, { name: 'Example Pat', ids: {} }], [acct('github', 'x', 'Pat Example')]);
    expect(r.suggestions).toEqual([]);
    expect(r.ambiguous[0]).toContain('fits Pat Example and Example Pat');
    const taken = suggestPeople('pay', [{ ...pat, ids: { github: 'pat-ex' } }], [acct('github', 'pexample', 'Pat Example')]);
    expect(taken.suggestions).toEqual([]);
    expect(taken.unmapped).toHaveLength(1);
  });

  it('proposes a new person for accounts in different areas that share an email, and says so when one area has two', () => {
    const r = suggestPeople('pay', [], [acct('jira', 'j', 'Sam Example', 's@example.com'), acct('github', 'sam-ex', null, 's@example.com')]);
    expect(r.suggestions[0]).toMatchObject({ person: null, name: 'Sam Example', command: 'toil projects person pay "Sam Example" --id github=sam-ex --id jira=j --email s@example.com' });
    const twice = suggestPeople('pay', [], [acct('github', 'a', null, 's@example.com'), acct('github', 'b', null, 's@example.com')]);
    expect(twice.suggestions).toEqual([]);
    expect(twice.ambiguous[0]).toContain('more than one github account');
  });

  it('leaves out accounts already mapped, and reports how many accounts were read (unknown is not zero)', () => {
    const mapped = [{ ...pat, ids: { github: 'pat-ex' } }];
    expect(isMapped(mapped, acct('github', 'PAT-EX'))).toBe(true);
    expect(suggestPeople('pay', mapped, [acct('github', 'pat-ex')])).toMatchObject({ suggestions: [], unmapped: [], read: 1 });
    expect(suggestPeople('pay', mapped, []).read).toBe(0);
  });

  it('reads accounts from items and changes by the area of their source, and skips records with none', () => {
    const items = [{ source: { area: 'jira' }, assignee: { id: 'a', name: null, email: null }, reporter: null, history: { transitions: [{ by: { id: 'b', name: 'B', email: null } }] } }] as never;
    const changes = [
      { source: { area: 'github' }, author: { id: 'c', name: null, email: null }, reviewers: [{ person: { id: 'd', name: null, email: null } }], reviews: null },
      { author: { id: 'x', name: null, email: null }, reviewers: [], reviews: null },
    ] as never;
    expect(accountsIn(items, changes).map((a) => `${a.area}:${a.id}`)).toEqual(['jira:a', 'jira:b', 'github:c', 'github:d']);
  });
});
