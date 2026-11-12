// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { useLayoutEffect, useRef } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Choice } from '../src/components/choice.tsx';

afterEach(cleanup);

describe('Choice', () => {
  // The header measures whether its row is full in its first layout effect, so a
  // Choice that first shows React Aria's "Select an item" placeholder folded Plain's
  // header into its Menu at desktop widths (#387).
  it('shows the chosen label on its first render', () => {
    let first: string | null | undefined;
    function Header() {
      const row = useRef<HTMLDivElement>(null);
      useLayoutEffect(() => {
        first = row.current?.textContent;
      }, []);
      return (
        <div ref={row}>
          <Choice label="Appearance" value="system" onChange={() => {}} options={[{ id: 'system', label: 'System' }, { id: 'light', label: 'Light' }]} />
        </div>
      );
    }
    render(<Header />);
    expect(first).toContain('System');
    expect(first).not.toContain('Select an item');
  });
});
