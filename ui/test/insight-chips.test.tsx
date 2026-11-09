import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { InsightChips } from '../src/components/bits.tsx';
import type { Insight } from '../src/model/insights.ts';

/**
 * A card draws one chip per insight code, with a count (#541). Two flags that
 * say the same word are one flag, however many forms were filed in triplicate.
 */

const blocking = (id: string): Insight => ({ code: 'blocking', weight: 2, text: `Blocks [[${id}]]`, evidence: 'links (blocks)' });
const stale: Insight = { code: 'stale', weight: 2, text: 'No update for 6 days', evidence: 'updated' };

describe('insight chips', () => {

  it('words the two shorthand chips in everyday words always, and keeps the rest', () => {
    const others: Insight[] = (['pr-no-build', 'aging', 'stale'] as const).map((code) => ({ code, weight: 1, text: code, evidence: code }));
    const { container } = render(<InsightChips insights={others} />);
    expect([...container.querySelectorAll('li')].map((c) => c.textContent)).toEqual(['Code review with no build', 'Open a long time', 'Stale']);
  });

  it('draws "Blocking 2" once, its tooltip naming each item it blocks', () => {
    const titles = new Map([['c:A', { title: 'Alpha' }], ['c:B', { title: 'Beta' }]]);
    const { container } = render(<InsightChips insights={[blocking('c:A'), blocking('c:B'), stale]} compact titles={titles} />);
    const chips = [...container.querySelectorAll('li')];
    expect(chips.map((c) => c.textContent)).toEqual(['Blocking 2', 'Stale']);
    expect(chips[0]!.getAttribute('title')).toBe('Blocking 2: Blocks Alpha; Blocks Beta');
    expect(chips[1]!.getAttribute('title')).toBe('Stale');
  });

  it('counts "+N more" in chips, not insights', () => {
    const others: Insight[] = (['aging', 'carried', 'unestimated'] as const).map((code) => ({ code, weight: 1, text: code, evidence: code }));
    const { container } = render(<InsightChips insights={[blocking('c:A'), blocking('c:B'), blocking('c:C'), stale, ...others]} compact />);
    expect([...container.querySelectorAll('li')].map((c) => c.textContent)).toEqual(['Blocking 3', 'Stale', 'Open a long time', '+2 more']);
  });

  it('keeps the count of a hidden chip in the "+N more" tooltip', () => {
    const many: Insight = { code: 'aging', weight: 3, text: 'x', evidence: 'x' };
    const { container } = render(<InsightChips insights={[stale, many, blocking('c:A'), blocking('c:B'), blocking('c:C')]} max={2} compact />);
    expect(container.querySelector('.insight--more')!.getAttribute('title')).toBe('Blocking 3');
  });
});
