import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { files as fixtureFiles, PIXEL_B64, PIXEL_PNG } from '../../../test/fixtures/util.fixture.js';
import { runCli } from '../../../test/harness/cli.js';
import { testContext } from '../../../test/harness/context.js';
import { memoryFiles } from '../../../test/harness/files.js';
import type { Envelope, Warning } from '../../core/envelope.js';
import { execute } from '../../core/run.js';
import { encodeCommand, ENCODINGS } from './encode.js';
import { CODECS, runEncode, type Codec, type EncodeInput, type Encoding } from './encode/run.js';
import { commands } from './index.js';
import { DEFAULT_MAX_BYTES } from './kit/input.js';

/**
 * `util encode` through execute(), the CLI, and runEncode with broken parts
 * swapped in to show each self-check catches what it's there for. The random
 * inputs come from a seeded generator, so a failure names a case that
 * reproduces. Randomness, like any other process, works better with a record.
 */

type Data = Record<string, unknown> & { verified: { passed: boolean; checks: Array<{ check: string; status: string; failed: number }> } };

/** mulberry32: small, seeded, and good enough to scatter bytes. */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randomBytes = (rand: () => number, length: number) => Uint8Array.from({ length }, () => Math.floor(rand() * 256));

async function run(input: Record<string, unknown>, files: Record<string, string | Uint8Array> = {}, stdin?: string) {
  const t = testContext({ files, ...(stdin === undefined ? {} : { stdin }) });
  const envelope = (await execute(encodeCommand, input, t.context)) as Envelope;
  return { envelope, data: envelope.data as Data, files: t.files };
}

const check = (data: Data, name: string) => data.verified.checks.find((c) => c.check === name);
const codes = (envelope: Envelope) => (envelope.meta.warnings ?? []).map((w) => w.code);

/** Encodes `bytes` from a file, then decodes the output to a file, and returns what came back. */
async function roundTrip(scheme: Encoding, bytes: Uint8Array) {
  const enc = await run({ scheme, file: 'in.bin' }, { 'in.bin': bytes });
  expect(enc.envelope.ok, `${scheme} encode`).toBe(true);
  expect(enc.data.verified.passed, `${scheme} encode verified`).toBe(true);
  const output = enc.data.output as string;
  const dec = await run({ scheme, decode: true, text: output, out: 'back.bin' });
  expect(dec.envelope.ok, `${scheme} decode`).toBe(true);
  expect(dec.data.verified.passed, `${scheme} decode verified`).toBe(true);
  return { output, back: dec.files.written['/work/back.bin']!, enc, dec };
}

describe('util encode: examples', () => {
  it.each(encodeCommand.examples.map((e, i) => [i, e] as const))('example %i succeeds and passes every check', async (_i, example) => {
    const { envelope, data } = await run(example, fixtureFiles);
    expect(envelope.ok).toBe(true);
    expect(data.verified.passed).toBe(true);
    expect(envelope.meta.warnings).toBeUndefined();
  });
});

