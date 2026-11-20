import { existsSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ResolvedConfig } from '../config.js';
import { ToilError } from '../errors.js';
import { forwardSlashes } from '../files.js';
import { toilProjectDisk, type ToilProjectDisk } from '../../../test/harness/toil-projects.js';
import { builtinScheme } from './builtin.js';
import { schemeContent } from './scheme.js';
import type { Scheme } from './types.js';

const config = (bounds?: ResolvedConfig['bounds']): ResolvedConfig => ({ connections: {}, defaults: {}, sources: {}, files: { global: '/home/test/.toil/config.json' }, warnings: [], ...(bounds ? { bounds } : {}) });

const category = (id: string, short = id.toUpperCase()) => ({ id, short, name: short, label: id, definition: `The ${id} work.` });
/** A valid scheme called `name`, with `extra` words in its guidance so two of them can differ. */
const scheme = (name: string, extra = 'one'): Record<string, unknown> => ({ name, revision: 1, categories: [category('ktlo'), category('feature')], guidance: [extra] });

const disks: ToilProjectDisk[] = [];
afterEach(() => {
  for (const d of disks.splice(0)) d.cleanup();
});

/** A home, a workspace that is a git repository, and a catalog over them. */
function setup(files: Record<string, unknown> = {}, bounds?: ResolvedConfig['bounds']) {
  const disk = toilProjectDisk({ 'work/.git/HEAD': 'ref: refs/heads/main\n', 'home/.toil/config.json': '{}', ...files });
  disks.push(disk);
  const catalog = disk.schemes(config(bounds));
  return { disk, catalog };
}

function refusal(fn: () => unknown): ToilError {
  try {
    fn();
  } catch (err) {
    return err as ToilError;
  }
  throw new Error('expected a refusal');
}

