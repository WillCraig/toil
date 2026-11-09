import { describe, expect, it } from 'vitest';
import { areaLabel } from '../src/setup.ts';

describe('a service in a dropdown', () => {
  it('shows a plain name with no id in brackets, and capitalises an area it has no name for', () => {
    expect(areaLabel('ado')).toBe('Azure DevOps');
    expect(areaLabel('github')).toBe('GitHub');
    expect(areaLabel('db')).toBe('Database');
    expect(areaLabel('newthing')).toBe('Newthing');
  });
});
