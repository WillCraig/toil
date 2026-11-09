import { describe, expect, it } from 'vitest';
import { checkRegistry, npmrcPath, RegistryError, setRegistry } from '../server/agents/npmrc.ts';

describe("pointing npm at the organization's registry", () => {
  it('accepts an https address and adds the slash npm wants', () => {
    expect(checkRegistry(' https://artifactory.example.com/artifactory/api/npm/npm-virtual ')).toBe('https://artifactory.example.com/artifactory/api/npm/npm-virtual/');
  });
  it('refuses a credential, a query, a fragment and anything that is not a web address', () => {
    for (const bad of ['', 'not a url', 'ftp://x.example.com/', 'https://me:secret@x.example.com/', 'https://x.example.com/?token=abc', 'https://x.example.com/#frag']) expect(() => checkRegistry(bad)).toThrow(RegistryError);
  });
  it('replaces a registry line, keeps every other line (credentials included) and the file\'s line endings', () => {
    let written = '';
    const r = setRegistry('/home/me/.npmrc', 'https://a.example.com/npm', () => 'save-exact=true\r\nregistry=https://old.example.com/\r\n//a.example.com/:_authToken=keep\r\n', (_p, t) => (written = t));
    expect(written).toBe('save-exact=true\r\nregistry=https://a.example.com/npm/\r\n//a.example.com/:_authToken=keep\r\n');
    expect(r).toEqual({ file: '/home/me/.npmrc', registry: 'https://a.example.com/npm/', previous: 'https://old.example.com/' });
  });
  it('adds the line to a file without one, or creates the file', () => {
    let written = '';
    expect(setRegistry('/x/.npmrc', 'https://a.example.com/', () => 'a=b', (_p, t) => (written = t)).previous).toBeNull();
    expect(written).toBe('a=b\nregistry=https://a.example.com/\n');
    setRegistry('/x/.npmrc', 'https://a.example.com/', () => null, (_p, t) => (written = t));
    expect(written).toBe('registry=https://a.example.com/\n');
  });
  it("uses npm's own userconfig when set", () => {
    expect(npmrcPath({ npm_config_userconfig: '/etc/me.npmrc' }, '/home/me')).toBe('/etc/me.npmrc');
    expect(npmrcPath({}, '/home/me')).toMatch(/\.npmrc$/);
  });
});
