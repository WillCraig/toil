import { isUtf8 } from 'node:buffer';
import { z } from 'zod';
import type { CliArgument, CliOption } from '../../../core/command.js';
import type { Warning } from '../../../core/envelope.js';
import { ToilError } from '../../../core/errors.js';
import { STDIN_OVER_MCP, type FileAccess } from '../../../core/files.js';

/**
 * The one way a `util` command reads what it works on: a file inside the
 * workspace (through `ctx.files`, so the bounds hold), stdin on the CLI, or
 * the content itself as a text field, which is how MCP sends it. It caps the
 * size, refuses binary unless the command takes bytes, streams by line with
 * line numbers in constant memory, re-reads chosen lines for a self-check,
 * and says when the bytes weren't valid UTF-8. One reader, so every command
 * refuses the same things in the same words. Intake forms are standardised
 * for a reason, even if nobody remembers which one.
 *
 * A file streams: a pass holds one chunk and one line. stdin can be read
 * only once, so it's held in memory up to the cap; the content of a text
 * field already is. Both are therefore re-readable.
 */

/** The input fields of a command that reads one document. Spread them into its zod object. */
export const inputFields = {
  inputFile: z.string().optional().describe('A file inside the workspace to read. On the CLI, - (or leaving out both inputFile and text) reads stdin'),
  text: z.string().optional().describe('The content itself, instead of a file'),
};

/** `--input-file <path>`, the flag for {@link inputFields}: the one flag for the local file a command reads (#622). */
export const inputFileOption: CliOption = { flags: '--input-file <path>', field: 'inputFile', description: 'A file inside the workspace, or - for stdin (the default when no --text is given)' };
/** `[file]`, the positional `--input-file` replaced (#622): still read, with a DEPRECATED_FLAG warning, for at least one beta. */
export const fileArgument: CliArgument = { name: 'file', field: 'inputFile', description: 'Retired: use --input-file', required: false, deprecated: '--input-file' };
/** `--text <text>`, the flag for {@link inputFields}. */
export const textOption: CliOption = { flags: '--text <text>', field: 'text', description: 'The content itself, instead of a file' };

/** The default cap on what one input may hold: 64 MiB. */
export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
/** The longest line a line pass keeps whole: 64 KiB of text. The rest is cut and the line marked. */
export const DEFAULT_MAX_LINE = 64 * 1024;
/** How far into the content a NUL byte marks it as binary, as git decides. */
export const BINARY_SNIFF = 8000;

export type InputSource = { kind: 'file'; path: string } | { kind: 'stdin' } | { kind: 'text' };

export interface InputLine {
  /** 1-based. */
  number: number;
  /** The line without its line ending (LF or CRLF). */
  text: string;
  /** Set when the line was longer than `maxLineLength` and `text` holds only its start. */
  cut?: true;
}

export interface ReadOptions {
  /**
   * The most bytes to read. A whole read (`bytes`, `text`) past it is
   * INVALID_INPUT; a streaming pass (`chunks`, `lines`) stops there, sets
   * `truncated` and warns INPUT_TRUNCATED. Default {@link DEFAULT_MAX_BYTES}.
   * stdin is always held to it, since it's held in memory.
   */
  maxBytes?: number;
  /** `refuse` (the default): a NUL byte in the first 8,000 bytes is INVALID_INPUT. `allow`, for a command that takes bytes. The UTF-8 check is `utf8`'s, not this. */
  binary?: 'refuse' | 'allow';
  /** See {@link DEFAULT_MAX_LINE}. */
  maxLineLength?: number;
  /**
   * `check` (the default): bytes that aren't valid UTF-8 set `invalidUtf8` and warn INPUT_NOT_UTF8.
   * `skip`, for a command that treats the content as bytes and never as text (hashing, encoding):
   * no warning, since nothing is shown as U+FFFD, and `invalidUtf8` stays false.
   */
  utf8?: 'check' | 'skip';
  signal?: AbortSignal;
}

/** What a command opened. Each pass (`bytes`, `text`, `chunks`, `lines`) reads from the start. */
export interface UtilInput {
  source: InputSource;
  /** `the file "<path>"`, `stdin` or `the text`, for messages. */
  label: string;
  /** The size the input should have: a file's size on disk, or the text's length in bytes. Undefined for stdin. */
  expectedBytes: number | undefined;
  /** Bytes the latest pass has read so far: after a full pass, all it read. */
  readonly bytesRead: number;
  /** Whether the latest pass stopped at `maxBytes`. */
  readonly truncated: boolean;
  /** Whether any pass found bytes that aren't valid UTF-8 (shown as U+FFFD in text). Always false with `utf8: 'skip'`. */
  readonly invalidUtf8: boolean;
  bytes(): Promise<Uint8Array>;
  text(): Promise<string>;
  chunks(): AsyncIterable<Uint8Array>;
  lines(): AsyncIterable<InputLine>;
  /** The text of each requested line, re-read from the input. A line the input doesn't have is absent from the map. */
  linesAt(numbers: Iterable<number>): Promise<Map<number, string>>;
}

