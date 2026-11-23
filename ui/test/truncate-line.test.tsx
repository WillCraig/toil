// @vitest-environment jsdom
/**
 * The More control on a cut line (#649): it is there when the line is cut, absent when the line fits,
 * and a screen reader meets the word it shows first. The fact lines a stand-up chip adds are only the
 * ones the folded row does not already say.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { linesBeyond, TruncateLine } from '../src/components/truncate.tsx';
import { cutTruncateBoxes } from './cut-boxes.ts';

afterEach(cleanup);

describe('lines a folded row does not already show', () => {
  it('drops a line the row shows, keeps a time, and does not repeat a leading key', () => {
    const full = ['PAY-104 Retry a timed-out authorization', 'moved from Payments\\Sprint 41 to Payments\\Sprint 42, by K. Nakamura (09:00 UTC)'].join('\n');
    const folded = 'PAY-104 moved from Payments\\Sprint 41 to Payments\\Sprint 42, by K. Nakamura';
    expect(linesBeyond(full, folded)).toEqual(['Retry a timed-out authorization', '(09:00 UTC)']);
  });

  it('keeps a comment title the row never shows, and the comment when the excerpt cut it', () => {
    const full = ['PAY-104 Retry a timed-out authorization', 'The gateway timed out after the authorization', '09:00 UTC'].join('\n');
    const folded = 'PAY-104 “The gateway…”';
    expect(linesBeyond(full, folded)).toEqual(['Retry a timed-out authorization', 'The gateway timed out after the authorization', '09:00 UTC']);
  });

  it('returns nothing when the row already shows every line', () => {
    expect(linesBeyond('PAY-104 Retry\nopened', 'PAY-104 Retry opened')).toEqual([]);
  });
});

describe('TruncateLine', () => {
  const text = 'Retry a timed-out authorization without charging the card twice';

  it('leaves a line that fits as text, with no extra tab stop', () => {
    render(<TruncateLine text={text} className="apply__title-line" textClassName="apply__title-text" />);
    const line = document.querySelector('[data-truncate]')!;
    expect(line.getAttribute('data-truncate')).toBe('expand');
    expect(line.querySelector('[data-truncate-text]')!.textContent).toBe(text);
    expect(screen.queryByRole('button')).toBeNull();
    expect(line.hasAttribute('data-truncate-open')).toBe(false);
  });

  it('opens a cut line from a More control whose name starts with More, and folds it from Less', async () => {
    const restore = cutTruncateBoxes();
    try {
      render(<TruncateLine text={text} />);
      const more = screen.getByRole('button', { name: `More: ${text}` });
      expect(more.textContent).toBe('More');
      expect(more.tabIndex).toBe(0);
      expect(more.getAttribute('aria-expanded')).toBe('false');
      await userEvent.click(more);
      const line = document.querySelector('[data-truncate]')!;
      expect(line.getAttribute('data-truncate-open')).toBe('true');
      const less = screen.getByRole('button', { name: `Less: ${text}` });
      expect(less.textContent).toBe('Less');
      expect(less.getAttribute('aria-expanded')).toBe('true');
      await userEvent.click(less);
      expect(line.hasAttribute('data-truncate-open')).toBe(false);
      expect(screen.getByRole('button', { name: `More: ${text}` }).getAttribute('aria-expanded')).toBe('false');
    } finally {
      restore();
    }
  });

  it('toggles from the keyboard', async () => {
    const restore = cutTruncateBoxes();
    try {
      render(<TruncateLine text={text} />);
      const more = screen.getByRole('button', { name: `More: ${text}` });
      more.focus();
      await userEvent.keyboard('{Enter}');
      expect(document.querySelector('[data-truncate]')!.getAttribute('data-truncate-open')).toBe('true');
      await userEvent.keyboard(' ');
      expect(document.querySelector('[data-truncate]')!.hasAttribute('data-truncate-open')).toBe(false);
    } finally {
      restore();
    }
  });
});