describe('util encode: round trips', () => {
  const NON_UTF8 = [
    Uint8Array.of(0xff, 0xfe, 0xfd),
    Uint8Array.of(0x80),
    Uint8Array.of(0xc3),
    Uint8Array.of(0xed, 0xa0, 0x80),
    Uint8Array.of(0x00, 0x00, 0x0a, 0x0d),
    Uint8Array.from({ length: 256 }, (_, i) => i),
  ];

  it.each(ENCODINGS)('%s: empty input encodes to empty output and back', async (scheme) => {
    const { output, back } = await roundTrip(scheme, new Uint8Array(0));
    expect(output).toBe('');
    expect(back).toEqual(new Uint8Array(0));
  });

  it.each(ENCODINGS)('%s: non-UTF-8 bytes and every byte value come back exactly, with no INPUT_NOT_UTF8 warning', async (scheme) => {
    for (const bytes of NON_UTF8) {
      const { back, enc } = await roundTrip(scheme, bytes);
      expect(back).toEqual(bytes);
      expect(codes(enc.envelope)).not.toContain('INPUT_NOT_UTF8');
    }
  });

  it.each(ENCODINGS)('%s: 300 random inputs of 0 to 100 bytes round-trip', async (scheme) => {
    const rand = seeded(ENCODINGS.indexOf(scheme) + 1);
    for (let i = 0; i < 300; i++) {
      const bytes = randomBytes(rand, Math.floor(rand() * 101));
      const codec = CODECS[scheme];
      const output = codec.encode(bytes);
      expect(codec.decode(output), `case ${i}`).toEqual(bytes);
      expect(codec.normalize(output), `case ${i}`).toBe(output);
    }
    // And a handful through the whole command, file in and file out.
    for (let i = 0; i < 10; i++) {
      const bytes = randomBytes(rand, 1 + Math.floor(rand() * 64));
      expect((await roundTrip(scheme, bytes)).back).toEqual(bytes);
    }
  });

  it('writes what Node and the platform write', async () => {
    expect((await run({ scheme: 'base64', text: 'you@example.com:abc12345' })).data.output).toBe(Buffer.from('you@example.com:abc12345').toString('base64'));
    expect((await run({ scheme: 'base64url', text: '??>' })).data.output).toBe('Pz8-');
    expect((await run({ scheme: 'hex', text: 'Hi' })).data.output).toBe('4869');
    const jql = 'project = PAY AND assignee = "you@example.com" (é!*~)';
    expect((await run({ scheme: 'url', text: jql })).data.output).toBe(encodeURIComponent(jql));
    expect((await run({ scheme: 'form', text: jql })).data.output).toBe(new URLSearchParams({ q: jql }).toString().slice(2));
  });

  it('reports sizes, and counts the input as bytes, not characters', async () => {
    const { data } = await run({ scheme: 'hex', text: 'é' });
    expect(data).toMatchObject({ operation: 'encode', scheme: 'hex', inputBytes: 2, outputBytes: 4, output: 'c3a9' });
    expect(check(data, 'roundtrip.decode')).toMatchObject({ status: 'passed', checked: 1 });
    expect(check(data, 'input.complete')).toMatchObject({ status: 'passed' });
  });
});

describe('util encode: decoding padding, case and whitespace variants', () => {
  it.each([
    ['base64', 'QQ==', 'A'],
    ['base64', 'QQ', 'A'],
    ['base64', 'QUI=', 'AB'],
    ['base64', 'QUI', 'AB'],
    ['base64', 'QUJD', 'ABC'],
    ['base64', ' QU\r\nJD \n', 'ABC'],
    ['base64url', 'Pz8-', '??>'],
    ['base64url', 'QQ', 'A'],
    ['base64url', 'QQ==', 'A'],
    ['hex', 'C3A9', 'é'],
    ['hex', 'c3 a9\n', 'é'],
    ['url', 'a%2fb%2Fc', 'a/b/c'],
    ['url', 'caf%C3%A9', 'café'],
    ['form', 'a+b%20c', 'a b c'],
    ['form', 'x%3d1%26y', 'x=1&y'],
  ])('%s %j decodes to %j and re-encodes to the same, after normalization', async (scheme, text, expected) => {
    const { envelope, data } = await run({ scheme, decode: true, text });
    expect(envelope.ok).toBe(true);
    expect(data).toMatchObject({ operation: 'decode', scheme, output: expected, utf8: true, outputBytes: Buffer.byteLength(expected) });
    expect(check(data, 'roundtrip.encode')).toMatchObject({ status: 'passed' });
    expect(data.verified.passed).toBe(true);
  });

  it('reads MIME-wrapped base64 from a file, CRLF and all', async () => {
    expect(PIXEL_B64.split('\r\n')).toHaveLength(3);
    const { data, files } = await run({ scheme: 'base64', decode: true, file: 'pixel.b64', out: 'pixel.png' }, { 'pixel.b64': PIXEL_B64 });
    expect(files.written['/work/pixel.png']).toEqual(PIXEL_PNG);
    expect(data).toMatchObject({ operation: 'decode', utf8: false, outputBytes: PIXEL_PNG.length, inputBytes: PIXEL_B64.length, file: '/work/pixel.png' });
    expect(data.verified.passed).toBe(true);
    expect(data.verified.checks.map((c) => c.check)).toEqual(['input.complete', 'roundtrip.encode', 'output.file']);
  });

  it('drops one trailing line ending from stdin, as echo adds it', async () => {
    const run_ = await runCli(['util', 'encode', 'base64', '--decode'], { commands, context: testContext({ stdin: 'aGVsbG8=\n' }).context });
    expect(run_.envelope?.data).toMatchObject({ output: 'hello' });
    const url = await runCli(['util', 'encode', 'url', '--decode', '-'], { commands, context: testContext({ stdin: 'a%20b\r\n' }).context });
    expect(url.envelope?.data).toMatchObject({ output: 'a b' });
    expect((url.envelope?.data as Data).verified.passed).toBe(true);
    // stdin has no size to check the read against, and says so.
    expect(check(url.envelope?.data as Data, 'input.complete')).toMatchObject({ status: 'unchecked' });
    expect(url.envelope?.meta.warnings).toContainEqual(expect.objectContaining({ code: 'UNVERIFIED' }));
  });
});

