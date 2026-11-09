import { describe, expect, it } from 'vitest';
import { nodeBanner, nodeRefused, nodeWarning } from './runtime.js';

describe('the Node floor (CVE-2026-111497, #479)', () => {
  it('refuses every 24.x before 24.22.1 and accepts it and later, with or without a v', () => {
    expect(nodeRefused('v24.14.0')).toBe(true);
    expect(nodeRefused('24.22.0')).toBe(true);
    expect(nodeRefused('24.22.1')).toBe(false);
    expect(nodeRefused('v24.22.2')).toBe(false);
    expect(nodeRefused('24.100.0')).toBe(false);
  });

  it('refuses every 25.x, which gets no fix', () => {
    expect(nodeRefused('25.0.0')).toBe(true);
    expect(nodeRefused('25.99.99')).toBe(true);
  });

  it('refuses 26.x before 26.12.1 and accepts it and later', () => {
    expect(nodeRefused('26.0.0')).toBe(true);
    expect(nodeRefused('26.12.0')).toBe(true);
    expect(nodeRefused('26.12.1')).toBe(false);
    expect(nodeRefused('26.13.0')).toBe(false);
  });

  it('refuses any line older than 24, even one with its own fix, and allows a line newer than 26', () => {
    expect(nodeRefused('22.23.4')).toBe(true);
    expect(nodeRefused('20.0.0')).toBe(true);
    expect(nodeRefused('27.0.0')).toBe(false);
    expect(nodeRefused('28.1.0')).toBe(false);
  });

  it('an unpatched Node gets a loud warning naming the CVE and the releases to install, and a patched one gets nothing', () => {
    const warning = nodeWarning('v24.22.0');
    expect(warning).toContain('WARNING');
    expect(warning).toContain('CVE-2026-111497');
    expect(warning).toContain('24.22.0');
    expect(warning).toContain('Install Node 24.22.1 or later on 24.x, or 26.12.1 or later');
    expect(nodeWarning('25.1.0')).toContain('25.1.0');
    expect(nodeWarning('24.22.1')).toBeUndefined();
    expect(nodeWarning('26.12.1')).toBeUndefined();
    expect(nodeBanner('24.22.0')).toMatch(/^!{78}\nWARNING/);
    expect(nodeBanner('26.12.1')).toBeUndefined();
  });
});
