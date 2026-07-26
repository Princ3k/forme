#!/usr/bin/env node
/**
 * Handoff prototype CLI.
 *
 *   handoff plan     --client "Acme" [--preset standard-brand-package]
 *   handoff generate --client "Acme" --figma <url-or-key>
 *   handoff generate --client "Acme" --vectors ./masters [--preset full-brand-package]
 *   handoff doctor
 *
 * `plan` runs offline against a demo asset set — use it to show a designer the
 * shape of the output before asking for anything.
 *
 * `generate` takes either source. The Figma path needs FIGMA_TOKEN and inherits
 * Figma's limits; the vector path needs only a folder of SVGs and can produce
 * EPS and CMYK, which Figma cannot.
 */

import { parseFileKey } from './figma.js';
import { buildPlan, PRESETS, expandMatrix, planBatches, slugify } from './matrix.js';
import { generate } from './generate.js';
import { checkToolchain } from './convert.js';
import { FigmaAdapter } from './adapters/figma-adapter.js';
import { VectorAdapter } from './adapters/vector-adapter.js';
import type { ExportMatrix, SourceNode } from './types.js';

const d = (
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

const DEMO_NODES: SourceNode[] = [
  d('1:2', 'logo-primary', null),
  d('1:3', 'logo-primary', 'mono-black'),
  d('1:4', 'logo-primary', 'mono-white'),
  d('1:5', 'logo-secondary', null),
  d('1:6', 'logo-secondary', 'mono-black'),
  d('1:7', 'submark', null),
  d('1:8', 'submark', 'mono-black'),
  d('1:9', 'submark', 'mono-white'),
  // A large artboard, to demonstrate the 32MP downscale warning at @3x.
  d('1:10', 'wordmark', null, 4000, 1200),
];

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function resolveMatrix(name: string | undefined): ExportMatrix {
  const key = name ?? 'standard-brand-package';
  const matrix = PRESETS[key];
  if (!matrix) {
    throw new Error(`Unknown preset "${key}". Available: ${Object.keys(PRESETS).join(', ')}`);
  }
  return matrix;
}

async function cmdDoctor(): Promise<void> {
  const { ok, missing } = await checkToolchain();
  console.log('\n  Vector conversion toolchain');
  console.log(`  ${'─'.repeat(58)}`);
  if (ok) {
    console.log('  All present — SVG, PNG, PDF, EPS and CMYK PDF available.\n');
  } else {
    console.log('  Missing:');
    for (const m of missing) console.log(`    ${m}`);
    console.log('\n  The Figma source still works without these; only the vector');
    console.log('  source and print formats need them.\n');
  }
}

function cmdPlan(argv: string[]): void {
  const client = arg(argv, 'client') ?? 'Acme';
  const matrix = resolveMatrix(arg(argv, 'preset'));

  const plan = buildPlan({
    client,
    fileKey: 'DEMO',
    fileName: 'Demo Brand File',
    nodes: DEMO_NODES,
    matrix,
  });

  console.log(`\n  ${client} — ${matrix.name}`);
  console.log(`  ${'─'.repeat(58)}`);
  console.log(`  Source assets marked           ${DEMO_NODES.length}`);
  console.log(`  Output files generated         ${plan.files.length}`);
  console.log(`  Render calls needed            ${plan.batches.length}`);
  console.log(`  Total Tier 1 requests          ${plan.tier1Requests}  (budget: 10/min)`);
  console.log(`  Estimated time                 ~${plan.estimatedMinutes.toFixed(1)} min`);
  console.log(`\n  Without batching this would need ${plan.files.length + 1} Tier 1 requests`);
  console.log(`  — about ${((plan.files.length + 1) / 10).toFixed(0)} minutes of pure rate-limit waiting.\n`);

  if (plan.unsupportedFormats.length > 0) {
    console.log(`  NOT AVAILABLE FROM FIGMA`);
    console.log(`  ${'─'.repeat(58)}`);
    console.log(`  ${plan.unsupportedFormats.join(', ')} — dropped from this plan.`);
    console.log(`  Use --vectors with a folder of SVG masters to produce these.\n`);
  }

  const byFolder = new Map<string, string[]>();
  for (const f of plan.files) {
    const list = byFolder.get(f.folderPath) ?? [];
    list.push(f.filename);
    byFolder.set(f.folderPath, list);
  }

  console.log(`  PACKAGE STRUCTURE`);
  console.log(`  ${'─'.repeat(58)}`);
  for (const [folder, names] of [...byFolder.entries()].sort()) {
    console.log(`  ${folder}/  (${names.length})`);
    for (const n of names.slice(0, 4)) console.log(`      ${n}`);
    if (names.length > 4) console.log(`      … and ${names.length - 4} more`);
  }
  const clientSlug = slugify(client);
  console.log(`  02 Colour/  (2)\n      ${clientSlug}-colour-palette.json / .txt`);
  console.log(`  03 Typography/  (2)\n      ${clientSlug}-typography.json / .txt`);
  console.log(`  README.txt`);

  if (plan.megapixelWarnings.length > 0) {
    console.log(`\n  SILENT DOWNSCALE WARNING`);
    console.log(`  ${'─'.repeat(58)}`);
    for (const w of plan.megapixelWarnings) {
      console.log(`  ${w.assetSlug} at @${w.scale}x = ${w.megapixels}MP (Figma caps at 32MP)`);
      console.log(`      Figma will downscale this without reporting an error.`);
      console.log(`      Max safe scale for this artboard: @${w.maxSafeScale}x`);
    }
  }

  if (plan.unresolved.length > 0) {
    console.log(`\n  UNRESOLVED — no matching asset`);
    console.log(`  ${'─'.repeat(58)}`);
    for (const u of plan.unresolved) {
      console.log(`  ${u.assetSlug} / ${u.colourway}`);
      console.log(`      add a layer named "@export/${u.assetSlug}/${u.colourway}"`);
    }
    console.log(
      `\n  These are reported rather than auto-generated. Recolouring an SVG\n` +
        `  automatically breaks on gradients and embedded images, and a mangled\n` +
        `  logo reaching a client is worse than a missing file.`,
    );
  }
  console.log('');
}

async function cmdGenerate(argv: string[]): Promise<void> {
  const client = arg(argv, 'client') ?? 'Client';
  const matrix = resolveMatrix(arg(argv, 'preset'));
  const outDir = arg(argv, 'out') ?? './out';

  const figmaArg = arg(argv, 'figma') ?? arg(argv, 'file');
  const vectorsArg = arg(argv, 'vectors');

  if (!figmaArg && !vectorsArg) {
    console.error('Pass either --figma <url-or-key> or --vectors <folder>');
    process.exit(1);
  }

  let source;
  if (vectorsArg) {
    const { ok, missing } = await checkToolchain();
    if (!ok) {
      console.error(`\n  Missing conversion tools:\n${missing.map((m) => `    ${m}`).join('\n')}\n`);
      process.exit(1);
    }
    source = new VectorAdapter(vectorsArg);
  } else {
    const token = process.env['FIGMA_TOKEN'];
    if (!token) {
      console.error('Set FIGMA_TOKEN (a personal access token) in your environment.');
      process.exit(1);
    }
    source = new FigmaAdapter(token, parseFileKey(figmaArg as string));
  }

  const result = await generate({
    source,
    client,
    matrix,
    outDir,
    onProgress: (stage, detail) => console.log(`  [${stage}] ${detail}`),
  });

  console.log(`\n  Done in ${(result.durationMs / 1000).toFixed(1)}s`);
  console.log(`  Source: ${result.sourceLabel}`);
  console.log(`  ${result.manifest.length} files → ${result.zipPath}`);
  console.log(`  ${(result.zipBytes / 1_048_576).toFixed(2)} MB zip`);
  console.log(`  Peak memory: ${result.peakRssMb} MB`);

  if (result.unsupportedFormats.length > 0) {
    console.log(`\n  Formats unavailable from this source: ${result.unsupportedFormats.join(', ')}`);
  }
  if (result.colourUnverifiedCount > 0) {
    console.log(`\n  ${result.colourUnverifiedCount} CMYK file(s) machine-converted —`);
    console.log(`  colour is NOT print-accurate. Flagged in README.txt.`);
  }
  if (result.unresolved.length > 0) {
    console.log(`\n  ${result.unresolved.length} variants had no matching asset:`);
    for (const u of result.unresolved) console.log(`    ${u.assetSlug} / ${u.colourway}`);
  }
  if (result.skipped.length > 0) {
    console.log(`\n  ${result.skipped.length} files skipped:`);
    for (const f of result.skipped) console.log(`    ${f.path} — ${f.reason}`);
  }
  console.log('');
}

async function main(): Promise<void> {
  const [, , command = 'plan', ...rest] = process.argv;

  switch (command) {
    case 'plan':
      cmdPlan(rest);
      break;
    case 'generate':
      await cmdGenerate(rest);
      break;
    case 'doctor':
      await cmdDoctor();
      break;
    default:
      console.error(`Unknown command "${command}". Use "plan", "generate" or "doctor".`);
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

export { expandMatrix, planBatches, buildPlan, PRESETS };