describe('util encode: invalid input', () => {
  it.each([
    ['base64', 'QQ*=', 'offset 2', ''],
    ['base64', 'Pz8-', 'offset 3', 'base64url'],
    ['base64url', 'Pz8+', 'offset 3', 'base64'],
    ['base64', 'QUJDR', '5 characters', 'cut short'],
    ['base64', 'QQ=x', 'padding', ''],
    ['base64', 'QQ===', 'padding', ''],
    ['base64', 'QUI==', 'multiple of 4', ''],
    ['hex', 'abc', 'odd number', 'cut short'],
    ['hex', '0xab', 'offset 1', '0x'],
    ['hex', 'ab:cd', 'offset 2', 'separators'],
    ['url', '100%', 'offset 3', '%25'],
    ['form', 'a=%zz', 'offset 2', '%25'],
  ])('%s %j is INVALID_INPUT naming %s, with a fix, and never repeats the input', async (scheme, text, where, fix) => {
    const { envelope } = await run({ scheme, decode: true, text });
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining(where) });
    expect(envelope.error?.message).toContain(`isn't ${scheme}`);
    expect(envelope.error?.fix).toContain(fix);
    expect(JSON.stringify(envelope.error)).not.toContain(JSON.stringify(text).slice(1, -1));
  });

  it('refuses an unknown scheme, a hash with --decode or --out, and a binary file to decode', async () => {
    const unknown = await runCli(['util', 'encode', 'rot13', '--text', 'x'], { commands, context: testContext().context });
    expect(unknown.envelope?.error?.code).toBe('INVALID_INPUT');
    expect(unknown.exitCode).toBe(1);
    expect((await run({ scheme: 'sha256', decode: true, text: 'x' })).envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: "sha256 is a hash, which can't be decoded." });
    expect((await run({ scheme: 'md5', text: 'x', out: 'x.txt' })).envelope.error).toMatchObject({ code: 'INVALID_INPUT' });
    const binary = await run({ scheme: 'base64', decode: true, file: 'pixel.png' }, { 'pixel.png': PIXEL_PNG });
    expect(binary.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('looks binary') });
  });
});

describe('util encode: binary output never comes back as JSON text', () => {
  it('refuses decoded bytes that are not UTF-8 without --out, and returns no output at all', async () => {
    const { envelope } = await run({ scheme: 'base64', decode: true, file: 'pixel.b64' }, { 'pixel.b64': PIXEL_B64 });
    expect(envelope.ok).toBe(false);
    expect(envelope.data).toBeNull();
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: `The input decodes to ${PIXEL_PNG.length} bytes that aren't valid UTF-8 text, so they can't be returned as JSON without changing them.` });
    expect(envelope.error?.fix).toContain('--out <file>');
  });

  it('for 2,000 random byte strings in every encoding, any output it returns is exactly the bytes, through JSON and back', async () => {
    const rand = seeded(42);
    let refused = 0;
    let returned = 0;
    for (let i = 0; i < 2000; i++) {
      const scheme = ENCODINGS[i % ENCODINGS.length]!;
      // Mostly short strings of high bytes, so plenty are valid UTF-8 by chance and plenty aren't.
      const bytes = randomBytes(rand, Math.floor(rand() * 6));
      if (rand() < 0.5) for (let j = 0; j < bytes.length; j++) bytes[j] = bytes[j]! & 0x7f;
      const { envelope } = await run({ scheme, decode: true, text: CODECS[scheme].encode(bytes) });
      const wire = JSON.parse(JSON.stringify(envelope)) as Envelope;
      if (wire.ok) {
        returned++;
        const output = (wire.data as Data).output as string;
        expect(new Uint8Array(Buffer.from(output, 'utf8')), `case ${i}`).toEqual(bytes);
        expect((wire.data as Data).utf8).toBe(true);
      } else {
        refused++;
        expect(wire.error?.code, `case ${i}`).toBe('INVALID_INPUT');
        expect(wire.data).toBeNull();
        expect(isUtf8(bytes), `case ${i} refused valid UTF-8`).toBe(false);
      }
    }
    // Both sides of the property were exercised.
    expect(refused).toBeGreaterThan(100);
    expect(returned).toBeGreaterThan(100);
  });
});

