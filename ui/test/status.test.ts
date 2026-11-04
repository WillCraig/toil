import { describe, expect, it } from 'vitest';
import { daysLeft, sprintDays } from '../src/model/sprint.ts';
import { statusOf } from '../src/model/status.ts';

/**
 * The status word (#552): one rule, so every screen calls a sprint the same
 * thing. The lines are at all of the points left landing at the pace so far,
 * and at three quarters of them.
 */

const of = (left: number, projected: number | null, red = false) => statusOf({ sprint: { left, projected }, red });

describe('the status word', () => {
  it('is On track when the points left fit at the pace so far', () => {
    expect(of(18, 18)).toMatchObject({ status: 'on-track', word: 'On track', landing: 1 });
    // The code rounds `projected` to a tenth, so 17.96 of 18 arrives as 18.
    expect(of(18, 17.96).status).toBe('on-track');
  });

  it('is At risk from exactly 75% landing up to, but not including, all of it', () => {
    expect(of(100, 75)).toMatchObject({ status: 'at-risk', word: 'At risk', landing: 0.75 });
    expect(of(18, 13.5).status).toBe('at-risk');
    expect(of(100, 99)).toMatchObject({ status: 'at-risk', landing: 0.99 });
  });

  it('is Behind below 75% landing', () => {
    expect(of(100, 74.9)).toMatchObject({ status: 'behind', word: 'Behind' });
    expect(of(18, 1).status).toBe('behind');
    expect(of(18, 0).status).toBe('behind');
  });

  it('is At risk, not On track, when a red reason holds work up even though the pace fits', () => {
    expect(of(18, 18, true).status).toBe('at-risk');
    // A red reason never makes it better than the pace says: Behind stays Behind.
    expect(of(18, 1, true).status).toBe('behind');
  });

  it('is On track with nothing left, red reason or not', () => {
    expect(of(0, 0)).toMatchObject({ status: 'on-track', landing: 1 });
    expect(of(0, null, true).status).toBe('on-track');
  });

  it('says it is too early to judge a pace when there is no projection yet', () => {
    expect(of(18, null)).toMatchObject({ status: 'on-track', landing: null, early: true });
    expect(of(18, null, true)).toMatchObject({ status: 'at-risk', early: true });
    expect(of(18, 18).early).toBe(false);
  });

  it('is No sprint with no dated sprint', () => {
    expect(statusOf({ sprint: null, red: true })).toEqual({ status: 'none', word: 'No sprint', landing: null, early: false });
  });
});

describe('working days left', () => {
  it('is the total less the days gone, never below zero', () => {
    expect(daysLeft({ gone: 7, total: 10 })).toBe(3);
    expect(daysLeft({ gone: 10, total: 10 })).toBe(0);
    expect(daysLeft({ gone: 11, total: 10 })).toBe(0);
  });

  it("does not count today: Wednesday noon of a Monday-to-Friday fortnight leaves Thursday and Friday of week two", () => {
    const days = sprintDays('2026-10-05T00:00:00Z', '2026-10-17T00:00:00Z', '2026-10-14T12:00:00Z');
    expect(days).toEqual({ gone: 8, total: 10 });
    expect(daysLeft(days)).toBe(2);
  });
});
