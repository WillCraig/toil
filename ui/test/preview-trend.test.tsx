import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Trend } from '../src/components/toil-project-head.tsx';
import { perDay } from '../src/model/preview.ts';

const NOW = '2026-11-07T14:00:00Z';

describe('the card\'s past week', () => {
  it('counts what happened each UTC day, oldest first and today last, ignoring older, future and missing times', () => {
    const out = perDay(['2026-11-07T01:00:00Z', '2026-11-07T23:59:00Z', '2026-11-05T10:00:00Z', '2026-11-01T00:00:00Z', '2026-10-31T23:00:00Z', '2026-11-08T00:00:00Z', null, undefined, 'not a date'], NOW);
    expect(out).toEqual([1, 0, 0, 0, 1, 0, 2]);
  });

  it('draws a line with every figure in words, and a dash that says not read yet where nothing was read', () => {
    render(
      <ul>
        <Trend label="Issues closed" days={[0, 2, 0, 0, 1, 0, 3]} />
        <Trend label="Pull requests merged" days={null} />
      </ul>,
    );
    expect(screen.getByRole('img', { name: /Issues closed, past 7 days, oldest first: 0, 2, 0, 0, 1, 0, 3\. 6 in all\./ })).toBeTruthy();
    expect(screen.getByLabelText('Pull requests merged: not read yet').textContent).toBe('–');
  });

  it('shows a real zero as 0, not a dash', () => {
    render(
      <ul>
        <Trend label="Issues closed" days={[0, 0, 0, 0, 0, 0, 0]} />
      </ul>,
    );
    expect(screen.getByText('0')).toBeTruthy();
  });
});