describe('util encode: the self-checks catch a broken input or result', () => {
  const ctx = (files: Record<string, string | Uint8Array> = {}) => {
    const warnings: Warning[] = [];
    return { warnings, ctx: { files: memoryFiles(files), warn: (w: Warning) => warnings.push(w) } };
  };
  const call = async (input: EncodeInput, codecs?: Record<Encoding, Codec>, files?: Record<string, string | Uint8Array>) => {
    const c = ctx(files);
    const result = await runEncode(input, c.ctx, codecs);
    return { result: result as unknown as Data, warnings: c.warnings, ctx: c.ctx };
  };

  it('base64 with set padding bits decodes, but fails the re-encode check', async () => {
    // QR== and QQ== both decode to "A"; only QQ== is how base64 writes it.
    const { result, warnings } = await call({ scheme: 'base64', decode: true, text: 'QR==' });
    expect(result.output).toBe('A');
    expect(result.verified.passed).toBe(false);
    expect(check(result, 'roundtrip.encode')).toMatchObject({ status: 'failed', failed: 1 });
    expect(warnings).toContainEqual(expect.objectContaining({ code: 'ENCODE_ROUNDTRIP_MISMATCH', message: expect.stringContaining('character 1') }));
  });

  it('URL text with a character left unescaped fails the re-encode check', async () => {
    const { result, warnings } = await call({ scheme: 'url', decode: true, text: 'a b' });
    expect(result.verified.passed).toBe(false);
    expect(warnings.map((w) => w.code)).toContain('ENCODE_ROUNDTRIP_MISMATCH');
  });

  it('an encoder that drops a byte fails the decode-back check, and the warning holds no content', async () => {
    const broken = { ...CODECS, base64: { ...CODECS.base64, encode: (b: Uint8Array) => CODECS.base64.encode(b.subarray(0, -1)) } };
    const { result, warnings } = await call({ scheme: 'base64', text: 'you@example.com:abc12345' }, broken);
    expect(result.verified.passed).toBe(false);
    expect(check(result, 'roundtrip.decode')).toMatchObject({ status: 'failed' });
    const warning = warnings.find((w) => w.code === 'ENCODE_ROUNDTRIP_MISMATCH')!;
    expect(warning.message).toContain('byte 23 (24 bytes in, 23 back)');
    expect(JSON.stringify([result, warnings])).not.toContain('abc12345');
  });

  it('an encoder whose output does not decode fails the decode-back check', async () => {
    const broken = { ...CODECS, hex: { ...CODECS.hex, encode: (b: Uint8Array) => `${CODECS.hex.encode(b)}0` } };
    const { result, warnings } = await call({ scheme: 'hex', text: 'x' }, broken);
    expect(check(result, 'roundtrip.decode')).toMatchObject({ status: 'failed' });
    expect(warnings).toContainEqual(expect.objectContaining({ code: 'ENCODE_ROUNDTRIP_MISMATCH', message: expect.stringContaining("didn't decode back") }));
  });

  it('a decoder that alters a byte fails the re-encode check', async () => {
    const broken = { ...CODECS, form: { ...CODECS.form, decode: (t: string) => CODECS.url.decode(t) } };
    const { result } = await call({ scheme: 'form', decode: true, text: 'a+b' }, broken);
    expect(check(result, 'roundtrip.encode')).toMatchObject({ status: 'failed' });
  });

  it('a file that does not hold what was written fails the output check', async () => {
    const c = ctx();
    c.ctx.files.readBytes = async () => PIXEL_PNG.subarray(0, 10);
    const result = (await runEncode({ scheme: 'base64', decode: true, text: PIXEL_B64, out: 'p.png' }, c.ctx)) as unknown as Data;
    expect(check(result, 'output.file')).toMatchObject({ status: 'failed' });
    expect(c.warnings).toContainEqual(expect.objectContaining({ code: 'ENCODE_OUTPUT_MISMATCH', message: expect.stringContaining('/work/p.png') }));
  });
});

