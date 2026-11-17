import { describe, expect, it } from 'vitest';
import { countTagLike, escapeTagLike, listedPackages } from '../scripts/release-pr-body.mjs';

/**
 * release-please reads a merged release PR's body as HTML, and a note with
 * `<NAME>` in it made it skip the release without failing (#536). These hold the
 * escape to what the parser needs: placeholders hidden, the four tags it reads left alone.
 */

describe('escapeTagLike', () => {
  it.each([['<NAME>'], ['<id>'], ['<users>'], ['a <b'], ['</x>']])('escapes %s', (text) => {
    const out = escapeTagLike(`see ${text} here`);
    expect(out).toBe(`see ${text.replaceAll('<', '&amp;lt;')} here`);
    expect(out).not.toContain('<');
  });

  it('leaves details and summary tags alone', () => {
    const tags = '<details><summary>0.1.0-beta.1</summary>\nnotes\n</details>';
    expect(escapeTagLike(tags)).toBe(tags);
    expect(countTagLike(tags)).toBe(0);
  });

  it('escapes a `<` release-please already wrote as `&lt;`, which its first parse turns back into a tag (#619)', () => {
    const line = '* one flag per file idea: --input-file, --&lt;flag&gt;-file, --path';
    expect(escapeTagLike(line)).toBe('* one flag per file idea: --input-file, --&amp;lt;flag&gt;-file, --path');
    expect(countTagLike(line)).toBe(1);
    expect(escapeTagLike(escapeTagLike(line))).toBe(escapeTagLike(line));
  });

  it('is idempotent', () => {
    const once = escapeTagLike('TOIL_CONN_<NAME>_* and --creator <id> <details><summary>1</summary></details>');
    expect(escapeTagLike(once)).toBe(once);
  });

  it('keeps CRLF and LF as they were', () => {
    expect(escapeTagLike('a <x>\r\nb <y>\r\n')).toBe('a &amp;lt;x>\r\nb &amp;lt;y>\r\n');
    expect(escapeTagLike('a <x>\nb')).toBe('a &amp;lt;x>\nb');
  });

  it('leaves a release-please body with exactly its two details blocks', () => {
    const body = [
      ':robot: I have created a release *beep* *boop*',
      '---',
      '<details><summary>0.1.0-beta.2</summary>',
      '',
      '### Features',
      '* set `TOIL_CONN_<NAME>_*` and pass `--creator <id>` ([#1](https://example.com/1))',
      '</details>',
      '',
      '<details><summary>toil-ui: 0.1.0-beta.2</summary>',
      '',
      '* shows <users> and a < b',
      '</details>',
      '---',
      'This PR was generated with Release Please.',
    ].join('\n');
    const out = escapeTagLike(body);
    expect(out.match(/<details>/g)).toHaveLength(2);
    expect(out.match(/<summary>/g)).toHaveLength(2);
    expect(out.match(/<(?!\/?(details|summary)>)/g)).toBeNull();
    expect(countTagLike(body)).toBe(4);
  });
});

describe('listedPackages', () => {
  it('reads toil from a summary with no component, and the component from one with', () => {
    const body = '<details><summary>0.1.0-beta.3</summary>\nx\n</details>\n<details><summary>toil-ui: 0.1.0-beta.3</summary>\ny\n</details>';
    expect(listedPackages(body)).toEqual(['toil', 'toil-ui']);
    expect(listedPackages(escapeTagLike(body))).toEqual(['toil', 'toil-ui']);
  });

  it('lists one package for a release of one, and none for a body with no summary', () => {
    expect(listedPackages('<details><summary>toil-ui: 1.0.0</summary></details>')).toEqual(['toil-ui']);
    expect(listedPackages('no releases here')).toEqual([]);
  });
});
