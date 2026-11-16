import { describe, expect, it } from 'vitest';
import { memoryFiles } from '../../test/harness/files.js';
import { readInventory } from './inventory.js';

const pkg = { name: 'left-pad', version: '1.3.0', ecosystem: 'npm', type: 'direct', scope: 'prod', source: 'package-lock.json' };

describe('the shared inventory reader', () => {
  it("reads deps scan's envelope, its data, or a bare list, from a file or stdin", async () => {
    const shapes = [{ ok: true, data: { packages: [pkg] } }, { packages: [pkg] }, [pkg]];
    for (const shape of shapes) {
      expect((await readInventory({ files: memoryFiles({ 'inv.json': JSON.stringify(shape) }) }, 'inv.json'))).toEqual([pkg]);
      expect((await readInventory({ files: memoryFiles({}, { stdin: JSON.stringify(shape) }) }, undefined))).toEqual([pkg]);
    }
  });

  it('refuses what is not an inventory, naming where it came from and the command to pipe into', async () => {
    const read = (text: string, pipeTo?: string) => () => readInventory({ files: memoryFiles({}, { stdin: text }) }, '-', pipeTo ? { pipeTo } : {});
    await expect(read('nope')()).rejects.toThrow(expect.objectContaining({ code: 'INVALID_INPUT', message: "The inventory from stdin isn't JSON.", fix: expect.stringContaining('toil deps scan | toil <command>') }));
    await expect(read('{}', 'toil osv vulns')()).rejects.toThrow(expect.objectContaining({ message: 'The inventory from stdin has no packages list.', fix: expect.stringContaining('toil deps scan | toil osv vulns') }));
    await expect(read('{"ok":false,"error":{"message":"No repo."}}')()).rejects.toThrow(expect.objectContaining({ message: 'The inventory from stdin is a failed result: No repo..' }));
    await expect(read('[{"name":"x","ecosystem":"npm"}]')()).rejects.toThrow(expect.objectContaining({ message: 'The inventory from stdin has a package without a usable version (packages[0]).' }));
  });

  it('says there is no stdin over MCP when from is left out', async () => {
    await expect(readInventory({ files: memoryFiles() }, undefined)).rejects.toThrow(expect.objectContaining({ code: 'INVALID_INPUT', message: expect.stringContaining('Over MCP there is no stdin') }));
  });

  it("keeps a source's own wording when it gives one", async () => {
    const words = { verb: 'evaluate', holds: 'a package list', missingFix: 'Write one.', fix: 'Pipe one in.', packageFix: 'Name it.' };
    await expect(readInventory({ files: memoryFiles() }, undefined, words)).rejects.toThrow(
      expect.objectContaining({ message: 'No inventory to evaluate: pass from, a package list. Over MCP there is no stdin to read it from.', fix: 'Write one.' }),
    );
    await expect(readInventory({ files: memoryFiles({}, { stdin: 'nope' }) }, '-', words)).rejects.toThrow(expect.objectContaining({ fix: 'Pipe one in.' }));
    await expect(readInventory({ files: memoryFiles({}, { stdin: '[{"name":"x"}]' }) }, '-', words)).rejects.toThrow(expect.objectContaining({ fix: 'Name it.' }));
  });
});