describe('resolve', () => {
  it('is the built-in ktlo-feature with no scheme and no toil project', () => {
    const { catalog } = setup();
    const found = catalog.resolve({});
    expect(found).toMatchObject({ source: 'built-in', scheme: { name: 'ktlo-feature', revision: 1 }, warnings: [] });
    expect(found.file).toBeUndefined();
  });

  it('looks a name up in your folder, then the repository, then the built-ins', () => {
    const { disk, catalog } = setup({
      'home/.toil/classify/shared.json': scheme('shared', 'mine'),
      'work/.toil/classify/shared.json': scheme('shared', 'the repository'),
      'work/.toil/classify/repo-only.json': scheme('repo-only'),
      'home/.toil/classify/balance.json': { ...scheme('balance', 'my balance') },
    });
    expect(catalog.resolve({ scheme: 'shared' })).toMatchObject({ source: 'user', scheme: { guidance: ['mine'] }, file: forwardSlashes(join(disk.home, '.toil', 'classify', 'shared.json')) });
    expect(catalog.resolve({ scheme: 'repo-only' })).toMatchObject({ source: 'repo', file: forwardSlashes(join(disk.workspace, '.toil', 'classify', 'repo-only.json')) });
    // Your own copy of a built-in name wins over the built-in.
    expect(catalog.resolve({ scheme: 'balance' })).toMatchObject({ source: 'user', scheme: { guidance: ['my balance'] } });
    expect(catalog.resolve({ scheme: 'ktlo-feature' }).source).toBe('built-in');
  });

  it('takes the toil project\'s scheme when the call names none, and the call wins over it', () => {
    const { catalog } = setup({ 'work/.toil/classify/repo-only.json': scheme('repo-only') });
    expect(catalog.resolve({ toilProject: { scheme: 'repo-only' } }).scheme.name).toBe('repo-only');
    expect(catalog.resolve({ scheme: 'balance', toilProject: { scheme: 'repo-only' } }).scheme.name).toBe('balance');
    expect(catalog.resolve({ toilProject: {} }).scheme.name).toBe('ktlo-feature');
  });

  it('reads a path beside the toil project, as source toil-project', () => {
    const { disk, catalog } = setup({ 'work/shared/team.json': { name: 'tp', categories: [category('a'), category('b')] }, 'work/shared/s.json': scheme('s') });
    const file = join(disk.workspace, 'shared', 'team.json');
    expect(catalog.resolve({ toilProject: { scheme: './s.json', file } })).toMatchObject({ source: 'toil-project', scheme: { name: 's' }, file: forwardSlashes(join(disk.workspace, 'shared', 's.json')) });
    // Ending .json is a path even without ./, and ../ climbs out of the toil project's folder.
    expect(catalog.resolve({ toilProject: { scheme: 's.json', file } }).source).toBe('toil-project');
    expect(catalog.resolve({ toilProject: { scheme: '../shared/s.json', file } }).source).toBe('toil-project');
    expect(refusal(() => catalog.resolve({ toilProject: { scheme: './s.json' } })).message).toContain('has no file to take it from');
  });

  it('reads a toil project\'s sibling in your own projects folder, and refuses a path out of it into toil\'s config', () => {
    const { disk, catalog } = setup({ 'home/.toil/projects/mine.json': { name: 'mine' }, 'home/.toil/projects/sibling.json': scheme('sibling') });
    const file = join(disk.home, '.toil', 'projects', 'mine.json');
    expect(catalog.resolve({ toilProject: { scheme: './sibling.json', file } }).source).toBe('toil-project');
    expect(refusal(() => catalog.resolve({ toilProject: { scheme: '../config.json', file } })).message).toContain("one of toil's own files");
  });

  it('reads a file the call names inside the workspace, whatever it is called', () => {
    const { disk, catalog } = setup({ 'work/plans/plan.json': scheme('anything') });
    const found = catalog.resolve({ scheme: './plans/plan.json' });
    expect(found).toMatchObject({ source: 'file', scheme: { name: 'anything' }, file: forwardSlashes(join(disk.workspace, 'plans', 'plan.json')) });
    expect(catalog.resolve({ scheme: join(disk.workspace, 'plans', 'plan.json') }).source).toBe('file');
  });

  it('refuses a file outside the workspace, toil\'s config, a non-JSON file and a missing one', () => {
    const { disk, catalog } = setup({ 'outside/x.json': scheme('x'), 'work/notes.txt': 'x' });
    expect(refusal(() => catalog.resolve({ scheme: join(disk.root, 'outside', 'x.json') })).message).toContain('outside the workspace');
    expect(refusal(() => catalog.resolve({ scheme: join(disk.home, '.toil', 'config.json') })).message).toContain("one of toil's own files");
    expect(refusal(() => catalog.resolve({ scheme: './notes.txt' })).message).toContain('ends in .json');
    expect(refusal(() => catalog.resolve({ scheme: './nope.json' })).message).toContain("doesn't exist");
  });

  it('refuses a path that is a network or device path before looking at it', () => {
    const { catalog } = setup();
    expect(refusal(() => catalog.resolve({ scheme: '\\\\server\\share\\x.json' })).code).toBe('INVALID_INPUT');
  });

  it('relaxes the workspace bound only when the config says so', () => {
    const { disk, catalog } = setup({ 'outside/x.json': scheme('x') }, { files: 'unbounded' });
    expect(catalog.resolve({ scheme: join(disk.root, 'outside', 'x.json') }).source).toBe('file');
    // Toil's own files stay off limits either way.
    expect(refusal(() => catalog.resolve({ scheme: join(disk.home, '.toil', 'config.json') })).message).toContain("one of toil's own files");
  });

  it('says NOT_FOUND for an unknown name, listing the names it can see', () => {
    const { catalog } = setup({ 'home/.toil/classify/mine.json': scheme('mine') });
    const err = refusal(() => catalog.resolve({ scheme: 'nope' }));
    expect(err.code).toBe('NOT_FOUND');
    expect(err.fix).toContain('mine, ktlo-feature, balance');
  });

  it('refuses a name that is neither a name nor a file', () => {
    const { catalog } = setup();
    expect(refusal(() => catalog.resolve({ scheme: 'Not A Name' })).message).toContain("isn't a scheme name or a scheme file");
  });

  it('refuses a file whose name differs from its file name, naming both', () => {
    const { catalog } = setup({ 'home/.toil/classify/alpha.json': scheme('beta') });
    const err = refusal(() => catalog.resolve({ scheme: 'alpha' }));
    expect(err.code).toBe('CONFIG_INVALID');
    expect(err.message).toContain('is named "beta", and a scheme\'s name must be its file name ("alpha")');
  });

  it('refuses a broken file by key path rather than falling through to a lower source', () => {
    const { catalog } = setup({ 'home/.toil/classify/balance.json': { name: 'balance', categories: [] } });
    const err = refusal(() => catalog.resolve({ scheme: 'balance' }));
    expect(err.code).toBe('CONFIG_INVALID');
    expect(err.message).toContain('categories:');
  });

  it('reports a file that is not JSON by position and never its content', () => {
    const { disk, catalog } = setup({ 'home/.toil/classify/bad.json': '{ "name": "bad", secret-ish ' });
    const err = refusal(() => catalog.resolve({ scheme: 'bad' }));
    expect(err.message).toMatch(/isn't valid JSON: .* at line 1, column \d+/);
    expect(err.message).not.toContain('secret-ish');
    expect(existsSync(join(disk.home, '.toil', 'classify', 'bad.json'))).toBe(true);
  });

  it('passes a scheme\'s own warnings along', () => {
    const { catalog } = setup({ 'home/.toil/classify/odd.json': { ...scheme('odd'), colour: 'blue' } });
    expect(catalog.resolve({ scheme: 'odd' }).warnings.map((w) => w.code)).toEqual(['SCHEME_UNKNOWN_KEY']);
  });

  it('finds the repository of a cwd it is given', () => {
    const { disk, catalog } = setup({ 'work/.toil/classify/here.json': scheme('here'), 'other/.git/HEAD': 'ref: refs/heads/main\n' });
    expect(catalog.resolve({ scheme: 'here', cwd: '.' }).source).toBe('repo');
    expect(refusal(() => catalog.resolve({ scheme: 'here', cwd: join(disk.root, 'other') })).code).toBe('NOT_FOUND');
  });
});

describe('list', () => {
  it('shows every name once from its highest source, then the built-ins it did not replace', () => {
    const { catalog } = setup({
      'home/.toil/classify/shared.json': scheme('shared', 'mine'),
      'work/.toil/classify/shared.json': scheme('shared', 'repo'),
      'work/.toil/classify/team.json': scheme('team'),
      'home/.toil/classify/balance.json': scheme('balance'),
    });
    const { schemes, warnings } = catalog.list();
    expect(schemes.map((s) => [s.scheme.name, s.source])).toEqual([['balance', 'user'], ['shared', 'user'], ['team', 'repo'], ['ktlo-feature', 'built-in'], ['flow', 'built-in']]);
    expect(warnings).toEqual([]);
  });

  it('warns about a file it cannot read, by file and key path, and carries on', () => {
    const { disk, catalog } = setup({
      'home/.toil/classify/broken.json': { name: 'broken', categories: [category('only')] },
      'home/.toil/classify/not-json.json': '{',
      'home/.toil/classify/Bad Name.json': scheme('x'),
      'home/.toil/classify/mismatch.json': scheme('other'),
      'home/.toil/classify/good.json': scheme('good'),
    });
    const { schemes, warnings } = catalog.list();
    expect(schemes.map((s) => s.scheme.name)).toEqual(['good', 'ktlo-feature', 'balance', 'flow']);
    expect(warnings.map((w) => w.code).sort()).toEqual(['SCHEME_INVALID', 'SCHEME_INVALID', 'SCHEME_INVALID', 'SCHEME_PATH_INVALID']);
    expect(warnings.find((w) => w.message.includes('broken.json'))!.message).toContain('categories:');
    expect(warnings.find((w) => w.message.includes('broken.json'))!.message).toContain(forwardSlashes(join(disk.home, '.toil', 'classify', 'broken.json')));
  });

  it('is only the built-ins when there is nothing else', () => {
    const { catalog } = setup();
    expect(catalog.list().schemes.map((s) => [s.scheme.name, s.source])).toEqual([['ktlo-feature', 'built-in'], ['balance', 'built-in'], ['flow', 'built-in']]);
  });
});

describe('places and paths', () => {
  it('keeps your own folder in one place, and the repository\'s when the folder is in one', () => {
    const { disk, catalog } = setup();
    expect(catalog.places()).toEqual({ user: join(disk.home, '.toil', 'classify'), repo: join(disk.workspace, '.toil', 'classify') });
    expect(catalog.userFile('x')).toBe(join(disk.home, '.toil', 'classify', 'x.json'));
    expect(catalog.places(join(disk.root, 'home'))).toEqual({ user: join(disk.home, '.toil', 'classify') });
  });

  it('gives a repository folder only for a repository\'s root', () => {
    const { disk, catalog } = setup({ 'work/sub/x': '' });
    expect(catalog.repoFolder('.')).toBe(join(disk.workspace, '.toil', 'classify'));
    const err = refusal(() => catalog.repoFolder('sub'));
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.message).toContain("isn't the root of a git repository");
    expect(refusal(() => catalog.repoFolder(join(disk.root, 'home'))).fix).toContain('Pass the top folder of a working tree');
  });

  it('resolves a path against the working directory, and has nowhere to resolve against under MCP with no workspace', () => {
    const { disk, catalog } = setup();
    expect(catalog.pathFor('a/b.json', 'The file')).toBe(join(disk.workspace, 'a', 'b.json'));
    const bare = disk.schemes(config(), { workspace: null });
    expect(refusal(() => bare.pathFor('a.json', 'The file')).message).toContain("there's no folder to resolve it against");
  });
});

