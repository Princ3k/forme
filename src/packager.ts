/**
 * Packaging: streams rendered assets into a structured, documented zip without
 * ever holding the package in memory or on disk.
 *
 * Every entry is appended to a live zip stream that pipes straight to a sink.
 * Peak memory is bounded by the prefetch window times the largest single file
 * — a few MB — regardless of whether the package is 40 files or 400.
 */

import { createHash } from 'node:crypto';
import archiver from 'archiver';
import type { Readable, Writable } from 'node:stream';
import { HashingPassThrough, orderedPrefetch, onceClosed } from './stream.js';
import { PRINT_FORMATS, CMYK_WARNING } from './types.js';
import type { ExtractedTokens, GenerationPlan, PlannedFile, Format } from './types.js';

/**
 * Formats whose bytes are already compressed. Running deflate over them costs
 * CPU (which is billed, on serverless) for effectively zero size reduction, so
 * they are stored rather than deflated. SVG, JSON and TXT compress well and
 * are deflated normally.
 */
const PRECOMPRESSED: ReadonlySet<Format> = new Set<Format>(['png', 'jpg', 'pdf', 'pdf-cmyk']);

export interface ManifestEntry {
  path: string;
  bytes: number;
  /** SHA-256, computed in flight. Used for delta detection on regeneration. */
  contentHash: string;
}

