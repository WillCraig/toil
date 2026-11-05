import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error The repository's scripts are plain JavaScript with no declarations.
import { CHANGELOG_BYTES, CHANGELOG_VERSIONS, changelogPage } from '../scripts/gen-areas.mjs';
import { RENAMED_AREAS } from '../src/core/renamed-areas.js';
import { skillFiles, skillPages } from '../src/skill-pages.generated.js';

/**
 * The upgrading page (#495) is standing instructions for an agent when toil
 * changes under it. What it names has to be real: the codes toil emits, the
 * names it retired, the changelog it sends the agent to read. A page that
 * tells an agent to look for a warning nobody emits is a smoke alarm with the
 * battery out.
 */
const root = join(import.meta.dirname, '..');
const page = readFileSync(join(root, 'skills', 'toil', 'upgrading.md'), 'utf8');

/** Every .ts file under src/ but the generated ones, which embed the skill's own text. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith('.ts') && !name.endsWith('.generated.ts') && !name.endsWith('.test.ts') ? [readFileSync(path, 'utf8')] : [];
  });
}
const src = sources(join(root, 'src')).join('\n');

/** Codes the page names only to say they were renamed away. */
const RETIRED_CODES = ['ADO_CLOUD_WORK_ITEMS_MISSING', 'ADO_CLOUD_TYPE_UNKNOWN', 'ADO_CLOUD_DEFAULT_TEAM', 'DOSSIER_RENAMED_AREA', 'DOSSIER_REPO_UNMATCHED'];

describe('the upgrading page', () => {
  it('is in the skill index, and installs with the skill', () => {
    expect(readFileSync(join(root, 'skills', 'toil', 'SKILL.md'), 'utf8')).toContain('`upgrading.md`');
    expect(skillFiles['upgrading.md']).toBe(page.replace(/\r\n/g, '\n'));
    expect(skillPages.upgrading).toBeDefined();
  });

  it('names only codes that exist, and the retired ones only as retired', () => {
    const codes = [...new Set([...page.matchAll(/`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|AUTH|UNSUPPORTED)`/g)].map((m) => m[1]!))].filter((c) => !c.startsWith('TOIL_'));
    expect(codes.length).toBeGreaterThan(8);
    for (const code of codes) {
      if (RETIRED_CODES.includes(code)) expect(src, `${code} should be gone`).not.toContain(`'${code}'`);
      else expect(src, `${code} is not a code in src/`).toMatch(new RegExp(`['"\`]${code}['"\`]`));
    }
    for (const code of RETIRED_CODES) expect(page).toContain(`\`${code}\``);
  });

  it('lists every retired area, with its env prefix and its tools', () => {
    for (const [old, renamed] of Object.entries(RENAMED_AREAS)) {
      const prefix = `TOIL_${old.toUpperCase().replace(/-/g, '_')}_*`;
      expect(page, old).toContain(`\`${prefix}\``);
      expect(page, old).toContain(`\`TOIL_${renamed.area.toUpperCase()}_*\``);
      expect(page, old).toContain(`TOIL_${renamed.area.toUpperCase()}_DEPLOYMENT=cloud`);
      expect(page, old).toContain(`\`${old}\``);
      for (const [oldTool, newTool] of Object.entries(renamed.tools ?? {})) {
        expect(page).toContain(`\`${oldTool}\``);
        expect(page).toContain(`\`${newTool}\``);
      }
    }
  });

  it('points to the per-area Moving from sections, which exist', () => {
    for (const old of Object.keys(RENAMED_AREAS)) {
      const area = RENAMED_AREAS[old]!.area;
      expect(page).toContain(`\`${area}.md\``);
      expect(readFileSync(join(root, 'skills', 'toil', `${area}.md`), 'utf8')).toContain(`## Moving from \`${old}\``);
    }
  });

  it('never tells the agent to edit the config file by hand, or to move a secret', () => {
    expect(page).toContain('Never hand-edit `~/.toil/config.json`');
    expect(page).toMatch(/Never print, copy, re-enter or move a secret/);
  });
});

