import { isUtf8 } from 'node:buffer';
import { z } from 'zod';
import { defineCommand } from '../../core/command.js';
import { ToilError } from '../../core/errors.js';

/**
 * `util jwt decode`: a JWT's header and claims, read without verifying the
 * signature. No key, no network, no connection. The token is a credential,
 * so it goes nowhere but the decoder: it isn't logged, and no error message
 * repeats it. `-` reads it from stdin, which keeps it out of the process list
 * and the shell history; the contract's `jwt decode` path stays as an alias.
 *
 * The header and payload have to be base64url, UTF-8, and a JSON object
 * (#75 items 1 to 3, checked on crafted tokens). The signature is the third
 * segment as given, and a "Bearer " prefix is not stripped (#75 item 4,
 * checked and kept). Verifying the signature would need the key, and a key
 * would need a form, so the form was not issued.
 */

export interface DecodedJwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signature: string;
}

const FIX = 'Pass the whole token, header.payload.signature, without a "Bearer " prefix. An encrypted (5-part) JWE cannot be decoded without its key.';
const BASE64URL_FIX = `A header or payload segment is base64url: letters, digits, - and _, with = only as padding at the end. ${FIX}`;
const UTF8_FIX = `The header and payload have to be UTF-8 JSON. ${FIX}`;
const OBJECT_FIX = `A JOSE header and a claims set are each a JSON object. ${FIX}`;

/** Letters, digits, "-" and "_", then at most two "=". Whitespace is not skipped: a JWT segment has none. */
const BASE64URL = /^[A-Za-z0-9_-]*={0,2}$/;

type Segment = 'header' | 'payload';

function invalid(name: Segment, problem: string, fix = FIX): never {
  throw new ToilError('INVALID_INPUT', `Invalid JWT: ${name} ${problem}`, { fix });
}

/**
 * The bytes of one segment. Node's base64 decoder skips characters it doesn't
 * know and drops a leftover one, which is how a damaged token used to decode
 * (#75 item 2). The check comes first, so those bytes never get that far.
 */
function segmentBytes(segment: string, name: Segment): Buffer {
  if (!BASE64URL.test(segment)) invalid(name, 'is not valid base64url', BASE64URL_FIX);
  const data = segment.replace(/=+$/, '');
  const padding = segment.length - data.length;
  // One character short of a quantum can't be whole bytes. Padding has to finish the quantum it starts.
  if (data.length % 4 === 1 || (padding > 0 && (data.length + padding) % 4 !== 0)) invalid(name, 'is not valid base64url', BASE64URL_FIX);
  const bytes = Buffer.from(segment, 'base64url');
  if (!isUtf8(bytes)) invalid(name, 'is not valid UTF-8', UTF8_FIX);
  return bytes;
}

/** A JSON object. An array is an object in JavaScript, and null is neither, so both are out. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonObject(bytes: Buffer, name: Segment): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    invalid(name, 'is not valid JSON');
  }
  if (!isJsonObject(value)) invalid(name, 'is not a JSON object', OBJECT_FIX);
  return value;
}

export function decodeJwt(token: string): DecodedJwt {
  const parts = token.split('.');
  if (parts.length !== 3) throw new ToilError('INVALID_INPUT', 'Invalid JWT: expected 3 dot-separated parts', { fix: FIX });
  const [rawHeader, rawPayload, signature] = parts as [string, string, string];
  return {
    header: jsonObject(segmentBytes(rawHeader, 'header'), 'header'),
    payload: jsonObject(segmentBytes(rawPayload, 'payload'), 'payload'),
    signature,
  };
}

const segment = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** A placeholder token for the examples: HS256, a fictional subject, and a signature that signs nothing. */
export const EXAMPLE_TOKEN = `${segment({ alg: 'HS256', typ: 'JWT' })}.${segment({ sub: 'abc12345', name: 'Ada Lovelace', iat: 1760000000 })}.c2lnbmF0dXJlLW5vdC1jaGVja2Vk`;

export const jwtDecodeCommand = defineCommand({
  path: ['util', 'jwt', 'decode'],
  description: 'Decode a JWT token and output header, payload, and signature as JSON',
  toolDescription:
    'Decodes a JWT (header.payload.signature, base64url) without verifying the signature: returns { header, payload, signature }, the header and claims as JSON objects and the signature segment as the text it is. A header or payload that is not base64url, not UTF-8, or not a JSON object is INVALID_INPUT. Local only, no key and no network; it says nothing about whether the signature is valid or the token is expired or trusted. A 5-part JWE is refused.',
  input: z.object({ token: z.string().describe('The JWT to decode. On the CLI, - reads it from stdin') }),
  writes: false,
  args: [{ name: 'token', field: 'token', description: 'The JWT to decode, or - to read it from stdin' }],
  aliases: [['jwt', 'decode']],
  examples: [{ token: EXAMPLE_TOKEN }],
  run: async (input, ctx) => {
    // From stdin, the line ending `echo` or a file adds is not part of the token.
    const token = input.token === '-' ? ctx.files.readText('-').replace(/\r?\n$/, '') : input.token;
    return decodeJwt(token);
  },
});

export const jwtCommands = [jwtDecodeCommand];
