import { isUtf8 } from 'node:buffer';
import { createHash, type Hash } from 'node:crypto';
import { ToilError } from '../../../core/errors.js';
import { openInput, type InputContext } from '../kit/input.js';
import { Verifier, type Verified } from '../kit/verify.js';
import type { ENCODINGS, HASHES, SCHEMES } from '../encode.js';

/**
 * The work behind `util encode`. Each encoding is a
 * {@link Codec}: an encoder, a strict decoder, and the input as the encoder
 * would have written it, which is what a re-encode is held to. Node's Buffer
 * does base64 and hex; percent-encoding is done here over bytes, so input that
 * isn't UTF-8 encodes too. The decoders refuse what isn't the encoding rather
 * than skip it, as Buffer would. Silently ignoring a character is how a form
 * gets processed without anyone having read it.
 */

export type Encoding = (typeof ENCODINGS)[number];
export type HashScheme = (typeof HASHES)[number];
export type Scheme = (typeof SCHEMES)[number];

export interface Codec {
  encode(bytes: Uint8Array): string;
  /** The bytes `text` encodes; INVALID_INPUT when it isn't this encoding. */
  decode(text: string): Uint8Array;
  /** `text` as {@link encode} writes it: whitespace, padding and case as the encoder has them. Only called on text that decodes. */
  normalize(text: string): string;
}

const WHITESPACE = /[\t\n\f\r ]/g;
const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

const invalid = (scheme: Encoding, problem: string, fix: string) => new ToilError('INVALID_INPUT', `The input isn't ${scheme}: ${problem}.`, { fix });

/** The offset in `text` of the first character outside `alphabet` (whitespace aside), or -1. Messages name the offset, never the character: the content may be a secret. */
function strayAt(text: string, alphabet: RegExp): number {
  for (let i = 0; i < text.length; i++) if (!isSpace(text[i]!) && !alphabet.test(text[i]!)) return i;
  return -1;
}