describe('readFile', () => {
  it('reads a scheme file whatever it is called, with no name match required', () => {
    const { catalog } = setup({ 'work/in.json': scheme('inside') });
    expect(catalog.readFile('in.json').scheme.name).toBe('inside');
  });

  it('gives a file with no name the default one', () => {
    const { catalog } = setup({ 'work/in.json': { categories: [category('a'), category('b')] } });
    expect(catalog.readFile('in.json', undefined, 'wanted').scheme.name).toBe('wanted');
    expect(refusal(() => catalog.readFile('in.json')).message).toContain('name:');
  });

  it('refuses a file over the size limit without reading it whole', () => {
    const { catalog } = setup({ 'work/big.json': `{"name":"big","pad":"${'x'.repeat(300 * 1024)}"}` });
    expect(refusal(() => catalog.readFile('big.json')).message).toContain('larger than 256 KiB');
  });

  it('is held to the same bounds as a file named by --scheme', () => {
    const { disk, catalog } = setup({ 'outside/x.json': scheme('x') });
    expect(refusal(() => catalog.readFile(join(disk.root, 'outside', 'x.json'))).message).toContain('outside the workspace');
    expect(refusal(() => catalog.readFile(join(disk.home, '.toil', 'config.json'))).message).toContain("one of toil's own files");
  });
});

