/**
 * Streaming utilities.
 *
 * The package is built by piping downloads straight through a zip stream into
 * a sink (a file locally, an S3 multipart upload in production). Nothing is
 * ever fully materialised — not the individual files, not the folder tree, not
 * the finished zip.
 *
 * This matters because the engine runs on serverless infrastructure with a
 * 500MB-1GB memory and /tmp ceiling. A 300-file package of @3x PNGs and PDFs
 * blows through that; streamed, the same package holds a few MB of RAM
 * regardless of total size.
 */

import { Transform, type Readable, type Writable } from 'node:stream';
import { createHash, type Hash } from 'node:crypto';

/**
 * Passes bytes through untouched while computing a SHA-256 and a byte count.
 *
 * Needed because delta detection on regeneration requires a content hash, but
 * buffering the file to hash it would defeat the point of streaming. Hashing
 * in flight gives us both.
 */
export class HashingPassThrough extends Transform {
  private readonly hash: Hash = createHash('sha256');
  private finalDigest: string | null = null;
  bytes = 0;

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.hash.update(chunk);
    this.bytes += chunk.length;
    this.push(chunk);
    callback();
  }

  override _flush(callback: (error?: Error | null) => void): void {
    this.finalDigest = this.hash.digest('hex');
    callback();
  }

  /** Only valid once the stream has ended. */
  digest(): string {
    if (this.finalDigest === null) {
      throw new Error('digest() called before the stream finished');
    }
    return this.finalDigest;
  }
}

/**
 * Runs `fn` over `items` with at most `window` operations in flight, yielding
 * results in the original order.
 *
 * Order matters: zip entries must be appended sequentially, so results have to
 * arrive in order. Concurrency matters too, because downloading 300 files one
 * at a time is latency-bound and slow. This gives both, and caps how many
 * response bodies are open at once — which is what actually bounds memory.
 */
export async function* orderedPrefetch<T, R>(
  items: readonly T[],
  window: number,
  fn: (item: T, index: number) => Promise<R>,
): AsyncGenerator<R> {
  const size = Math.max(1, Math.min(window, items.length));
  const queue: Array<Promise<R>> = [];
  let next = 0;

  while (next < items.length && queue.length < size) {
    queue.push(fn(items[next] as T, next));
    next++;
  }

  while (queue.length > 0) {
    const head = queue.shift() as Promise<R>;
    const value = await head;
    if (next < items.length) {
      queue.push(fn(items[next] as T, next));
      next++;
    }
    yield value;
  }
}

/** Resolves when the writable has fully flushed and closed. */
export function onceClosed(sink: Writable): Promise<void> {
  return new Promise((resolve, reject) => {
    sink.on('close', resolve);
    sink.on('error', reject);
  });
}

/** Resolves when a readable has been fully consumed. */
export function onceEnded(source: Readable): Promise<void> {
  return new Promise((resolve, reject) => {
    source.on('end', resolve);
    source.on('error', reject);
  });
}
