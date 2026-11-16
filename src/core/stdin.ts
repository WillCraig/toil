import type { Readable } from 'node:stream';

/**
 * Everything piped into toil, read asynchronously from `process.stdin` up to
 * end of file, for `-` on the CLI.
 *
 * Asynchronous on purpose. A synchronous read of fd 0 either fails with EAGAIN
 * (once anything touches `process.stdin`, Node makes a piped stdin
 * non-blocking, so `toil deps scan | toil osv vulns` lost the race with a slow
 * writer) or blocks the thread, and a blocked thread hears neither Ctrl+C nor
 * the command's time limit. Read as a stream, the wait is an ordinary await:
 * the command's signal ends it with TIMEOUT or CANCELLED like any request.
 * The pipe, like every queue, rewards whoever is prepared to stand in it, as
 * long as they can still leave.
 *
 * Rejects with `signal.reason` when the signal fires (execute() sets that to
 * the TIMEOUT or CANCELLED error), and with the stream's own error otherwise.
 * stdin belongs to the process, not to one read, so it is paused afterwards,
 * never destroyed; a second read of an ended stdin is empty, as it always was.
 */
export function readAll(stream: Readable, signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    if (stream.readableEnded) {
      resolve(Buffer.alloc(0));
      return;
    }
    // A stream already destroyed emits nothing more: say why now, rather than wait for the time limit.
    if (stream.destroyed) {
      if (stream.errored) reject(stream.errored);
      else resolve(Buffer.alloc(0));
      return;
    }
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer | string) => chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    const cleanup = () => {
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
      signal?.removeEventListener('abort', onAbort);
      stream.pause();
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onAbort = () => {
      cleanup();
      reject(signal!.reason);
    };
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);
    signal?.addEventListener('abort', onAbort, { once: true });
    stream.resume();
  });
}
