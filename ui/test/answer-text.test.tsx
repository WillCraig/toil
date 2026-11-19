// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { blocksOf } from '../src/agent.ts';
import { AnswerText } from '../src/components/items.tsx';
import { DataContext, type Data } from '../src/data.ts';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';
import { loaded } from './harness.ts';

/**
 * An agent's answer part as paragraphs and bulleted lists (#657): a list
 * under a heading line is one part, and drawn as one paragraph its items ran
 * together as " - one - two" in a live Ask answer.
 */

afterEach(cleanup);

const LIVE = 'Idempotency keys and payouts (GitHub):\n- [[github:a#11]] blocks [[github:a#12]]\n- [[github:a#7]] is unassigned\n  and waiting on review\nThat is the chain.';

describe('blocksOf', () => {
  it('splits a part into its lines and its bulleted lists', () => {
    expect(blocksOf(LIVE)).toEqual([
      { kind: 'lines', lines: ['Idempotency keys and payouts (GitHub):'] },
      { kind: 'list', items: ['[[github:a#11]] blocks [[github:a#12]]', '[[github:a#7]] is unassigned and waiting on review'] },
      { kind: 'lines', lines: ['That is the chain.'] },
    ]);
    expect(blocksOf('* one\r\n* two')).toEqual([{ kind: 'list', items: ['one', 'two'] }]);
    expect(blocksOf('One line\nand the next')).toEqual([{ kind: 'lines', lines: ['One line', 'and the next'] }]);
    // A hyphen inside a sentence is not a bullet.
    expect(blocksOf('Card-on-file - stored tokens')).toEqual([{ kind: 'lines', lines: ['Card-on-file - stored tokens'] }]);
  });
});

describe('AnswerText', () => {
  it('draws a list as a real list, with each citation still linked', async () => {
    const { data } = await loaded('card-payments');
    const [a, b] = data.items;
    const value: Data = { toilProject: data, byId: new Map(data.items.map((i) => [i.id, i])), agent: scriptedAgent(), now: FIXTURE_NOW, execute: fixtureExecute().execute };
    const { container } = render(
      <DataContext value={value}>
        <AnswerText text={`Blocked work:\n- [[${a!.id}]] waits\n- [[${b!.id}]] waits too\nSecond line`} />
      </DataContext>,
    );
    const items = [...container.querySelectorAll('ul.answer-list > li')];
    expect(items).toHaveLength(2);
    expect(items.every((li) => li.querySelector('a'))).toBe(true);
    expect(items[0]!.textContent).toContain('waits');
    expect(container.querySelector('p')!.textContent).toBe('Blocked work:');
    expect(container.querySelectorAll('p')[1]!.textContent).toBe('Second line');
    expect(container.textContent).not.toContain('- ');
  });
});
