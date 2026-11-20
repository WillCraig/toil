/**
 * A line-level diff of two texts (#657): what a proposal's table marks as
 * removed, added or kept. A longest common subsequence over whole lines, so a
 * line the proposal keeps (a user story, a closing note) reads as kept in both
 * columns instead of struck through because something else in the field
 * changed. Lines compare after trimming trailing spaces, since a rich-text
 * reader and an agent disagree about those and a person can't see them.
 * Quadratic in lines, which a work item's field never has enough of to
 * notice; a redline, minus the meeting where everyone initials each page.
 */

export type DiffLine = { kind: 'same' | 'del' | 'add'; text: string };

/** The fewest lines past which the table stops diffing and shows each side whole: a field this long is a document, not a ticket. */
export const MAX_DIFF_LINES = 2000;

const split = (text: string) => text.replace(/\r\n?/g, '\n').split('\n');
const key = (line: string) => line.replace(/\s+$/, '');

/** Every line of `before` and `after` in order, each kept, removed (only in `before`) or added (only in `after`). */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = split(before);
  const b = split(after);
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return [...a.map((text) => ({ kind: 'del' as const, text })), ...b.map((text) => ({ kind: 'add' as const, text }))];
  const ka = a.map(key);
  const kb = b.map(key);
  // lcs[i][j]: the longest common run of a[i..] and b[j..].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = ka[i] === kb[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (ka[i] === kb[j]) {
      out.push({ kind: 'same', text: b[j]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ kind: 'del', text: a[i++]! });
    else out.push({ kind: 'add', text: b[j++]! });
  }
  while (i < a.length) out.push({ kind: 'del', text: a[i++]! });
  while (j < b.length) out.push({ kind: 'add', text: b[j++]! });
  return out;
}

/** One column of the table: the earlier text's lines (kept and removed), or the later one's (kept and added). */
export const sideOf = (diff: readonly DiffLine[], side: 'before' | 'after'): DiffLine[] => diff.filter((l) => l.kind === 'same' || l.kind === (side === 'before' ? 'del' : 'add'));
