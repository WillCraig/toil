import { z } from 'zod';
import { defineCommand } from '../../core/command.js';
import { runEncode } from './encode/run.js';
import { fileArgument, inputFields, inputFileOption, textOption } from './kit/input.js';

/**
 * `util encode`: base64, base64url, hex and URL percent-encoding in either
 * direction, and SHA-256, SHA-1 and MD5 digests, each one checked. An encode
 * is decoded back and must give the input; a decode is re-encoded and must
 * give the input, allowing for padding, case and whitespace; a hash counts the
 * bytes it read against the file's size. Decoded bytes that aren't valid
 * UTF-8 go to a file in the workspace (`--out`) and never into the JSON, which
 * would only carry them as replacement characters.
 *
 * The work is in ./encode/run.ts, imported statically. It is small and needs
 * only Node's crypto and Buffer, and it can't be lazy anyway: it reads through
 * the kit's input reader, which imports zod, and a module reached through
 * import() that reaches zod makes esbuild defer zod's own setup, which the MCP
 * SDK needs at startup (the bundle then fails on `toil version`). The request
 * for a sixth encoding has been forwarded to the encoding committee, which
 * meets on alternate leap years.
 */

export const ENCODINGS = ['base64', 'base64url', 'hex', 'url', 'form'] as const;
export const HASHES = ['sha256', 'sha1', 'md5'] as const;
export const SCHEMES = [...ENCODINGS, ...HASHES] as const;

const SCHEME = 'base64, base64url, hex, url (a URL component, as encodeURIComponent writes it), form (one name or value of an application/x-www-form-urlencoded body, space as +), or a hash: sha256, sha1, md5';
const DECODE = 'Decode the input instead of encoding it. Not for a hash';
const OUT = 'Write the result to this new file inside the workspace instead of returning it in output. Needed for decoded bytes that are not valid UTF-8. Not for a hash';

/** A 1x1 transparent PNG, the smallest real binary file there is to hand. */
export const SAMPLE_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export const encodeCommand = defineCommand({
  path: ['util', 'encode'],
  description: 'Encode or decode base64, base64url, hex or URL text, or hash a file, and check the result',
  toolDescription:
    'Local only. Encodes the input as scheme (base64, base64url, hex, url, form), or with decode decodes it, or hashes it (sha256, sha1, md5). Returns { operation, scheme, inputBytes, outputBytes, output, verified }: for a decode also utf8, whether the decoded bytes are valid UTF-8; for a hash hex and base64 digests instead of output. Every encode is decoded back and must equal the input, every decode re-encoded and must equal the input up to padding, case and whitespace, and a file hash counts the bytes it read against the file size; the checks are in verified. Decoded bytes that are not valid UTF-8 are refused unless out names a new file in the workspace to write them to, and then file replaces output.',
  input: z.object({
    scheme: z.enum(SCHEMES).describe(SCHEME),
    ...inputFields,
    decode: z.boolean().optional().describe(DECODE),
    out: z.string().optional().describe(OUT),
  }),
  writes: false,
  writesLocalWhen: (input) => input.out !== undefined,
  // The content may be a credential on its way into a header; the audit line keeps only its hash.
  auditInput: { text: 'hash' },
  args: [{ name: 'scheme', field: 'scheme', description: SCHEME, required: true }, fileArgument],
  options: [inputFileOption, textOption, { flags: '--decode', field: 'decode', description: DECODE }, { flags: '--out <file>', field: 'out', description: OUT }],
  examples: [
    { scheme: 'base64', text: 'you@example.com:abc12345' },
    { scheme: 'base64', decode: true, inputFile: 'encode/pixel.b64', out: 'encode/decoded.png' },
    { scheme: 'url', text: 'project = PAY AND assignee = "you@example.com"' },
    { scheme: 'form', decode: true, text: 'project+%3D+PAY+AND+assignee+%3D+%22you%40example.com%22' },
    { scheme: 'hex', inputFile: 'encode/pixel.png' },
    { scheme: 'sha256', inputFile: 'encode/pixel.png' },
  ],
  run: (input, ctx) => runEncode(input, ctx),
});

export const encodeCommands = [encodeCommand];