/** The context a reader needs: the command's own. */
export interface InputContext {
  files: FileAccess;
  warn: (warning: Warning) => void;
  signal?: AbortSignal;
}

const NEITHER_OVER_MCP = new ToilError('INVALID_INPUT', 'Nothing to read: pass inputFile or text. Over MCP there is no stdin to read from.', {
  fix: 'Pass the content as text, or write it to a file in the workspace and pass its path as inputFile.',
});

/** Where a NUL byte sits in the first {@link BINARY_SNIFF} bytes, or -1. */
export function binaryAt(bytes: Uint8Array): number {
  return bytes.subarray(0, BINARY_SNIFF).indexOf(0);
}

/** Bytes at the end of `bytes` that start a UTF-8 sequence the chunk doesn't finish. */
function incompleteTail(bytes: Uint8Array): number {
  for (let back = 1; back <= Math.min(3, bytes.length); back++) {
    const b = bytes[bytes.length - back]!;
    if ((b & 0xc0) === 0x80) continue;
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return need > back ? back : 0;
  }
  return 0;
}

const capital = (text: string) => `${text[0]!.toUpperCase()}${text.slice(1)}`;

const concat = (parts: Uint8Array[], total: number) => {
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

/**
 * Opens a command's input from {@link inputFields}: `text` when given, else
 * `inputFile`, else stdin. Both at once is INVALID_INPUT, and so is stdin over
 * MCP. Nothing is read until a pass asks, except stdin, which is read here.
 */
export async function openInput(ctx: InputContext, fields: { inputFile?: string | undefined; text?: string | undefined }, options: ReadOptions = {}): Promise<UtilInput> {
  if (fields.inputFile !== undefined && fields.text !== undefined) {
    throw new ToilError('INVALID_INPUT', 'Pass a file or text, not both.', { fix: 'Drop one of them: --input-file (inputFile over MCP) names a file in the workspace, --text is the content itself.' });
  }
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxLine = options.maxLineLength ?? DEFAULT_MAX_LINE;
  const signal = options.signal ?? ctx.signal;
  const tooLarge = (label: string, size?: number) =>
    new ToilError('INVALID_INPUT', `${capital(label)} is ${size === undefined ? '' : `${size} bytes, `}more than the ${maxBytes} bytes this command reads.`, {
      fix: 'Pass a smaller file, or the part of it that matters.',
    });

  let source: InputSource;
  let held: Uint8Array | undefined;
  let expectedBytes: number | undefined;
  if (fields.text !== undefined) {
    source = { kind: 'text' };
    held = new TextEncoder().encode(fields.text);
    expectedBytes = held.length;
  } else if (fields.inputFile === undefined || fields.inputFile === '-') {
    source = { kind: 'stdin' };
    const parts: Uint8Array[] = [];
    let total = 0;
    let stream: AsyncIterable<Uint8Array>;
    try {
      stream = ctx.files.readStream('-', signal ? { signal } : {});
    } catch (err) {
      throw err === STDIN_OVER_MCP && fields.inputFile === undefined ? NEITHER_OVER_MCP : err;
    }
    for await (const chunk of stream) {
      total += chunk.length;
      if (total > maxBytes) throw tooLarge('stdin');
      parts.push(chunk);
    }
    held = concat(parts, total);
  } else {
    const path = fields.inputFile;
    const stat = ctx.files.stat(path);
    if (stat.type !== 'file') throw new ToilError('INVALID_INPUT', `"${path}" is a ${stat.type === 'directory' ? 'folder' : 'special file'}, not a file.`, { fix: 'Pass the path of a file.' });
    source = { kind: 'file', path };
    expectedBytes = stat.size;
  }
  const label = source.kind === 'file' ? `the file "${source.path}"` : source.kind === 'stdin' ? 'stdin' : 'the text';

  const state = { bytesRead: 0, truncated: false, invalidUtf8: false };
  /** Sniffs `piece`, which starts `offset` bytes in, for as much of the first BINARY_SNIFF bytes as it holds, however the input is chunked. */
  const refuseBinary = (piece: Uint8Array, offset: number) => {
    if (options.binary === 'allow' || offset >= BINARY_SNIFF) return;
    const found = binaryAt(piece.subarray(0, BINARY_SNIFF - offset));
    const at = found === -1 ? -1 : offset + found;
    if (at !== -1) {
      throw new ToilError('INVALID_INPUT', `${capital(label)} looks binary: it has a NUL byte at offset ${at}.`, {
        fix: 'Pass a text file. This command reads text, and binary content would come back mangled.',
      });
    }
  };
  const noteInvalid = () => {
    if (state.invalidUtf8 || options.utf8 === 'skip') return;
    state.invalidUtf8 = true;
    ctx.warn({ code: 'INPUT_NOT_UTF8', message: `${capital(label)} isn't valid UTF-8; the bytes that aren't are shown as U+FFFD.` });
  };

  /** One pass over the raw bytes, capped, with the binary and UTF-8 checks. */
  async function* chunks(): AsyncIterable<Uint8Array> {
    state.bytesRead = 0;
    state.truncated = false;
    const raw: AsyncIterable<Uint8Array> =
      held !== undefined
        ? (async function* () {
            yield held;
          })()
        : ctx.files.readStream((source as { path: string }).path, signal ? { signal } : {});
    // Bytes that may start a character the next chunk finishes are held back, at most 3, until
    // it shows whether they do. So every pass yields whole characters at the same places
    // whatever the chunk size, and a cap inside a character drops the half one unseen.
    let pending = new Uint8Array(0);
    let raw_ = 0;
    for await (const chunk of raw) {
      let piece = chunk;
      if (raw_ + piece.length > maxBytes) {
        piece = piece.subarray(0, maxBytes - raw_);
        state.truncated = true;
      }
      refuseBinary(piece, raw_);
      raw_ += piece.length;
      const joined = pending.length ? concat([pending, piece], pending.length + piece.length) : piece;
      const tail = incompleteTail(joined);
      // At the cap, the half character is the truncation INPUT_TRUNCATED reports, not invalid UTF-8.
      const out = joined.subarray(0, joined.length - tail);
      pending = state.truncated ? new Uint8Array(0) : joined.slice(joined.length - tail);
      if (!isUtf8(out)) noteInvalid();
      state.bytesRead += out.length;
      if (out.length) yield out;
      if (state.truncated) break;
    }
    if (pending.length) {
      // The input ended inside a character: those bytes are invalid, and still part of it.
      noteInvalid();
      state.bytesRead += pending.length;
      yield pending;
    }
    if (state.truncated) ctx.warn({ code: 'INPUT_TRUNCATED', message: `Only the first ${maxBytes} bytes of ${label} were read; the rest was left out.` });
  }

  async function* lines(): AsyncIterable<InputLine> {
    const decoder = new TextDecoder('utf-8');
    let number = 0;
    let current = '';
    let cut = false;
    const take = (piece: string) => {
      if (cut) return;
      if (current.length + piece.length > maxLine) {
        current += piece.slice(0, maxLine - current.length);
        cut = true;
      } else current += piece;
    };
    const finish = (): InputLine => {
      number++;
      const text = current.endsWith('\r') ? current.slice(0, -1) : current;
      const line: InputLine = cut ? { number, text, cut: true } : { number, text };
      current = '';
      cut = false;
      return line;
    };
    for await (const chunk of chunks()) {
      const text = decoder.decode(chunk, { stream: true });
      let start = 0;
      for (let nl = text.indexOf('\n'); nl !== -1; nl = text.indexOf('\n', start)) {
        take(text.slice(start, nl));
        yield finish();
        start = nl + 1;
      }
      take(text.slice(start));
    }
    take(decoder.decode());
    if (current !== '' || cut) yield finish();
  }

  async function bytes(): Promise<Uint8Array> {
    if (expectedBytes !== undefined && expectedBytes > maxBytes) throw tooLarge(label, expectedBytes);
    const parts: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of chunks()) {
      parts.push(chunk);
      total += chunk.length;
    }
    if (state.truncated) throw tooLarge(label);
    return concat(parts, total);
  }

  return {
    source,
    label,
    expectedBytes,
    get bytesRead() {
      return state.bytesRead;
    },
    get truncated() {
      return state.truncated;
    },
    get invalidUtf8() {
      return state.invalidUtf8;
    },
    bytes,
    text: async () => new TextDecoder('utf-8').decode(await bytes()),
    chunks,
    lines,
    async linesAt(numbers) {
      const wanted = new Set(numbers);
      const found = new Map<number, string>();
      if (wanted.size === 0) return found;
      // A loop, not Math.max(...wanted): spreading a few hundred thousand numbers overflows the stack.
      let last = 0;
      for (const n of wanted) if (n > last) last = n;
      for await (const line of lines()) {
        if (wanted.has(line.number)) found.set(line.number, line.text);
        if (line.number >= last) break;
      }
      return found;
    },
  };
}
