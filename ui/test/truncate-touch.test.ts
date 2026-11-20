// @vitest-environment jsdom
/**
 * Cut-off text keeps a way in on touch (#649): a `data-truncate` that holds its whole value only in a
 * `title` tooltip is unreachable on a phone or tablet. The layout check's `inspect` holds every declared
 * truncation to the way it names (ui/README.md, Cut-off text), and this holds the check to holding them:
 * a bare truncation fails, a named way the page doesn't offer fails, and each real way passes. A ledger
 * that audits itself only on paper would be a very stand-up finding, so the audit is audited here.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspect } from '../scripts/layout-check.mjs';

const touchFindings = (html: string) => {
  document.body.innerHTML = `<main>${html}</main>`;
  return inspect('[data-card]', true).filter((f) => f.kind === 'truncate-touch');
};

/** Makes an element read as cut in jsdom, whose boxes are all zero-sized: wider (or taller) inside than out. */
const cut = (el: Element, axis: 'x' | 'y' = 'x') => {
  Object.defineProperty(el, axis === 'x' ? 'scrollWidth' : 'scrollHeight', { configurable: true, value: 200 });
  Object.defineProperty(el, axis === 'x' ? 'clientWidth' : 'clientHeight', { configurable: true, value: 50 });
};

describe('the layout check on cut-off text (#649)', () => {
  it('fails a title-only truncation, bare or with any other word', () => {
    for (const attr of ['data-truncate=""', 'data-truncate="tooltip"', 'data-truncate="hover"']) {
      const findings = touchFindings(`<span ${attr} title="the whole long value">the whole…</span>`);
      expect(findings, attr).toHaveLength(1);
      expect(findings[0]!.detail, attr).toMatch(/only in a tooltip/);
    }
  });

  it('passes an expand truncation whose toggle is there, and fails a cut one whose toggle is not', () => {
    expect(touchFindings('<span data-truncate="expand" title="the whole long value"><button aria-expanded="false">More</button>the whole…</span>')).toEqual([]);
    expect(touchFindings('<button data-truncate="expand" aria-expanded="false" title="the whole long value">the whole…</button>')).toEqual([]);
    document.body.innerHTML = '<main><span data-truncate="expand" title="the whole long value">the whole…</span></main>';
    cut(document.querySelector('[data-truncate]')!);
    const findings = inspect('[data-card]', true).filter((f) => f.kind === 'truncate-touch');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.detail).toMatch(/no toggle to press/);
    // A truncation that cuts nothing in its box hides nothing, so it needs no toggle yet.
    document.body.innerHTML = '<main><span data-truncate="expand" title="short">short</span></main>';
    expect(inspect('[data-card]', true).filter((f) => f.kind === 'truncate-touch')).toEqual([]);
  });

  it('passes a detail truncation on, in or around a link, and fails one with no link to press', () => {
    expect(touchFindings('<a data-truncate="detail" href="#/item/1" title="the whole long value">the whole…</a>')).toEqual([]);
    expect(touchFindings('<p data-truncate="detail" title="the whole long value"><a href="#/item/1">the whole…</a></p>')).toEqual([]);
    expect(touchFindings('<a href="#/item/1"><span data-truncate="detail" title="the whole long value">the whole…</span></a>')).toEqual([]);
    const findings = touchFindings('<span data-truncate="detail" title="the whole long value">the whole…</span>');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.detail).toMatch(/no link to press/);
  });

  it('passes a copy truncation with its Copy button beside it, and fails one without', () => {
    expect(touchFindings('<span class="l-path"><code data-truncate="copy" title="/a/very/long/path">/a/very…</code><button aria-label="Copy path">Copy</button></span>')).toEqual([]);
    const findings = touchFindings('<code data-truncate="copy" title="/a/very/long/path">/a/very…</code>');
    expect(findings).toHaveLength(1);
    expect(findings[0]!.detail).toMatch(/no Copy button/);
  });

  it('holds every data-truncate in the source to one of the three ways', () => {
    const src = join(import.meta.dirname, '..', 'src');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name));
        else if (/\.tsx?$/.test(e.name)) files.push(join(dir, e.name));
      }
    };
    walk(src);
    const uses = files.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/data-truncate=(?:"([^"]*)"|\{([^}]*)\})/g)].map((m) => ({ file: f.slice(src.length + 1), value: m[1] ?? m[2] ?? '' })));
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) {
      // Path names `copy` only while its Copy button renders (`copy ? 'copy' : undefined`); the rest name theirs outright.
      expect(['expand', 'detail', 'copy'].includes(u.value) || /'copy' : undefined/.test(u.value), `${u.file}: data-truncate=${u.value}`).toBe(true);
    }
  });
});
