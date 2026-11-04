import { describe, expect, it } from 'vitest';
import { ALL_CLEAR, pickCards, type Card } from '../src/model/summary.ts';

/**
 * Which cards the Summary tab shows (#552): at most three, the same for
 * everyone, in a fixed order, with the not-ready fallback and an all-clear.
 */

const card = (id: Card['id']): Card => ({ id, kicker: id, title: id, key: null, why: '', named: [], action: null, tone: 'warn' });
const ids = (c: Card[]) => c.map((x) => x.id);

describe('the cards that need attention', () => {
  it('shows the biggest risk, then stories that cannot start, then the oldest waiting review', () => {
    expect(ids(pickCards({ risk: card('risk'), blocked: card('blocked'), review: card('review'), ready: card('ready') }))).toEqual(['risk', 'blocked', 'review']);
  });

  it('never shows more than three, whatever is there', () => {
    expect(pickCards({ risk: card('risk'), blocked: card('blocked'), review: card('review'), ready: card('ready') })).toHaveLength(3);
  });

  it('falls back to stories not ready to start when one of the three is empty, after the others', () => {
    expect(ids(pickCards({ risk: card('risk'), blocked: null, review: card('review'), ready: card('ready') }))).toEqual(['risk', 'review', 'ready']);
    expect(ids(pickCards({ risk: card('risk'), blocked: card('blocked'), review: null, ready: card('ready') }))).toEqual(['risk', 'blocked', 'ready']);
    expect(ids(pickCards({ risk: null, blocked: card('blocked'), review: card('review'), ready: card('ready') }))).toEqual(['blocked', 'review', 'ready']);
  });

  it('uses the fallback once, not once per empty place', () => {
    expect(ids(pickCards({ risk: card('risk'), blocked: null, review: null, ready: card('ready') }))).toEqual(['risk', 'ready']);
  });

  it('shows what there is when the fallback is empty too, and invents nothing', () => {
    expect(ids(pickCards({ risk: card('risk'), blocked: null, review: null, ready: null }))).toEqual(['risk']);
  });

  it('shows one all-clear card, with no link, when nothing needs attention', () => {
    const cards = pickCards({ risk: null, blocked: null, review: null, ready: null });
    expect(cards).toEqual([ALL_CLEAR]);
    expect(ALL_CLEAR.action).toBeNull();
    expect(ALL_CLEAR.tone).toBe('ok');
  });

  it('shows the fallback alone when it is all there is', () => {
    expect(ids(pickCards({ risk: null, blocked: null, review: null, ready: card('ready') }))).toEqual(['ready']);
  });
});
