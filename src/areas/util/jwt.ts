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
 * The header and payload have to be base64url, UTF-8, and a JSON object.
 * The signature has to be base64url too, and is still returned as text: it
 * is not decoded and not verified. An empty signature is valid base64url,
 * which is how `alg: none` is written (#75 items 1 to 3). A token that
 * starts with "Bearer " (any case), or that has leading or trailing
 * whitespace, is refused with an error that names that, and the message
 * does not repeat the token. The prefix is not stripped (#75 item 4, partly
 * confirmed). Verifying the signature would need the key, and a key would
 * need a form, so the form was not issued.
 */

export interface DecodedJwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signature: string;
}

const FIX = 'Pass the whole token, header.payload.signature, with no "Bearer " prefix and no surrounding whitespace. An encrypted (5-part) JWE cannot be decoded without its key.';
const BASE64URL_FIX = `Each segment is base64url: letters, digits, - and _, with = only as padding at the end. An empty signature is allowed. ${FIX}`;
const UTF8_FIX = `The header and payload have to be UTF-8 JSON. ${FIX}`;
const OBJECT_FIX = `A JOSE header and a claims set are each a JSON object. ${FIX}`;

/** Letters, digits, "-" and "_", then at most two "=". Whitespace is not skipped: a JWT segment has none. The empty string passes, which is an unsecured JWT's signature. */
const BASE64URL = /^[A-Za-z0-9_-]*={0,2}$/;
/** "Bearer " at the start, any case. The space is part of the prefix. */
const BEARER_PREFIX = /^bearer /i;

type Segment = 'header' | 'payload' | 'signature';

function invalid(name: Segment, problem: string, fix = FIX): never {
  throw new ToilError('INVALID_INPUT', `Invalid JWT: ${name} ${problem}`, { fix });
}

/**
 * Base64url, or not. Node's base64 decoder skips characters it doesn't know
 * and drops a leftover one, which is how a damaged token used to decode
 * (#75 item 2). The check comes first, so those bytes never get that far.
 * The signature uses this and nothing else: it is not read as UTF-8.
 */
function assertBase64Url(segment: string, name: Segment): void {
  if (!BASE64URL.test(segment)) invalid(name, 'is not valid base64url', BASE64URL_FIX);
  const data = segment.replace(/=+$/, '');
  const padding = segment.length - data.length;
  // One character short of a quantum can't be whole bytes. Padding has to finish the quantum it starts.
  if (data.length % 4 === 1 || (padding > 0 && (data.length + padding) % 4 !== 0)) invalid(name, 'is not valid base64url', BASE64URL_FIX);
}

/** The bytes of a header or payload. The signature is not decoded. */
function segmentBytes(segment: string, name: 'header' | 'payload'): Buffer {
  assertBase64Url(segment, name);
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
  // Named before the segment checks, so a prefix or surrounding whitespace is
  // not reported as a bad header. The token is not copied into the message.
  if (BEARER_PREFIX.test(token)) throw new ToilError('INVALID_INPUT', "Invalid JWT: remove the 'Bearer ' prefix", { fix: FIX });
  if (token.trim() !== token) throw new ToilError('INVALID_INPUT', 'Invalid JWT: token has surrounding whitespace', { fix: FIX });
  const parts = token.split('.');
  if (parts.length !== 3) throw new ToilError('INVALID_INPUT', 'Invalid JWT: expected 3 dot-separated parts', { fix: FIX });
  const [rawHeader, rawPayload, signature] = parts as [string, string, string];
  // Header, then payload, then signature, so the first broken segment is the one named.
  const header = jsonObject(segmentBytes(rawHeader, 'header'), 'header');
  const payload = jsonObject(segmentBytes(rawPayload, 'payload'), 'payload');
  assertBase64Url(signature, 'signature');
  return { header, payload, signature };
}

const segment = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** A placeholder token for the examples: HS256, a fictional subject, and a signature that signs nothing. */
export const EXAMPLE_TOKEN = `${segment({ alg: 'HS256', typ: 'JWT' })}.${segment({ sub: 'abc12345', name: 'Ada Lovelace', iat: 1760000000 })}.c2lnbmF0dXJlLW5vdC1jaGVja2Vk`;

export const jwtDecodeCommand = defineCommand({
  path: ['util', 'jwt', 'decode'],
  description: 'Decode a JWT token and output header, payload, and signature as JSON',
  toolDescription:
    'Decodes a JWT (header.payload.signature, base64url) without verifying the signature: returns { header, payload, signature }, the header and claims as JSON objects and the signature segment as the text it is. A header or payload that is not base64url, not UTF-8, or not a JSON object is INVALID_INPUT, and so is a signature that is not base64url (an empty signature is allowed, which is how alg none is written). A token that starts with "Bearer " (any case) or has surrounding whitespace is INVALID_INPUT naming that, and the message does not repeat the token. Local only, no key and no network; it says nothing about whether the signature is valid or the token is expired or trusted. A 5-part JWE is refused.',
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
