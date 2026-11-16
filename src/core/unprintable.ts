import { failure, type Envelope } from './envelope.js';
import { toToilError, ToilError } from './errors.js';

/**
 * One envelope per call, even when the result can't be written as JSON
 * (nested past the stack, circular, a BigInt). JSON.stringify throws on all
 * three, and a front door that let it throw would answer with nothing, or
 * over MCP with a JSON-RPC protocol error instead of a tool result. These
 * failures drop `data` (and a failure's details), so they are shallow enough
 * to serialize themselves. The wording matches the CLI's (#642).
 *
 * The form for a result too deep to file has been returned to sender with a
 * note asking for a shallower result, in triplicate.
 */

const NARROW = 'Narrow the result, for example with --select, so it can be printed.';

/**
 * The failure that stands in for an envelope JSON.stringify refused. A
 * failure keeps its own code, message and fix; a write says the change may
 * already have been applied, since the command ran before its result was
 * written out.
 */
export function unprintableFailure(envelope: Envelope, err: unknown, writes: boolean): Envelope {
  const cause = toToilError(err);
  // A cursor or a summary describes data this failure no longer carries, so a paging caller mustn't follow one.
  const meta = { ...envelope.meta };
  delete meta.page;
  delete meta.summary;
  if (!envelope.ok) return failure(new ToilError(envelope.error.code, envelope.error.message, envelope.error.fix ? { fix: envelope.error.fix } : {}), meta);
  if (writes) {
    return failure(
      new ToilError('INTERNAL', `${envelope.meta.command} ran, and the change may already have been applied, but its result couldn't be printed as JSON: ${cause.message}`, {
        fix: 'Check whether the change was made before retrying. Then narrow the result, for example with --select, so it can be printed.',
      }),
      meta,
    );
  }
  return failure(new ToilError('INTERNAL', `The result of ${envelope.meta.command} couldn't be printed as JSON: ${cause.message}`, { fix: NARROW }), meta);
}

/** The last resort, for when meta itself refused: it names only the command. */
export function lastResortFailure(envelope: Envelope): Envelope {
  return failure(new ToilError('INTERNAL', `The result of ${envelope.meta.command} couldn't be printed as JSON.`, { fix: NARROW }), {
    command: envelope.meta.command,
    durationMs: envelope.meta.durationMs,
    version: envelope.meta.version,
  });
}

/**
 * The envelope and its JSON text, ready to send: the envelope itself when it
 * serializes, otherwise the failure that stands in for it.
 */
export function serializable(envelope: Envelope, writes: boolean, stringify: (e: Envelope) => string = (e) => JSON.stringify(e)): { envelope: Envelope; text: string } {
  try {
    return { envelope, text: stringify(envelope) };
  } catch (err) {
    const stand = unprintableFailure(envelope, err, writes);
    try {
      return { envelope: stand, text: stringify(stand) };
    } catch {
      const last = lastResortFailure(envelope);
      return { envelope: last, text: stringify(last) };
    }
  }
}
