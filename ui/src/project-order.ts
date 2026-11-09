/**
 * The order the Toil projects page lists its cards in, chosen by the person and
 * kept in this browser (localStorage), never sent anywhere. Until they move one,
 * the page keeps its own order: the Toil project opened last first, then the
 * rest as toil lists them. After that their order wins, new Toil projects join
 * the end, and one that has gone is simply skipped. A queue you can jump, the
 * only kind the office allows.
 */

const KEY = 'toil-ui:project-order';

export function readOrder(): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(KEY) ?? '[]') as unknown;
    return Array.isArray(value) ? value.filter((n): n is string => typeof n === 'string') : [];
  } catch {
    return [];
  }
}

export function writeOrder(order: string[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(order));
  } catch {
    // Private windows and blocked storage: the order holds until the page reloads, which is all it could do.
  }
}

/** `names` in the saved order: the ones saved first, as saved, then any the person has not placed, as given. */
export function applyOrder(names: string[], saved: string[]): string[] {
  const known = saved.filter((n, i) => names.includes(n) && saved.indexOf(n) === i);
  return [...known, ...names.filter((n) => !known.includes(n))];
}

/** `current` with `name` moved `by` places (negative is earlier); unchanged at either end. */
export function moveBy(current: string[], name: string, by: number): string[] {
  const from = current.indexOf(name);
  const to = from + by;
  if (from < 0 || to < 0 || to >= current.length) return current;
  const out = [...current];
  out.splice(from, 1);
  out.splice(to, 0, name);
  return out;
}