function base64Codec(url: boolean): Codec {
  const scheme: Encoding = url ? 'base64url' : 'base64';
  const other = url ? 'base64' : 'base64url';
  const shape = url ? /^[A-Za-z0-9_-]*={0,2}$/ : /^[A-Za-z0-9+/]*={0,2}$/;
  const letter = url ? /[A-Za-z0-9_\-=]/ : /[A-Za-z0-9+/=]/;
  const foreign = url ? /[+/]/ : /[-_]/;
  const FIX = `Pass ${scheme} text: the letters, digits and ${url ? '- _' : '+ /'}, with = padding only at the end. Line breaks and spaces are ignored.`;
  /** The data characters, with whitespace and padding checked and removed. */
  const body = (text: string): string => {
    const s = text.replace(WHITESPACE, '');
    if (!shape.test(s)) {
      const at = strayAt(text, letter);
      if (at !== -1) {
        const hint = foreign.test(text[at]!) ? ` It looks like ${other}; pass that scheme instead.` : '';
        throw invalid(scheme, `the character at offset ${at} isn't in its alphabet`, `${FIX}${hint}`);
      }
      throw invalid(scheme, '= padding appears before the end, or more than two = signs', FIX);
    }
    const data = s.replace(/=+$/, '');
    const padding = s.length - data.length;
    if (data.length % 4 === 1) throw invalid(scheme, `${data.length} characters can't be whole bytes (one character too many or too few)`, `${FIX} The text may have been cut short.`);
    if (padding > 0 && (data.length + padding) % 4 !== 0) throw invalid(scheme, `the = padding doesn't make the length a multiple of 4`, FIX);
    return data;
  };
  return {
    encode: (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(scheme),
    decode: (text) => new Uint8Array(Buffer.from(body(text), scheme)),
    // base64 is written padded, base64url (as JWTs and Node write it) not.
    normalize: (text) => {
      const data = body(text);
      return url ? data : data + '='.repeat((4 - (data.length % 4)) % 4);
    },
  };
}

const hexCodec: Codec = {
  encode: (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex'),
  decode: (text) => {
    const s = text.replace(WHITESPACE, '');
    const FIX = 'Pass hex digits, two per byte (0-9, a-f, either case). Spaces and line breaks are ignored; prefixes such as 0x and separators such as : are not.';
    if (!/^[0-9a-fA-F]*$/.test(s)) throw invalid('hex', `the character at offset ${strayAt(text, /[0-9a-fA-F]/)} isn't a hex digit`, FIX);
    if (s.length % 2 === 1) throw invalid('hex', `${s.length} digits is an odd number, and each byte takes two`, `${FIX} The text may have been cut short.`);
    return new Uint8Array(Buffer.from(s, 'hex'));
  },
  normalize: (text) => text.replace(WHITESPACE, '').toLowerCase(),
};

const HEX = '0123456789ABCDEF';

/** Each byte as percent-encoding writes it: itself when `safe` says so, else %XX. */
function byteTable(safe: string, form: boolean): string[] {
  const table: string[] = [];
  for (let b = 0; b < 256; b++) table.push(safe.includes(String.fromCharCode(b)) ? String.fromCharCode(b) : `%${HEX[b >> 4]}${HEX[b & 15]}`);
  if (form) table[0x20] = '+';
  return table;
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const hexValue = (b: number | undefined) => (b === undefined ? -1 : b >= 0x30 && b <= 0x39 ? b - 0x30 : b >= 0x41 && b <= 0x46 ? b - 0x37 : b >= 0x61 && b <= 0x66 ? b - 0x57 : -1);

/**
 * `url`: a URL component, with encodeURIComponent's unreserved set (letters,
 * digits and `-_.!~*'()`), so what JavaScript writes reads back unchanged.
 * `form`: application/x-www-form-urlencoded as the WHATWG URL standard
 * writes it, letters, digits and `*-._` kept and a space as `+`.
 */
function percentCodec(form: boolean): Codec {
  const scheme: Encoding = form ? 'form' : 'url';
  const table = byteTable(ALNUM + (form ? '*-._' : "-_.!~*'()"), form);
  return {
    encode: (bytes) => {
      // Joined a slice at a time: one string per byte of a 64 MiB file is a lot of strings.
      const parts: string[] = [];
      for (let start = 0; start < bytes.length; start += 65536) {
        let piece = '';
        const end = Math.min(bytes.length, start + 65536);
        for (let i = start; i < end; i++) piece += table[bytes[i]!];
        parts.push(piece);
      }
      return parts.join('');
    },
    decode: (text) => {
      const bad = /%(?![0-9A-Fa-f]{2})/.exec(text);
      if (bad) {
        throw invalid(scheme, `the % at offset ${bad.index} isn't followed by two hex digits`, 'Write a literal % as %25. Each % starts an escape of exactly two hex digits.');
      }
      // Characters outside an escape stand for their own UTF-8 bytes.
      const src = Buffer.from(text, 'utf8');
      const out = new Uint8Array(src.length);
      let n = 0;
      for (let i = 0; i < src.length; i++) {
        const b = src[i]!;
        if (b === 0x25) {
          out[n++] = hexValue(src[i + 1]) * 16 + hexValue(src[i + 2]);
          i += 2;
        } else out[n++] = form && b === 0x2b ? 0x20 : b;
      }
      return out.subarray(0, n);
    },
    // Escapes in upper case, as encoders write them; a form's %20 is the + it would have written.
    normalize: (text) => {
      const upper = text.replace(/%[0-9A-Fa-f]{2}/g, (e) => e.toUpperCase());
      return form ? upper.replace(/%20/g, '+') : upper;
    },
  };
}

export const CODECS: Record<Encoding, Codec> = {
  base64: base64Codec(false),
  base64url: base64Codec(true),
  hex: hexCodec,
  url: percentCodec(false),
  form: percentCodec(true),
};

const isHash = (scheme: Scheme): scheme is HashScheme => scheme === 'sha256' || scheme === 'sha1' || scheme === 'md5';

/** Where two byte sequences first differ, or -1 when they're equal. */
export function firstByteDifference(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

function firstCharDifference(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

const ROUNDTRIP = 'ENCODE_ROUNDTRIP_MISMATCH';

/**
 * That decoding `output` gives `bytes` back. Only sizes and an offset go into
 * the report, never the content, which may be a credential.
 */
export function checkEncode(v: Verifier, codec: Codec, scheme: Encoding, bytes: Uint8Array, output: string): void {
  let back: Uint8Array;
  try {
    back = codec.decode(output);
  } catch (err) {
    v.fail('roundtrip.decode', { expected: `${bytes.length} bytes`, actual: `no bytes: ${(err as Error).message}` }, { code: ROUNDTRIP, message: `The ${scheme} output didn't decode back: ${(err as Error).message}` });
    return;
  }
  const at = firstByteDifference(bytes, back);
  v.expect(
    'roundtrip.decode',
    at === -1,
    { at: `byte ${at}`, expected: `${bytes.length} bytes`, actual: `${back.length} bytes` },
    { code: ROUNDTRIP, message: `Decoding the ${scheme} output didn't give the input back: they first differ at byte ${at} (${bytes.length} bytes in, ${back.length} back).` },
  );
}

/** That re-encoding `bytes` gives `text` back, allowing for whitespace, padding and case. */
export function checkDecode(v: Verifier, codec: Codec, scheme: Encoding, text: string, bytes: Uint8Array): void {
  const expected = codec.normalize(text);
  const actual = codec.encode(bytes);
  const at = firstCharDifference(expected, actual);
  v.expect(
    'roundtrip.encode',
    at === -1,
    { at: `character ${at} of the normalized input`, expected: `${expected.length} characters`, actual: `${actual.length} characters` },
    {
      code: ROUNDTRIP,
      message: `Re-encoding the decoded bytes as ${scheme} doesn't give the input back, even allowing for whitespace, padding and case: they first differ at character ${at}. The input decodes, but it isn't how ${scheme} writes these bytes (set padding bits, or characters left unescaped), so check it wasn't altered on the way.`,
    },
  );
}

/** A digest of `scheme`. A Node built without the algorithm (MD5 under FIPS) is a plain error, not a stack trace. */
function hashFor(scheme: HashScheme): Hash {
  try {
    return createHash(scheme);
  } catch (err) {
    throw new ToilError('INVALID_INPUT', `This Node runtime doesn't offer ${scheme}: ${(err as Error).message}.`, {
      fix: scheme === 'sha256' ? 'Check the Node installation.' : 'Use sha256. A runtime in FIPS mode leaves out md5 and may leave out sha1.',
    });
  }
}

export interface EncodeInput {
  scheme: Scheme;
  inputFile?: string | undefined;
  text?: string | undefined;
  decode?: boolean | undefined;
  out?: string | undefined;
}

export type EncodeResult =
  | { operation: 'encode'; scheme: Encoding; inputBytes: number; outputBytes: number; output?: string; file?: string; verified: Verified }
  | { operation: 'decode'; scheme: Encoding; inputBytes: number; outputBytes: number; utf8: boolean; output?: string; file?: string; verified: Verified }
  | { operation: 'hash'; scheme: HashScheme; inputBytes: number; hex: string; base64: string; verified: Verified };

/** Writes `data` to `out` (a new file in the workspace) and reads it back to check every byte landed. */
async function writeChecked(ctx: InputContext, v: Verifier, out: string, data: Uint8Array): Promise<string> {
  const file = ctx.files.writeBytes(out, data);
  const back = await ctx.files.readBytes(file);
  const at = firstByteDifference(data, back);
  v.expect('output.file', at === -1, { at: file, expected: `${data.length} bytes`, actual: `${back.length} bytes` }, { code: 'ENCODE_OUTPUT_MISMATCH', message: `The file written, ${file}, doesn't hold what was written: they first differ at byte ${at}.` });
  return file;
}

export async function runEncode(input: EncodeInput, ctx: InputContext, codecs: Record<Encoding, Codec> = CODECS): Promise<EncodeResult> {
  const v = new Verifier(ctx.warn);
  const { scheme } = input;

  if (isHash(scheme)) {
    if (input.decode) throw new ToilError('INVALID_INPUT', `${scheme} is a hash, which can't be decoded.`, { fix: 'Drop --decode to hash the input.' });
    if (input.out !== undefined) throw new ToilError('INVALID_INPUT', `A ${scheme} digest is returned in the output, not written to a file.`, { fix: 'Drop --out.' });
    const hash = hashFor(scheme);
    // A file streams in constant memory, so it has no size cap; stdin is held in memory, so it keeps the reader's.
    const fromFile = input.inputFile !== undefined && input.inputFile !== '-';
    const src = await openInput(ctx, input, { binary: 'allow', utf8: 'skip', ...(fromFile ? { maxBytes: Number.POSITIVE_INFINITY } : {}) });
    for await (const chunk of src.chunks()) hash.update(chunk);
    // The digest is only of what was read: a read that stopped short fails here, whatever the digest says.
    v.inputComplete(src);
    const digest = hash.digest();
    return { operation: 'hash', scheme, inputBytes: src.bytesRead, hex: digest.toString('hex'), base64: digest.toString('base64'), verified: v.done() };
  }

  const codec = codecs[scheme];
  if (!input.decode) {
    const src = await openInput(ctx, input, { binary: 'allow', utf8: 'skip' });
    const bytes = await src.bytes();
    v.inputComplete(src);
    const output = codec.encode(bytes);
    checkEncode(v, codec, scheme, bytes, output);
    const base = { operation: 'encode' as const, scheme, inputBytes: bytes.length, outputBytes: output.length };
    if (input.out !== undefined) {
      const file = await writeChecked(ctx, v, input.out, new TextEncoder().encode(output));
      return { ...base, file, verified: v.done() };
    }
    return { ...base, output, verified: v.done() };
  }

  const src = await openInput(ctx, input);
  // One trailing line ending, which echo and most editors add, isn't part of the encoded text.
  const text = (await src.text()).replace(/\r?\n$/, '');
  v.inputComplete(src);
  const bytes = codec.decode(text);
  checkDecode(v, codec, scheme, text, bytes);
  const utf8 = isUtf8(bytes);
  const base = { operation: 'decode' as const, scheme, inputBytes: src.bytesRead, outputBytes: bytes.length, utf8 };
  if (input.out !== undefined) {
    const file = await writeChecked(ctx, v, input.out, bytes);
    return { ...base, file, verified: v.done() };
  }
  if (!utf8) {
    // JSON carries text, and these bytes aren't text: any string here would be a different file.
    throw new ToilError('INVALID_INPUT', `The input decodes to ${bytes.length} bytes that aren't valid UTF-8 text, so they can't be returned as JSON without changing them.`, {
      fix: 'Pass --out <file>, a new file inside the workspace, to write the bytes there.',
    });
  }
  return { ...base, output: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8'), verified: v.done() };
}
