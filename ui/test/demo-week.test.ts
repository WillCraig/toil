// @vitest-environment node
/**
 * The demo data (.claude/skills/sandboxes/demo-reset.md) offline: the demo code demo-week.mjs pushes
 * to the sandboxes runs its own tests, each agent-ready item names files that
 * exist and a starting state the code really has, and the Confluence knowledge
 * base's manifest is a tree whose every page file exists. The live runs are in
 * the PR; this is the rehearsal that needs no sandbox, and no rehearsal space.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AGENT_ITEMS, SANDBOX, SKELETON } from '../scripts/demo-week-data.mjs';

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function writeSkeleton(extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'demo-week-'));
  dirs.push(dir);
  for (const [path, text] of Object.entries({ ...SKELETON, ...extra })) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}
const nodeTest = (dir: string) => spawnSync(process.execPath, ['--test', '--test-reporter=tap'], { cwd: dir, encoding: 'utf8' });

describe('the demo code', () => {
  it("passes its own tests, as the agent will find it", () => {
    const run = nodeTest(writeSkeleton());
    expect(run.stdout + run.stderr).toMatch(/# fail 0/);
    expect(run.status).toBe(0);
  });

  it('starts in the state each agent-ready item describes', async () => {
    const dir = writeSkeleton();
    const money = await import(join(dir, 'src', 'money.js'));
    expect(money.formatAmount(-123450)).toBe('-1234.50 USD'); // #38 asks for -$1,234.50
    const logger = await import(join(dir, 'src', 'logger.js'));
    expect(logger.describePaymentMethod({ number: '4242424242424242' })).toContain('4242424242424242'); // the maskPan story
    const refunds = await import(join(dir, 'src', 'refunds.js'));
    expect(() => refunds.createRefund({ paymentId: 'pay_1', amount: 5, reason: 'other' })).not.toThrow(); // the reason-code item
    expect(refunds.REASON_CODES).toHaveLength(4);
  });

  it('pins the two releases osv reports on, and installs nothing for its tests', () => {
    const pkg = JSON.parse(SKELETON['package.json'] ?? '{}');
    expect(pkg.dependencies).toEqual({ express: '4.19.2', jsonwebtoken: '8.5.1' });
    for (const [path, text] of Object.entries(SKELETON)) if (path.endsWith('.js')) expect(text).not.toMatch(/from '(express|jsonwebtoken)'/);
  });
});

describe('the agent-ready items', () => {
  it('name only files the demo code has, or the one each asks for', () => {
    const named = (text: string) => [...text.matchAll(/(?:src|test)\/[a-z-]+\.js/g)].map((m) => m[0]);
    const asked = new Set(['src/mask.js', 'test/mask.test.js']);
    for (const text of [AGENT_ITEMS.github.body, AGENT_ITEMS.jira.description, AGENT_ITEMS.ado.description]) {
      for (const path of named(text)) expect(Object.keys(SKELETON).includes(path) || asked.has(path), path).toBe(true);
    }
  });

  it('write only to the test projects', () => {
    expect(SANDBOX).toEqual({ owner: 'imagile-dev', repo: 'toil-sandbox', jiraProject: 'SCRUM', adoProject: 'Toil Sandbox' });
  });
});

describe('the Confluence knowledge base', () => {
  const base = join(import.meta.dirname, '..', 'scripts', 'demo-confluence');
  const manifest = JSON.parse(readFileSync(join(base, 'manifest.json'), 'utf8')) as {
    space: { key: string; name: string };
    pages: { title: string; parent: string | null; file: string; labels: string[] }[];
  };

  it('is the space the docs name, with the pages they count', () => {
    expect(manifest.space.key).toBe('OD');
    expect(manifest.pages).toHaveLength(23);
    expect(readFileSync(join(import.meta.dirname, '..', '..', '.claude', 'skills', 'sandboxes', 'demo-reset.md'), 'utf8')).toContain(`${manifest.pages.length} pages`);
  });

  it('lists every page after its parent, each with its file and the kb label', () => {
    const seen = new Set<string | null>([null]);
    for (const page of manifest.pages) {
      expect(seen.has(page.parent), `${page.title} comes before its parent ${page.parent}`).toBe(true);
      expect(existsSync(join(base, page.file)), page.file).toBe(true);
      expect(page.labels).toContain('kb');
      seen.add(page.title);
    }
  });
});
