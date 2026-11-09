import { describe, expect, it } from 'vitest';
import { applyOrder, moveBy } from '../src/project-order.ts';

describe('the Toil projects page order', () => {
  it('puts the saved names first as saved, skips gone ones, and adds new ones at the end', () => {
    expect(applyOrder(['a', 'b', 'c', 'd'], ['c', 'x', 'a'])).toEqual(['c', 'a', 'b', 'd']);
    expect(applyOrder(['a', 'b'], [])).toEqual(['a', 'b']);
  });
  it('moves one place earlier or later, and stays put at either end', () => {
    expect(moveBy(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(moveBy(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b']);
    expect(moveBy(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c']);
    expect(moveBy(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'b', 'c']);
    expect(moveBy(['a', 'b'], 'z', 1)).toEqual(['a', 'b']);
  });
});