export function hashContent(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Supplies the bytes for one planned file as a stream. */
export type EntrySource = (
  file: PlannedFile,
) => Promise<{ body: Readable; skip?: false } | { body?: undefined; skip: true; reason: string }>;

export interface StreamPackageOptions {
  plan: GenerationPlan;
  tokens: ExtractedTokens;
  /** Where the finished zip goes. A file stream locally; an S3 upload stream in production. */
  sink: Writable;
  fetchEntry: EntrySource;
  /** Concurrent in-flight downloads. Bounds peak memory. */
  prefetchWindow?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface StreamPackageResult {
  manifest: ManifestEntry[];
  skipped: Array<{ path: string; reason: string }>;
  zipBytes: number;
}

/**
 * Builds the package as a single pass over the file plan.
 *
 * Ordering note: zip entries must be appended one at a time, so the download
 * concurrency is provided by `orderedPrefetch`, which keeps N requests in
 * flight while still yielding them in plan order.
 */
export async function streamPackage(opts: StreamPackageOptions): Promise<StreamPackageResult> {
  const { plan, tokens, sink, fetchEntry } = opts;
  const progress = opts.onProgress ?? ((): void => {});

  const archive = archiver('zip', { zlib: { level: 6 } });
  const closed = onceClosed(sink);
  archive.pipe(sink);

  const manifest: ManifestEntry[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];

  // Appends one entry and waits for archiver to finish consuming it, so the
  // internal queue cannot grow without bound.
  const appendAndWait = (
    source: Readable | Buffer,
    name: string,
    store: boolean,
  ): Promise<void> =>
    new Promise((resolve, reject) => {
      const onEntry = (): void => {
        archive.off('error', onError);
        resolve();
      };
      const onError = (err: Error): void => {
        archive.off('entry', onEntry);
        reject(err);
      };
      archive.once('entry', onEntry);
      archive.once('error', onError);
      archive.append(source, { name, store });
    });

  let done = 0;

  for await (const item of orderedPrefetch(
    plan.files,
    opts.prefetchWindow ?? 6,
    async (file: PlannedFile) => ({ file, result: await fetchEntry(file) }),
  )) {
    const { file, result } = item;

    if (result.skip) {
      skipped.push({ path: file.path, reason: result.reason });
      continue;
    }

    // Hash in flight rather than buffering the file to hash it afterwards.
    const hasher = new HashingPassThrough();
    result.body.on('error', (err) => hasher.destroy(err));
    result.body.pipe(hasher);

    await appendAndWait(hasher, file.path, PRECOMPRESSED.has(file.format));

    manifest.push({ path: file.path, bytes: hasher.bytes, contentHash: hasher.digest() });
    progress(++done, plan.files.length);
  }

  // Generated text files are small, so buffers are fine here.
  for (const entry of buildTokenFiles(plan.client, tokens)) {
    await appendAndWait(entry.contents, entry.path, false);
    manifest.push({
      path: entry.path,
      bytes: entry.contents.byteLength,
      contentHash: hashContent(entry.contents),
    });
  }

  const readme = buildReadme(plan, tokens, skipped);
  await appendAndWait(readme, 'README.txt', false);
  manifest.push({ path: 'README.txt', bytes: readme.byteLength, contentHash: hashContent(readme) });

  await archive.finalize();
  await closed;

  return { manifest, skipped, zipBytes: archive.pointer() };
}

// ---------------------------------------------------------------------------
// Generated text files
// ---------------------------------------------------------------------------

function slug(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Wraps prose to a fixed width. The README is read in Notepad and Preview. */
function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';

  for (const word of words) {
    if (line.length === 0) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line.length > 0) lines.push(line);

  return lines;
}

export function buildTokenFiles(
  client: string,
  tokens: ExtractedTokens,
): Array<{ path: string; contents: Buffer }> {
  const s = slug(client);

  const colourTxt = [
    `${client} — Colour Palette`,
    '='.repeat(40),
    '',
    ...tokens.colours.map(
      (c) => `${c.name}\n  HEX  ${c.hex}\n  RGB  ${c.rgb.r}, ${c.rgb.g}, ${c.rgb.b}\n`,
    ),
    tokens.colours.length === 0 ? '(No colour styles were found in the source.)' : '',
    '',
    'Note: these are RGB values. CMYK and Pantone equivalents cannot be derived',
    'automatically with any accuracy and must be specified by your designer.',
    '',
  ].join('\n');

  const typeTxt = [
    `${client} — Typography`,
    '='.repeat(40),
    '',
    ...tokens.typography.map(
      (t) =>
        `${t.name}\n  Font    ${t.fontFamily}\n  Weight  ${t.fontWeight}\n  Size    ${t.fontSize}px\n  Line    ${t.lineHeightPx ?? 'auto'}\n`,
    ),
    tokens.typography.length === 0 ? '(No local text styles found in this Figma file.)' : '',
    '',
  ].join('\n');

  return [
    { path: `02 Colour/${s}-colour-palette.json`, contents: Buffer.from(JSON.stringify(tokens.colours, null, 2)) },
    { path: `02 Colour/${s}-colour-palette.txt`, contents: Buffer.from(colourTxt) },
    { path: `03 Typography/${s}-typography.json`, contents: Buffer.from(JSON.stringify(tokens.typography, null, 2)) },
    { path: `03 Typography/${s}-typography.txt`, contents: Buffer.from(typeTxt) },
  ];
}

/**
 * The README is a small feature doing a lot of work: it is what stops the
 * client emailing the designer to ask which file to use.
 */
export function buildReadme(
  plan: GenerationPlan,
  tokens: ExtractedTokens,
  skipped: Array<{ path: string; reason: string }> = [],
): Buffer {
  const byFolder = new Map<string, number>();
  for (const f of plan.files) byFolder.set(f.folderPath, (byFolder.get(f.folderPath) ?? 0) + 1);

  const cmykFiles = plan.files.filter((f) => f.colourUnverified);
  const hasPrint = plan.files.some((f) => PRINT_FORMATS.has(f.format));

  const lines = [
    `${plan.client} — Brand Asset Package`,
    '='.repeat(50),
    '',
    // Source-neutral: this package may come from Figma or from vector masters.
    `Generated ${new Date().toISOString().slice(0, 10)} from "${plan.fileName}".`,
    `${plan.files.length - skipped.length} asset files.`,
    '',
    'WHAT IS IN HERE',
    '-'.repeat(50),
    ...[...byFolder.entries()].sort().map(([folder, count]) => `  ${folder}  (${count} files)`),
    '  02 Colour/       colour palette, as JSON and plain text',
    '  03 Typography/   type styles, as JSON and plain text',
    '',
    'WHICH FILE SHOULD I USE?',
    '-'.repeat(50),
    '  SVG   Websites, and anything that needs to scale cleanly. Use this by',
    '        default for digital.',
    '  PNG   Slides, documents, social posts. Transparent background.',
    '        @2x and @3x are for high-resolution screens.',
    '  PDF   Print, and sending to a printer or signmaker.',
    '',
    'COLOURWAYS',
    '-'.repeat(50),
    '  full-colour   The primary brand mark. Use this wherever possible.',
    '  mono-black    One colour, for light backgrounds.',
    '  mono-white    One colour, for dark backgrounds and photography.',
    '',
    'COLOUR VALUES',
    '-'.repeat(50),
    ...(tokens.colours.length > 0
      ? tokens.colours.map((c) => `  ${c.name.padEnd(28)} ${c.hex}`)
      : ['  (No local colour styles were found in the source Figma file.)']),
    '',
    ...(cmykFiles.length > 0
      ? [
          '*** IMPORTANT — CMYK FILES ***',
          '-'.repeat(50),
          '  This package contains machine-converted CMYK files in 05 Print/.',
          '',
          ...wrap(CMYK_WARNING, 68).map((l) => `  ${l}`),
          '',
          '  The geometry is correct and safe to use. The COLOUR is not. Sending',
          '  these to a printer without checking will produce the wrong brand',
          '  colours.',
          '',
          `  Affected: ${cmykFiles.length} file(s).`,
          '',
        ]
      : []),
    'LIMITATIONS',
    '-'.repeat(50),
    ...(hasPrint
      ? ['  Pantone/spot colour values are not included and must be specified', '  by your designer.']
      : [
          '  EPS and CMYK files are not included — they cannot be produced from',
          '  this source. Ask your designer for print-native files if you need them.',
        ]),
    ...(skipped.length > 0
      ? ['', `  ${skipped.length} file(s) could not be generated:`, ...skipped.map((s) => `    ${s.path} — ${s.reason}`)]
      : []),
    '',
  ];

  return Buffer.from(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// Delta detection
// ---------------------------------------------------------------------------

export interface PackageDiff {
  added: string[];
  changed: string[];
  removed: string[];
  unchanged: string[];
}

/**
 * Compares a new package against the previously delivered one so the designer
 * sees exactly what will change before anything reaches the client.
 */
export function diffPackages(
  previous: Map<string, string>,
  next: Map<string, string>,
): PackageDiff {
  const diff: PackageDiff = { added: [], changed: [], removed: [], unchanged: [] };

  for (const [path, hash] of next) {
    const prevHash = previous.get(path);
    if (prevHash === undefined) diff.added.push(path);
    else if (prevHash !== hash) diff.changed.push(path);
    else diff.unchanged.push(path);
  }
  for (const path of previous.keys()) {
    if (!next.has(path)) diff.removed.push(path);
  }

  return diff;
}

export { PRECOMPRESSED };
