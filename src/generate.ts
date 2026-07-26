/**
 * The generation pipeline — source-agnostic.
 *
 * This function knows nothing about Figma. It asks a SourceAdapter what assets
 * exist, expands the Export Matrix against that source's capabilities, and
 * streams the result into a package. Swapping Figma for local vector masters
 * changes one constructor call and nothing else.
 *
 * In production each stage becomes an Inngest step. Two constraints shape it:
 *
 * 1. It cannot run in a request handler — a large package takes minutes, and
 *    rate-limit backoff adds more.
 * 2. Nothing is buffered. Downloads stream through the zip into the sink, so
 *    memory stays flat regardless of package size. Step *outputs* must also
 *    stay small: pass object keys and manifests, never file contents.
 */

import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import type { Writable } from 'node:stream';
import { join } from 'node:path';
import { buildPlan, PRESETS } from './matrix.js';
import { streamPackage, type ManifestEntry } from './packager.js';
import type { SourceAdapter } from './adapter.js';
import type { ExportMatrix, Format, GenerationPlan, MegapixelWarning } from './types.js';

export interface GenerateOptions {
  source: SourceAdapter;
  client: string;
  matrix?: ExportMatrix;
  /**
   * Where the zip is written. Locally a file stream; in production an S3
   * multipart upload stream (Supabase Storage exposes an S3-compatible
   * endpoint, so `@aws-sdk/lib-storage`'s `Upload` works against either).
   */
  sink?: Writable;
  outDir?: string;
  /** In-flight fetches. Bounds peak memory. */
  prefetchWindow?: number;
  onProgress?: (stage: string, detail: string) => void;
}

export interface GenerateResult {
  plan: GenerationPlan;
  sourceLabel: string;
  manifest: ManifestEntry[];
  unresolved: Array<{ assetSlug: string; colourway: string }>;
  unsupportedFormats: Format[];
  skipped: Array<{ path: string; reason: string }>;
  megapixelWarnings: MegapixelWarning[];
  /** Files whose colour was machine-converted and is not trustworthy. */
  colourUnverifiedCount: number;
  zipPath: string | null;
  zipBytes: number;
  durationMs: number;
  /** Peak RSS observed during the run, to demonstrate the memory bound. */
  peakRssMb: number;
}

export async function generate(opts: GenerateOptions): Promise<GenerateResult> {
  const started = Date.now();
  const progress = opts.onProgress ?? ((): void => {});
  const matrix = opts.matrix ?? (PRESETS['standard-brand-package'] as ExportMatrix);
  const { source } = opts;
  const caps = source.capabilities;

  let peakRss = process.memoryUsage().rss;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 100);

  try {
    // --- Step 1: identify the source --------------------------------------
    progress('source', `${caps.label}${caps.rateLimited ? '' : ' (no rate limit)'}`);
    const sourceLabel = await source.describe();

    // --- Step 2: discover marked assets -----------------------------------
    progress('parsing', 'Finding marked assets');
    const nodes = await source.discover();
    if (nodes.length === 0) {
      throw new Error(
        `No assets marked for export in ${caps.label}. ` +
          'For Figma, mark frames with the plugin or an "@export/" prefix. ' +
          'For vector masters, name files "<asset>.svg" or "<asset>.<colourway>.svg".',
      );
    }
    const viaPlugin = nodes.filter((n) => n.markedBy === 'plugin').length;
    progress(
      'parsing',
      `${nodes.length} assets${viaPlugin > 0 ? ` (${viaPlugin} via plugin)` : ''}`,
    );

    // --- Step 3: tokens ----------------------------------------------------
    progress('parsing', 'Extracting colour and type tokens');
    const tokens = await source.extractTokens();

    // --- Step 4: expand the matrix against this source's capabilities ------
    const plan = buildPlan({
      client: opts.client,
      fileKey: sourceLabel,
      fileName: sourceLabel,
      nodes,
      matrix,
      capabilities: caps,
    });

    if (plan.unsupportedFormats.length > 0) {
      progress(
        'warning',
        `${caps.label} cannot produce ${plan.unsupportedFormats.join(', ')} — ` +
          'dropped from this package. Use a vector-master source for print formats.',
      );
    }

    progress(
      'planning',
      caps.rateLimited
        ? `${plan.files.length} files, ${plan.batches.length} render batches, ~${plan.tier1Requests} Tier 1 requests`
        : `${plan.files.length} files, converted locally`,
    );

    for (const w of plan.megapixelWarnings) {
      progress(
        'warning',
        `${w.assetSlug} at @${w.scale}x is ${w.megapixels}MP — the source silently ` +
          `downscales above ${caps.maxMegapixels}MP. Max safe scale: @${w.maxSafeScale}x`,
      );
    }

    const colourUnverifiedCount = plan.files.filter((f) => f.colourUnverified).length;
    if (colourUnverifiedCount > 0) {
      progress(
        'warning',
        `${colourUnverifiedCount} CMYK file(s) machine-converted from RGB — ` +
          'colour values are NOT print-accurate and must be replaced.',
      );
    }

    // --- Step 5: let the source prefetch (batched API calls, or a no-op) ---
    await source.prepare(plan.batches, (msg) => progress('rendering', msg));

    // --- Step 6-8: stream everything into the package ---------------------
    let sink = opts.sink;
    let zipPath: string | null = null;
    if (!sink) {
      const outDir = opts.outDir ?? './out';
      await mkdir(outDir, { recursive: true });
      zipPath = join(
        outDir,
        `${opts.client.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-brand-package.zip`,
      );
      sink = createWriteStream(zipPath);
    }

    progress('packaging', `Streaming ${plan.files.length} files into zip`);
    const { manifest, skipped, zipBytes } = await streamPackage({
      plan,
      tokens,
      sink,
      fetchEntry: (file) => source.fetch(file),
      prefetchWindow: opts.prefetchWindow ?? 6,
      onProgress: (done, total) => {
        if (done % 25 === 0 || done === total) progress('packaging', `${done}/${total} files`);
      },
    });

    progress('complete', `${manifest.length} files, ${(zipBytes / 1_048_576).toFixed(1)} MB`);

    return {
      plan,
      sourceLabel,
      manifest,
      unresolved: plan.unresolved,
      unsupportedFormats: plan.unsupportedFormats,
      skipped,
      megapixelWarnings: plan.megapixelWarnings,
      colourUnverifiedCount,
      zipPath,
      zipBytes,
      durationMs: Date.now() - started,
      peakRssMb: Math.round((peakRss / 1_048_576) * 10) / 10,
    };
  } finally {
    clearInterval(sampler);
    await source.dispose?.();
  }
}
