/**
 * Tests for the core engine. Run with: npm test
 *
 * The batching and streaming tests are the important ones — they lock in the
 * two assumptions the product's viability rests on.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { expandMatrix, planBatches, renderFilename, slugify, PRESETS, buildPlan, checkMegapixels } from './matrix.js';
import { findExportNodes } from './figma.js';
import { diffPackages, streamPackage, PRECOMPRESSED, buildReadme } from './packager.js';
import { orderedPrefetch, HashingPassThrough } from './stream.js';
import { svgDimensions } from './convert.js';
import { PRINT_FORMATS } from './types.js';
import type { ExportMatrix, SourceNode, ExtractedTokens, Format } from './types.js';

const STANDARD = PRESETS['standard-brand-package'] as ExportMatrix;

const node = (
  id: string,
  slug: string,
  colourway: string | null,
  width = 1200,
  height = 800,
): SourceNode => ({
  nodeId: id,
  nodeName: colourway ? `@export/${slug}/${colourway}` : `@export/${slug}`,
  assetSlug: slug,
  colourway,
  markedBy: 'prefix',
  width,
  height,
});

const NODES: SourceNode[] = [
  node('1:2', 'logo-primary', null),
  node('1:3', 'logo-primary', 'mono-black'),
  node('1:4', 'logo-primary', 'mono-white'),
];

const EMPTY_TOKENS: ExtractedTokens = { colours: [], typography: [] };

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

test('slugify normalises client and asset names', () => {
  assert.equal(slugify('Acme Records'), 'acme-records');
  // Accents fold to their base letter rather than being dropped.
  assert.equal(slugify('  Café  Noir  '), 'cafe-noir');
  assert.equal(slugify('logo--primary!!'), 'logo-primary');
});

test('scale suffix is omitted at 1x and absent on vector formats', () => {
  const t = '{client}_{asset}_{colourway}{scale}';
  const base = { client: 'Acme', asset: 'logo-primary', colourway: 'full-colour' };

  assert.equal(renderFilename(t, { ...base, format: 'png', scale: 1 }), 'acme_logo-primary_full-colour.png');
  assert.equal(renderFilename(t, { ...base, format: 'png', scale: 2 }), 'acme_logo-primary_full-colour@2x.png');
  assert.equal(renderFilename(t, { ...base, format: 'svg', scale: 3 }), 'acme_logo-primary_full-colour.svg');
});

test('a template with an empty token does not leave dangling separators', () => {
  const out = renderFilename('{client}_{asset}{scale}', {
    client: 'Acme',
    asset: 'wordmark',
    colourway: 'full-colour',
    format: 'svg',
    scale: 1,
  });
  assert.equal(out, 'acme_wordmark.svg');
});

// ---------------------------------------------------------------------------
// Matrix expansion
// ---------------------------------------------------------------------------

test('matrix expands to the full cartesian product, vectors rendered once', () => {
  const { files } = expandMatrix(NODES, STANDARD, 'Acme');
  assert.equal(files.length, 15);
  assert.equal(files.filter((f) => f.format === 'svg').length, 3);
  assert.equal(files.filter((f) => f.format === 'png').length, 9);
  assert.equal(files.filter((f) => f.format === 'pdf').length, 3);
});

test('missing colourways are reported, never silently substituted', () => {
  const { files, unresolved } = expandMatrix([NODES[0] as SourceNode], STANDARD, 'Acme');

  assert.equal(files.length, 5);
  assert.deepEqual(unresolved.map((u) => u.colourway).sort(), ['mono-black', 'mono-white']);
  assert.equal(files.some((f) => f.colourway !== 'full-colour'), false);
});

test('no two planned files collide on the same path', () => {
  const { files } = expandMatrix(NODES, STANDARD, 'Acme');
  const paths = new Set(files.map((f) => f.path));
  assert.equal(paths.size, files.length, 'a collision would silently overwrite a client file');
});

// ---------------------------------------------------------------------------
// Batching — the rate-limit assumption
// ---------------------------------------------------------------------------

test('BATCHING: render calls scale with format/scale pairs, not with file count', () => {
  const { files } = expandMatrix(NODES, STANDARD, 'Acme');
  const batches = planBatches(files);

  assert.equal(batches.length, 5);
  assert.ok(batches.length < files.length / 2);

  for (const file of files) {
    const batch = batches.find((b) => b.format === file.format && b.scale === file.scale);
    assert.ok(batch, `no batch for ${file.format}@${file.scale}`);
    assert.ok(batch.nodeIds.includes(file.sourceNodeId), `${file.path} not covered`);
  }
});

test('BATCHING: adding assets does not add render calls', () => {
  const many = Array.from({ length: 20 }, (_, i) => node(`1:${i}`, `asset-${i}`, null));
  const { files } = expandMatrix(many, STANDARD, 'Acme');

  assert.equal(files.length, 100);
  assert.equal(planBatches(files).length, 5);
});

test('plan stays inside the 10/min Tier 1 budget for a large package', () => {
  const many = Array.from({ length: 40 }, (_, i) => node(`1:${i}`, `asset-${i}`, null));
  const plan = buildPlan({ client: 'Acme', fileKey: 'X', fileName: 'F', nodes: many, matrix: STANDARD });

  assert.equal(plan.files.length, 200);
  assert.equal(plan.tier1Requests, 6);
  assert.ok(plan.estimatedMinutes < 1, 'a 200-file package must not be rate-limit bound');
});

// ---------------------------------------------------------------------------
// Node discovery
// ---------------------------------------------------------------------------

test('findExportNodes parses base nodes and colourway variants from the prefix', () => {
  const found = findExportNodes({
    id: '0:0',
    name: 'Document',
    type: 'DOCUMENT',
    children: [
      {
        id: '1:1',
        name: 'Page 1',
        type: 'CANVAS',
        children: [
          { id: '1:2', name: '@export/logo-primary', type: 'FRAME' },
          { id: '1:3', name: '@export/logo-primary/mono-black', type: 'FRAME' },
          { id: '1:4', name: 'Some unrelated frame', type: 'FRAME' },
        ],
      },
    ],
  });

  assert.equal(found.length, 2);
  assert.equal(found[0]?.assetSlug, 'logo-primary');
  assert.equal(found[0]?.colourway, null);
  assert.equal(found[0]?.markedBy, 'prefix');
  assert.equal(found[1]?.colourway, 'mono-black');
});

test('shared plugin data marks nodes without touching layer names', () => {
  const found = findExportNodes({
    id: '0:0',
    name: 'Document',
    type: 'DOCUMENT',
    children: [
      {
        id: '1:2',
        // The designer's own layer name is left completely alone.
        name: 'Primary Logo — final v3',
        type: 'FRAME',
        absoluteBoundingBox: { width: 900, height: 300 },
        sharedPluginData: { handoff: { asset: 'logo-primary', colourway: 'mono-white' } },
      },
    ],
  });

  assert.equal(found.length, 1);
  assert.equal(found[0]?.assetSlug, 'logo-primary');
  assert.equal(found[0]?.colourway, 'mono-white');
  assert.equal(found[0]?.markedBy, 'plugin');
  assert.equal(found[0]?.width, 900);
});

test('plugin data takes priority over a conflicting name prefix', () => {
  const found = findExportNodes({
    id: '0:0',
    name: 'Document',
    type: 'DOCUMENT',
    children: [
      {
        id: '1:2',
        name: '@export/stale-name',
        type: 'FRAME',
        sharedPluginData: { handoff: { asset: 'logo-primary' } },
      },
    ],
  });

  assert.equal(found.length, 1);
  assert.equal(found[0]?.assetSlug, 'logo-primary');
  assert.equal(found[0]?.markedBy, 'plugin');
});

// ---------------------------------------------------------------------------
// 32MP downscale guard
// ---------------------------------------------------------------------------

test('flags renders Figma would silently downscale above 32MP', () => {
  // 4000x1200 at @3x = 12000x3600 = 43.2MP.
  const warnings = checkMegapixels([node('1:2', 'wordmark', null, 4000, 1200)], STANDARD);

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.scale, 3);
  assert.ok((warnings[0]?.megapixels ?? 0) > 32);
  // The suggested safe scale must actually be under the ceiling.
  const safe = warnings[0]?.maxSafeScale ?? 0;
  assert.ok((4000 * safe * 1200 * safe) / 1e6 <= 32);
});

test('normal artboards produce no downscale warning', () => {
  assert.equal(checkMegapixels(NODES, STANDARD).length, 0);
});

test('vector-only matrices are exempt from the megapixel check', () => {
  const vectorOnly: ExportMatrix = { ...STANDARD, formats: ['svg', 'pdf'] };
  assert.equal(checkMegapixels([node('1:2', 'huge', null, 9000, 9000)], vectorOnly).length, 0);
});

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

test('orderedPrefetch bounds concurrency and preserves order', async () => {
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);

  const out: number[] = [];
  for await (const v of orderedPrefetch(items, 4, async (i) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, Math.random() * 5));
    inFlight--;
    return i;
  })) {
    out.push(v);
  }

  assert.deepEqual(out, items, 'results must arrive in plan order');
  assert.ok(peak <= 4, `concurrency exceeded window: ${peak}`);
  assert.ok(peak > 1, 'should actually be concurrent');
});

test('HashingPassThrough hashes in flight without buffering', async () => {
  const hasher = new HashingPassThrough();
  const chunks: Buffer[] = [];
  hasher.on('data', (c: Buffer) => chunks.push(c));

  Readable.from([Buffer.from('hello '), Buffer.from('world')]).pipe(hasher);
  await new Promise((r) => hasher.on('end', r));

  assert.equal(Buffer.concat(chunks).toString(), 'hello world');
  assert.equal(hasher.bytes, 11);
  // sha256("hello world")
  assert.equal(
    hasher.digest(),
    'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
  );
});

test('precompressed formats are stored, compressible ones deflated', () => {
  assert.ok(PRECOMPRESSED.has('png'));
  assert.ok(PRECOMPRESSED.has('jpg'));
  assert.ok(PRECOMPRESSED.has('pdf'));
  assert.ok(!PRECOMPRESSED.has('svg'));
});

test('STREAMING: package builds without materialising files, memory stays flat', async () => {
  const nodes = Array.from({ length: 12 }, (_, i) => node(`1:${i}`, `asset-${i}`, null));
  const plan = buildPlan({ client: 'Acme', fileKey: 'X', fileName: 'F', nodes, matrix: STANDARD });

  // 1MB per file across 60 files = 60MB of payload.
  const ONE_MB = Buffer.alloc(1024 * 1024, 0x41);
  assert.equal(plan.files.length, 60);

  let sunkBytes = 0;
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      sunkBytes += chunk.length;
      cb();
    },
  });

  const before = process.memoryUsage().heapUsed;
  const result = await streamPackage({
    plan,
    tokens: EMPTY_TOKENS,
    sink,
    prefetchWindow: 4,
    fetchEntry: async () => ({ body: Readable.from([ONE_MB]) }),
  });
  const growthMb = (process.memoryUsage().heapUsed - before) / 1_048_576;

  assert.equal(result.manifest.length, 60 + 4 + 1, 'assets + token files + README');
  assert.ok(sunkBytes > 0 && result.zipBytes > 0);

  // 60MB streamed through; heap growth must stay far below the payload size.
  assert.ok(growthMb < 25, `heap grew ${growthMb.toFixed(1)}MB — files are being buffered`);
});

test('STREAMING: a failed entry is skipped and recorded, not fatal', async () => {
  const plan = buildPlan({
    client: 'Acme',
    fileKey: 'X',
    fileName: 'F',
    nodes: [node('1:2', 'logo-primary', null)],
    matrix: { ...STANDARD, colourways: ['full-colour'], formats: ['svg'], scales: [1] },
  });

  const sink = new Writable({ write: (_c, _e, cb) => cb() });
  const result = await streamPackage({
    plan,
    tokens: EMPTY_TOKENS,
    sink,
    fetchEntry: async () => ({ skip: true as const, reason: 'HTTP 500' }),
  });

  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0]?.reason, 'HTTP 500');
  // Token files and README are still produced.
  assert.equal(result.manifest.length, 5);
});

test('README reports skipped files so the designer is never surprised', () => {
  const plan = buildPlan({ client: 'Acme', fileKey: 'X', fileName: 'F', nodes: NODES, matrix: STANDARD });
  const text = buildReadme(plan, EMPTY_TOKENS, [{ path: '01 Logos/SVG/a.svg', reason: 'HTTP 500' }]).toString();

  assert.match(text, /1 file\(s\) could not be generated/);
  assert.match(text, /HTTP 500/);
});

// ---------------------------------------------------------------------------
// Source adapters — the engine must not be Figma-specific
// ---------------------------------------------------------------------------

test('ADAPTER: unsupported formats are dropped and reported, not attempted', () => {
  // Figma cannot produce EPS or CMYK at any price.
  const figmaCaps = {
    formats: new Set<Format>(['svg', 'png', 'jpg', 'pdf']),
    rateLimited: true,
    renderBudgetPerMinute: 10,
    maxMegapixels: 32,
  };
  const plan = buildPlan({
    client: 'Acme',
    fileKey: 'X',
    fileName: 'F',
    nodes: NODES,
    matrix: PRESETS['full-brand-package'] as ExportMatrix,
    capabilities: figmaCaps,
  });

  assert.deepEqual(plan.unsupportedFormats.sort(), ['eps', 'pdf-cmyk']);
  // Nothing was planned for a format the source can't make.
  assert.equal(plan.files.some((f) => PRINT_FORMATS.has(f.format)), false);
});

test('ADAPTER: a vector source plans the print formats Figma cannot', () => {
  const vectorCaps = {
    formats: new Set<Format>(['svg', 'png', 'jpg', 'pdf', 'eps', 'pdf-cmyk']),
    rateLimited: false,
  };
  const plan = buildPlan({
    client: 'Acme',
    fileKey: 'X',
    fileName: 'F',
    nodes: NODES,
    matrix: PRESETS['full-brand-package'] as ExportMatrix,
    capabilities: vectorCaps,
  });

  assert.equal(plan.unsupportedFormats.length, 0);
  assert.ok(plan.files.some((f) => f.format === 'eps'));
  assert.ok(plan.files.some((f) => f.format === 'pdf-cmyk'));
  // Local conversion is not rate limited, so no Tier 1 budget is consumed.
  assert.equal(plan.tier1Requests, 0);
});

test('ADAPTER: no megapixel ceiling means no downscale warnings', () => {
  const huge = [node('1:2', 'billboard', null, 9000, 9000)];
  // Figma caps at 32MP...
  assert.ok(checkMegapixels(huge, STANDARD, 32).length > 0);
  // ...local conversion has none. `null`, not `undefined` — a default
  // parameter fires on undefined and would silently reimpose the 32MP cap.
  assert.equal(checkMegapixels(huge, STANDARD, null).length, 0);
  // Omitting the argument still defaults to Figma's behaviour.
  assert.ok(checkMegapixels(huge, STANDARD).length > 0);
});

test('CMYK output is flagged unverified and cannot collide with the RGB PDF', () => {
  const vectorCaps = {
    formats: new Set<Format>(['pdf', 'pdf-cmyk']),
    rateLimited: false,
  };
  const plan = buildPlan({
    client: 'Acme',
    fileKey: 'X',
    fileName: 'F',
    nodes: [node('1:2', 'logo-primary', null)],
    matrix: {
      ...STANDARD,
      colourways: ['full-colour'],
      formats: ['pdf', 'pdf-cmyk'],
      scales: [1],
    },
    capabilities: vectorCaps,
  });

  const cmyk = plan.files.find((f) => f.format === 'pdf-cmyk');
  const rgb = plan.files.find((f) => f.format === 'pdf');

  assert.equal(cmyk?.colourUnverified, true);
  assert.equal(rgb?.colourUnverified, undefined);
  // Both are .pdf — the _cmyk suffix is what stops one overwriting the other.
  assert.ok(cmyk?.filename.endsWith('_cmyk.pdf'));
  assert.notEqual(cmyk?.path, rgb?.path);
});

test('README carries a prominent, wrapped CMYK colour warning', () => {
  const plan = buildPlan({
    client: 'Acme',
    fileKey: 'X',
    fileName: 'Acme masters',
    nodes: [node('1:2', 'logo-primary', null)],
    matrix: { ...STANDARD, colourways: ['full-colour'], formats: ['pdf-cmyk'], scales: [1] },
    capabilities: { formats: new Set<Format>(['pdf-cmyk']), rateLimited: false },
  });

  const text = buildReadme(plan, EMPTY_TOKENS).toString();
  assert.match(text, /IMPORTANT — CMYK FILES/);
  // Wrap-tolerant: the phrase may legitimately break across lines.
  assert.match(text, /NOT\s+colour-accurate/);
  // Source-neutral: must not claim a Figma origin for vector masters.
  assert.doesNotMatch(text, /from Figma file/);
  // Wrapped for readability in Notepad/Preview.
  for (const line of text.split('\n')) assert.ok(line.length <= 78, `long line: ${line}`);
});

test('svgDimensions prefers viewBox over width/height attributes', () => {
  assert.deepEqual(
    svgDimensions('<svg viewBox="0 0 400 200" width="100%" height="100%"/>'),
    { width: 400, height: 200 },
  );
  assert.deepEqual(
    svgDimensions('<svg width="800" height="600"/>'),
    { width: 800, height: 600 },
  );
  assert.equal(svgDimensions('<svg/>'), null);
});

// ---------------------------------------------------------------------------
// Delta detection
// ---------------------------------------------------------------------------

test('diffPackages classifies added, changed, removed and unchanged', () => {
  const prev = new Map([['a.svg', 'h1'], ['b.svg', 'h2'], ['c.svg', 'h3']]);
  const next = new Map([['a.svg', 'h1'], ['b.svg', 'CHANGED'], ['d.svg', 'h4']]);

  const diff = diffPackages(prev, next);
  assert.deepEqual(diff.unchanged, ['a.svg']);
  assert.deepEqual(diff.changed, ['b.svg']);
  assert.deepEqual(diff.added, ['d.svg']);
  assert.deepEqual(diff.removed, ['c.svg']);
});
