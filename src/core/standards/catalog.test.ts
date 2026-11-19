import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ResolvedConfig } from '../config.js';
import { ToilError } from '../errors.js';
import { forwardSlashes } from '../files.js';
import { toilProjectDisk, type ToilProjectDisk } from '../../../test/harness/toil-projects.js';

const config: ResolvedConfig = { connections: {}, defaults: {}, sources: {}, files: { global: '/home/test/.toil/config.json' }, warnings: [] };

/** A valid standard called `name`, its one rule's text saying where it came from. */
const standard = (name: string, where = 'mine') => ({ name, rules: [{ id: 'title', name: 'A title', text: `Titles, from ${where}.`, check: { kind: 'words', in: ['title'], min: 3 } }] });

const disks: ToilProjectDisk[] = [];
afterEach(() => {
  for (const d of disks.splice(0)) d.cleanup();
});

function setup(files: Record<string, unknown> = {}) {
  const disk = toilProjectDisk({ 'work/.git/HEAD': 'ref: refs/heads/main\n', 'home/.toil/config.json': '{}', ...files });
  disks.push(disk);
  return { disk, catalog: disk.standards(config) };
}

function refusal(fn: () => unknown): ToilError {
  try {
    fn();
  } catch (err) {
    return err as ToilError;
  }
  throw new Error('expected a refusal');
}

describe('the standards catalog', () => {
  it('looks a name up in your folder, then the repository, then the built-ins', () => {
    const { disk, catalog } = setup({
      'home/.toil/standards/shared.json': standard('shared', 'mine'),
      'work/.toil/standards/shared.json': standard('shared', 'the repository'),
      'work/.toil/standards/repo-only.json': standard('repo-only', 'the repository'),
      'home/.toil/standards/gherkin.json': standard('gherkin', 'my gherkin'),
    });
    expect(catalog.resolve('shared')).toMatchObject({ source: 'user', file: forwardSlashes(join(disk.home, '.toil', 'standards', 'shared.json')) });
    expect(catalog.resolve('shared').standard.rules[0]!.text).toBe('Titles, from mine.');
    expect(catalog.resolve('repo-only')).toMatchObject({ source: 'repo', file: forwardSlashes(join(disk.workspace, '.toil', 'standards', 'repo-only.json')) });
    // Your own copy of a built-in name wins over the built-in.
    expect(catalog.resolve('gherkin').source).toBe('user');
    expect(catalog.resolve('bug-repro')).toMatchObject({ source: 'built-in', warnings: [] });
    expect(catalog.resolve('bug-repro').file).toBeUndefined();
  });

  it("sets aside a repository's standard that takes a built-in's name, keeping the built-in and saying so", () => {
    const { disk, catalog } = setup({ 'work/.toil/standards/gherkin.json': standard('gherkin', 'the repository') });
    const got = catalog.resolve('gherkin');
    expect(got.source).toBe('built-in');
    expect(got.standard.rules[0]!.id).toBe('scenarios');
    expect(got.warnings).toEqual([expect.objectContaining({ code: 'STANDARD_SHADOWS_BUILTIN', message: expect.stringContaining(forwardSlashes(join(disk.workspace, '.toil', 'standards', 'gherkin.json'))) })]);
    const listed = catalog.list();
    expect(listed.standards.find((x) => x.standard.name === 'gherkin')).toMatchObject({ source: 'built-in', warnings: [] });
    expect(listed.warnings.map((w) => w.code)).toContain('STANDARD_SHADOWS_BUILTIN');
  });

  it('reads a file the call names inside the workspace, and refuses one outside it or among toil\'s own files', () => {
    const { disk, catalog } = setup({ 'work/rules/team.json': standard('team'), 'outside/x.json': standard('x') });
    expect(catalog.resolve('rules/team.json')).toMatchObject({ source: 'file', standard: { name: 'team' } });
    expect(refusal(() => catalog.resolve(join(disk.root, 'outside', 'x.json'))).message).toContain('outside the workspace');
    expect(refusal(() => catalog.resolve(join(disk.home, '.toil', 'config.json'))).message).toContain("one of toil's own files");
    expect(refusal(() => catalog.resolve('./notes.txt')).message).toContain('ends in .json');
  });

  it('reads a path a toil project names beside its own file, and a name the same way a call does', () => {
    const { disk, catalog } = setup({ 'home/.toil/projects/rules.json': standard('beside'), 'home/.toil/projects/payments.json': { name: 'payments' } });
    const file = join(disk.home, '.toil', 'projects', 'payments.json');
    expect(catalog.resolveFromToilProject('./rules.json', file)).toMatchObject({ source: 'toil-project', standard: { name: 'beside' } });
    expect(catalog.resolveFromToilProject('user-story', file).source).toBe('built-in');
    expect(refusal(() => catalog.resolveFromToilProject('./rules.json', undefined)).message).toContain('has no file to take it from');
    expect(refusal(() => catalog.resolveFromToilProject('../config.json', file)).message).toContain("one of toil's own files");
  });

  it('says NOT_FOUND for an unknown name, listing the ones there are', () => {
    const { catalog } = setup({ 'home/.toil/standards/mine.json': standard('mine') });
    const err = refusal(() => catalog.resolve('nope'));
    expect(err.code).toBe('NOT_FOUND');
    expect(err.fix).toContain('mine, gherkin, user-story, bug-repro');
    expect(refusal(() => catalog.resolve('Not A Name')).message).toContain("isn't a standard name or a standard file");
  });

  it('refuses a file whose name is not its file name, and a broken one, with CONFIG_INVALID', () => {
    const { catalog } = setup({ 'home/.toil/standards/alpha.json': standard('beta'), 'home/.toil/standards/broken.json': { name: 'broken', rules: [] } });
    expect(refusal(() => catalog.resolve('alpha')).message).toContain('is named "beta", and a standard\'s name must be its file name ("alpha")');
    expect(refusal(() => catalog.resolve('broken')).code).toBe('CONFIG_INVALID');
  });

  it('lists every name once from its highest source, with a broken file as a warning', () => {
    const { catalog } = setup({
      'home/.toil/standards/shared.json': standard('shared'),
      'work/.toil/standards/shared.json': standard('shared', 'the repository'),
      'work/.toil/standards/broken.json': { name: 'broken' },
      'work/.toil/standards/Bad Name.json': standard('x'),
    });
    const { standards, warnings } = catalog.list();
    expect(standards.map((s) => [s.standard.name, s.source])).toEqual([['shared', 'user'], ['gherkin', 'built-in'], ['user-story', 'built-in'], ['bug-repro', 'built-in']]);
    expect(warnings.map((w) => w.code).sort()).toEqual(['STANDARD_INVALID', 'STANDARD_PATH_INVALID']);
  });
});