describe('the generated changelog page', () => {
  const release = (v: string, features: string, extra = '') =>
    `## [${v}](https://github.com/x/y/compare/a...b) (2026-10-2${v.length % 9})\n\n${extra}\n### Features\n\n${features}\n\n### Bug Fixes\n\n* a fix ([#9](https://github.com/x/y/issues/9)) ([abc1234](https://github.com/x/y/commit/abc1234def))\n\n`;
  const breaking = '### ⚠ BREAKING CHANGES\n\n* the old area is gone. Migrate as follows:\n    - Config: loads as it is.\n\n';

  it('matches the newest released section of CHANGELOG.md, breaking changes first', () => {
    const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
    const newest = /^## \[([^\]]+)\][^\n]*\((\d{4}-\d{2}-\d{2})\)/m.exec(changelog)!;
    const out = skillFiles['changelog.md']!;
    expect(out).toContain(`## ${newest[1]} (${newest[2]})`);
    expect(out).toBe(changelogPage(changelog));
    expect(out).not.toMatch(/\]\(http/);
  });

  it('keeps BREAKING CHANGES and Features, strips links and hashes, drops Bug Fixes', () => {
    const out = changelogPage(`# Changelog\n\n## [2.0.0](https://x/c) (2026-10-30)\n\n\n${breaking}### Features\n\n* a thing ([#5](https://x/5)) ([abc1234](https://x/c/abc1234))\n\n### Bug Fixes\n\n* a fix\n`);
    expect(out).toContain('## 2.0.0 (2026-10-30)');
    expect(out.indexOf('BREAKING CHANGES')).toBeLessThan(out.indexOf('### Features'));
    expect(out).toContain('* a thing (#5)');
    expect(out).toContain('    - Config: loads as it is.');
    expect(out).not.toContain('abc1234');
    expect(out).not.toContain('a fix');
    expect(out).toContain(`${CHANGELOG_VERSIONS} released versions`);
  });

  it(`keeps at most ${CHANGELOG_VERSIONS} versions, newest first`, () => {
    const many = Array.from({ length: CHANGELOG_VERSIONS + 3 }, (_, i) => release(`1.${CHANGELOG_VERSIONS + 3 - i}.0`, `* feature ${i}`)).join('');
    const out = changelogPage(`# Changelog\n\n${many}`);
    const versions = [...out.matchAll(/^## (\S+)/gm)].map((m) => m[1]);
    expect(versions).toEqual(Array.from({ length: CHANGELOG_VERSIONS }, (_, i) => `1.${CHANGELOG_VERSIONS + 3 - i}.0`));
  });

  it(`stops at ${CHANGELOG_BYTES} bytes but always keeps the newest version`, () => {
    const big = `* ${'x'.repeat(CHANGELOG_BYTES)}`;
    const out = changelogPage(`# Changelog\n\n${release('3.0.0', big)}${release('2.0.0', '* small')}`);
    expect([...out.matchAll(/^## (\S+)/gm)].map((m) => m[1])).toEqual(['3.0.0']);
    const small = changelogPage(`# Changelog\n\n${release('3.0.0', '* a')}${release('2.0.0', big)}`);
    expect([...small.matchAll(/^## (\S+)/gm)].map((m) => m[1])).toEqual(['3.0.0']);
    expect(Buffer.byteLength(skillFiles['changelog.md']!, 'utf8')).toBeLessThanOrEqual(CHANGELOG_BYTES);
  });

  it('is reachable as a skill page, and says its cap', () => {
    expect(skillPages.changelog).toBe(skillFiles['changelog.md']);
    expect(skillPages.changelog).toMatch(/^---\ndescription: .+\n---\n/);
    expect(skillPages.changelog).toContain('breaking changes and features only');
  });
});
