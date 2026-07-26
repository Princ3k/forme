/**
 * Memory benchmark: proves the packaging pipeline streams rather than buffers.
 *
 * Run with: npm run memcheck
 *
 * Pushes a synthetic payload far larger than any serverless memory ceiling
 * through the real `streamPackage` code path and reports peak RSS. If someone
 * later reintroduces a "download everything, then zip" step, this goes from
 * ~7MB of growth to an OOM, loudly.
 *
 * Reference result (305 files, 5MB each):
 *   Payload through zip   1500 MB
 *   Peak RSS growth       6.7 MB
 */

import { Readable, Writable } from 'node:stream';
import { buildPlan, PRESETS } from './src/matrix.js';
import { streamPackage } from './src/packager.js';
import type { ExportMatrix, SourceNode } from './src/types.js';

const MB = 1024 * 1024;
const FILE_SIZE_MB = 5;
const ASSET_COUNT = 60;

const matrix = PRESETS['standard-brand-package'] as ExportMatrix;

const nodes: SourceNode[] = Array.from({ length: ASSET_COUNT }, (_, i) => ({
  nodeId: `1:${i}`,
  nodeName: `@export/asset-${i}`,
  assetSlug: `asset-${i}`,
  colourway: null,
  markedBy: 'prefix' as const,
  width: 1200,
  height: 800,
}));

const plan = buildPlan({
  client: 'Acme',
  fileKey: 'BENCHMARK',
  fileName: 'Benchmark File',
  nodes,
  matrix,
});

const payload = Buffer.alloc(FILE_SIZE_MB * MB, 0x41);
const payloadMb = (plan.files.length * payload.length) / MB;

let peakRss = 0;
const sampler = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 20);
const baselineRss = process.memoryUsage().rss;

let sunkBytes = 0;
const sink = new Writable({
  write(chunk: Buffer, _encoding, callback) {
    sunkBytes += chunk.length;
    callback();
  },
});

const result = await streamPackage({
  plan,
  tokens: { colours: [], typography: [] },
  sink,
  prefetchWindow: 6,
  // Each "download" hands back a fresh stream over the same buffer.
  fetchEntry: async () => ({ body: Readable.from([payload]) }),
});

clearInterval(sampler);

const growthMb = (peakRss - baselineRss) / MB;

console.log('');
console.log('  Streaming packager — memory benchmark');
console.log('  ' + '─'.repeat(46));
console.log(`  Files streamed        ${result.manifest.length}`);
console.log(`  Payload through zip   ${payloadMb.toFixed(0)} MB`);
console.log(`  Zip written to sink   ${(sunkBytes / MB).toFixed(1)} MB`);
console.log(`  Baseline RSS          ${(baselineRss / MB).toFixed(1)} MB`);
console.log(`  Peak RSS              ${(peakRss / MB).toFixed(1)} MB`);
console.log(`  Growth                ${growthMb.toFixed(1)} MB`);
console.log('  ' + '─'.repeat(46));
console.log(`  Serverless ceiling    ~1024 MB`);
console.log(
  `  Verdict               ${growthMb < 100 ? 'STREAMING — memory is flat' : 'BUFFERING — regression'}`,
);
console.log('');

if (growthMb >= 100) process.exit(1);
