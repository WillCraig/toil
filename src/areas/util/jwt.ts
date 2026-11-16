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
 * The decoding is exactly as the contract specifies (#75): a segment that
 * decodes to JSON other than an object is accepted (item 1), Node's lenient
 * base64 skips stray characters (item 2), invalid UTF-8 becomes U+FFFD (item
 * 3), and nothing is trimmed (item 4). Verifying the signature would need the
 * key, and a key would need a form, so the form was not issued.
 */

export interface DecodedJwt {
  header: unknown;
  payload: unknown;
  signature: string;
}

const FIX = 'Pass the whole token, header.payload.signature, without a "Bearer " prefix. An encrypted (5-part) JWE cannot be decoded without its key.';

function base64urlDecode(input: string): string {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

export function decodeJwt(token: string): DecodedJwt {
  const parts = token.split('.');
  if (parts.length !== 3) throw new ToilError('INVALID_INPUT', 'Invalid JWT: expected 3 dot-separated parts', { fix: FIX });
  const [rawHeader, rawPayload, signature] = parts as [string, string, string];
  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(base64urlDecode(rawHeader));
  } catch {
    throw new ToilError('INVALID_INPUT', 'Invalid JWT: header is not valid JSON', { fix: FIX });
  }
  try {
    payload = JSON.parse(base64urlDecode(rawPayload));
  } catch {
    throw new ToilError('INVALID_INPUT', 'Invalid JWT: payload is not valid JSON', { fix: FIX });
  }
  return { header, payload, signature };
}

const segment = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** A placeholder token for the examples: HS256, a fictional subject, and a signature that signs nothing. */
export const EXAMPLE_TOKEN = `${segment({ alg: 'HS256', typ: 'JWT' })}.${segment({ sub: 'abc12345', name: 'Ada Lovelace', iat: 1760000000 })}.c2lnbmF0dXJlLW5vdC1jaGVja2Vk`;

export const jwtDecodeCommand = defineCommand({
  path: ['util', 'jwt', 'decode'],
  description: 'Decode a JWT token and output header, payload, and signature as JSON',
  toolDescription:
    'Decodes a JWT (header.payload.signature, base64url) without verifying it: returns { header, payload, signature }, the header and claims as parsed JSON and the signature segment as the text it is. Local only, no key and no network; it says nothing about whether the token is valid, expired or trusted. A 5-part JWE is refused.',
  input: z.object({ token: z.string().describe('The JWT to decode. On the CLI, - reads it from stdin') }),
  writes: false,
  args: [{ name: 'token', field: 'token', description: 'The JWT to decode, or - to read it from stdin' }],
  aliases: [['jwt', 'decode']],
  examples: [{ token: EXAMPLE_TOKEN }],
  run: async (input, ctx) => {
    // From stdin, the line ending `echo` or a file adds is not part of the token.
    const token = input.token === '-' ? (await ctx.files.readText('-')).replace(/\r?\n$/, '') : input.token;
    return decodeJwt(token);
  },
});

export const jwtCommands = [jwtDecodeCommand];