describe('util encode: hashes', () => {
  it.each([
    ['sha256', '', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['sha256', 'abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['sha1', 'abc', 'a9993e364706816aba3e25717850c26c9cd0d89d'],
    ['md5', '', 'd41d8cd98f00b204e9800998ecf8427e'],
    ['md5', 'abc', '900150983cd24fb0d6963f7d28e17f72'],
  ])('%s of %j is the published digest, in hex and base64', async (scheme, text, hex) => {
    const { data } = await run({ scheme, file: 'in.txt' }, { 'in.txt': text });
    expect(data).toMatchObject({ operation: 'hash', scheme, inputBytes: text.length, hex, base64: Buffer.from(hex, 'hex').toString('base64') });
    expect(check(data, 'input.complete')).toMatchObject({ status: 'passed', checked: 1 });
    expect(data.verified.passed).toBe(true);
  });

  it('hashes binary and non-UTF-8 files byte for byte, with no warning', async () => {
    const { envelope, data } = await run({ scheme: 'sha256', file: 'pixel.png' }, { 'pixel.png': PIXEL_PNG });
    expect(data.hex).toBe(createHash('sha256').update(PIXEL_PNG).digest('hex'));
    expect(envelope.meta.warnings).toBeUndefined();
  });

  it('a truncated read fails the byte-count check, so the digest cannot pass', async () => {
    const files = memoryFiles({ 'big.bin': new Uint8Array(200_000).fill(7) });
    const stream = files.readStream.bind(files);
    // The file says 200,000 bytes; the stream stops after the first chunk, as a file cut short mid-read would.
    files.readStream = (path, o) =>
      (async function* () {
        for await (const chunk of stream(path, { ...o, chunkSize: 65536 })) {
          yield chunk;
          return;
        }
      })();
    const warnings: Warning[] = [];
    const result = (await runEncode({ scheme: 'sha256', file: 'big.bin' }, { files, warn: (w) => warnings.push(w) })) as unknown as Data;
    expect(result.inputBytes).toBe(65536);
    expect(result.verified.passed).toBe(false);
    expect(check(result, 'input.complete')).toMatchObject({ status: 'failed', failed: 1 });
    expect(warnings).toContainEqual({ code: 'INPUT_INCOMPLETE', message: 'The input is 200000 bytes on disk, but 65536 were read.' });
  });

  it('hashes a file past the 64 MiB cap the other operations keep, since it streams', async () => {
    const big = new Uint8Array(DEFAULT_MAX_BYTES + 1);
    const { data } = await run({ scheme: 'sha1', file: 'big.bin' }, { 'big.bin': big });
    expect(data).toMatchObject({ inputBytes: DEFAULT_MAX_BYTES + 1, hex: createHash('sha1').update(big).digest('hex') });
    expect(data.verified.passed).toBe(true);
    expect((await run({ scheme: 'hex', file: 'big.bin' }, { 'big.bin': big })).envelope.error?.code).toBe('INVALID_INPUT');
  });

  it('says a hash of stdin could not be checked against a size', async () => {
    const cli = await runCli(['util', 'encode', 'sha256'], { commands, context: testContext({ stdin: 'abc' }).context });
    expect(cli.envelope?.data).toMatchObject({ hex: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' });
    expect(check(cli.envelope?.data as Data, 'input.complete')).toMatchObject({ status: 'unchecked' });
  });
});

describe('util encode: --out', () => {
  it('writes encoded text to a new file, reads it back, and leaves output out', async () => {
    const { data, files } = await run({ scheme: 'hex', file: 'pixel.png', out: 'out/pixel.hex' }, { 'pixel.png': PIXEL_PNG });
    expect(new TextDecoder().decode(files.written['/work/out/pixel.hex'])).toBe(Buffer.from(PIXEL_PNG).toString('hex'));
    expect(data).toMatchObject({ operation: 'encode', file: '/work/out/pixel.hex', outputBytes: PIXEL_PNG.length * 2 });
    expect(data).not.toHaveProperty('output');
    expect(check(data, 'output.file')).toMatchObject({ status: 'passed' });
  });

  it('never overwrites a file, and returns the path it wrote', async () => {
    const taken = await run({ scheme: 'base64', decode: true, text: 'QQ==', out: 'a.txt' }, { 'a.txt': 'keep me' });
    expect(taken.envelope.error?.code).toBe('INVALID_INPUT');
    expect(taken.files.written).toEqual({});
    const cli = await runCli(['util', 'encode', 'base64', '--decode', '--text', 'QQ==', '--out', 'b.txt'], { commands, context: testContext().context });
    expect(cli.envelope?.data).toMatchObject({ file: '/work/b.txt', utf8: true, outputBytes: 1 });
  });

  it('keeps only a hash of --text in the audit log', async () => {
    const t = testContext();
    await execute(encodeCommand, { scheme: 'base64', text: 'you@example.com:abc12345' }, t.context);
    expect(t.audit.lines.join('\n')).not.toContain('abc12345');
  });
});