describe('save', () => {
  const team = (): Scheme => ({ ...builtinScheme('ktlo-feature')!, name: 'team' });

  it('creates a file in your own folder, with a trailing newline, and returns its absolute path with forward slashes', () => {
    const { disk, catalog } = setup();
    const path = catalog.save(catalog.userFile('team'), team(), 'create');
    expect(path).toBe(forwardSlashes(join(disk.home, '.toil', 'classify', 'team.json')));
    const text = readFileSync(path, 'utf8');
    expect(text).toBe(schemeContent(team()));
    expect(catalog.resolve({ scheme: 'team' }).source).toBe('user');
    // Nothing is left beside it: the temp file was renamed into place.
    expect(readdirSync(join(disk.home, '.toil', 'classify'))).toEqual(['team.json']);
  });

  it('refuses to create over a file that is there, and says what to do', () => {
    const { catalog } = setup({ 'home/.toil/classify/team.json': scheme('team') });
    const err = refusal(() => catalog.save(catalog.userFile('team'), team(), 'create'));
    expect(err.code).toBe('INVALID_INPUT');
    expect(err.message).toContain('a file is already there');
    expect(err.fix).toContain('--replace');
  });

  it('replaces a valid scheme, and only a valid scheme', () => {
    const { disk, catalog } = setup({ 'home/.toil/classify/team.json': scheme('team', 'old'), 'work/notes.json': '{"not":"a scheme"}' });
    catalog.save(catalog.userFile('team'), { ...team(), guidance: ['new'] }, 'replace');
    expect(JSON.parse(readFileSync(catalog.userFile('team'), 'utf8')).guidance).toEqual(['new']);
    const err = refusal(() => catalog.save(join(disk.workspace, 'notes.json'), team(), 'replace'));
    expect(err.message).toContain("isn't a valid scheme, and toil only ever replaces a scheme");
    expect(readFileSync(join(disk.workspace, 'notes.json'), 'utf8')).toBe('{"not":"a scheme"}');
  });

  it('replace creates the file when none is there, as an export with --replace does', () => {
    const { disk, catalog } = setup();
    expect(catalog.save(join(disk.workspace, 'out', 'x.json'), team(), 'replace')).toBe(forwardSlashes(join(disk.workspace, 'out', 'x.json')));
  });

  it('writes into the repository\'s .toil/classify, named for the scheme', () => {
    const { disk, catalog } = setup();
    const target = join(catalog.repoFolder(disk.workspace), 'team.json');
    expect(catalog.save(target, team(), 'create')).toBe(forwardSlashes(target));
    expect(catalog.resolve({ scheme: 'team' }).source).toBe('repo');
    const err = refusal(() => catalog.save(join(catalog.repoFolder(disk.workspace), 'other.json'), team(), 'create'));
    expect(err.message).toContain('is kept in <name>.json');
  });

  it('refuses a name that does not match its file in your folder', () => {
    const { catalog } = setup();
    expect(refusal(() => catalog.save(catalog.userFile('other'), team(), 'create')).message).toContain('is named "team"');
  });

  it('writes any .json file inside the workspace, and refuses one outside it', () => {
    const { disk, catalog } = setup();
    expect(catalog.save(join(disk.workspace, 'shared', 'whatever.json'), team(), 'create')).toContain('shared/whatever.json');
    const err = refusal(() => catalog.save(join(disk.root, 'elsewhere', 'x.json'), team(), 'create'));
    expect(err.message).toContain('outside the workspace');
    expect(existsSync(join(disk.root, 'elsewhere'))).toBe(false);
  });

  it('refuses toil\'s own files and anything under ~/.toil but the scheme folder, and a non-.json name', () => {
    const { disk, catalog } = setup();
    expect(refusal(() => catalog.save(join(disk.home, '.toil', 'config.json'), team(), 'replace')).message).toContain("one of toil's own files");
    expect(refusal(() => catalog.save(join(disk.home, '.toil', 'projects', 'team.json'), team(), 'create')).message).toContain("one of toil's own files");
    expect(refusal(() => catalog.save(join(disk.home, '.toil', 'audit', 'x.json'), team(), 'create')).message).toContain("one of toil's own files");
    expect(refusal(() => catalog.save(join(disk.workspace, 'x.txt'), team(), 'create')).message).toContain('ends in .json');
    expect(JSON.parse(readFileSync(join(disk.home, '.toil', 'config.json'), 'utf8'))).toEqual({});
  });

  it('writes beside a toil project only when the caller names that toil project\'s file', () => {
    const { disk, catalog } = setup({ 'home/.toil/projects/mine.json': { name: 'mine' }, 'home/.toil/projects/shared.json': scheme('shared') });
    const beside = join(disk.home, '.toil', 'projects', 'mine.json');
    const target = join(disk.home, '.toil', 'projects', 'shared.json');
    expect(refusal(() => catalog.save(target, { ...team(), name: 'shared' }, 'replace')).message).toContain("one of toil's own files");
    expect(catalog.save(target, { ...team(), name: 'shared' }, 'replace', beside)).toBe(forwardSlashes(target));
    // Still not toil's config, even with a toil project named.
    expect(refusal(() => catalog.save(join(disk.home, '.toil', 'config.json'), team(), 'replace', beside)).message).toContain("one of toil's own files");
  });

  it('refuses a scheme that would not read back, writing nothing', () => {
    const { disk, catalog } = setup();
    const bad = { ...team(), categories: [team().categories[0]!] };
    expect(() => catalog.save(join(disk.workspace, 'bad.json'), bad, 'create')).toThrow(ToilError);
    expect(existsSync(join(disk.workspace, 'bad.json'))).toBe(false);
  });

  it('is judged where the path really lands, through a link', () => {
    const { disk, catalog } = setup({ 'outside/keep.txt': '' });
    // A junction (or symlink) inside the workspace that leads out of it.
    try {
      symlinkSync(join(disk.root, 'outside'), join(disk.workspace, 'link'), 'junction');
    } catch {
      return; // no permission to link here: the realpath rule is covered by the toil project suite on the same code
    }
    expect(refusal(() => catalog.save(join(disk.workspace, 'link', 'x.json'), team(), 'create')).message).toContain('outside the workspace');
  });

  it('replaces the config nowhere even when the workspace is the home', () => {
    const { disk } = setup();
    const catalog = disk.schemes(config(), { workspace: disk.home });
    writeFileSync(join(disk.home, 'plain.json'), '{}');
    expect(refusal(() => catalog.save(join(disk.home, '.toil', 'config.json'), team(), 'replace')).message).toContain("one of toil's own files");
  });
});

