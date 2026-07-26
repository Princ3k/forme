/**
 * The Export Matrix — the core of the product.
 *
 * A designer marks a handful of nodes in Figma. The matrix fans those out into
 * the full cartesian product of colourways x formats x scales, names every
 * file, and assigns it a folder. This is the step that takes 4-5 hours by hand.
 */

import {
  RASTER_FORMATS,
  PRINT_FORMATS,
  MAX_RENDER_MEGAPIXELS,
  fileExtension,
  type ExportMatrix,
  type Format,
  type PlannedFile,
  type RenderBatch,
  type SourceNode,
  type GenerationPlan,
  type MegapixelWarning,
} from './types.js';

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

const STANDARD_FOLDERS: Record<Format, string> = {
  svg: '01 Logos/SVG',
  png: '01 Logos/PNG',
  jpg: '01 Logos/JPG',
  pdf: '01 Logos/PDF',
  eps: '05 Print/EPS',
  'pdf-cmyk': '05 Print/PDF (CMYK)',
};

export const PRESETS: Record<string, ExportMatrix> = {
  'standard-brand-package': {
    name: 'Standard Brand Package',
    colourways: ['full-colour', 'mono-black', 'mono-white'],
    formats: ['svg', 'png', 'pdf'],
    scales: [1, 2, 3],
    folderTemplate: STANDARD_FOLDERS,
    namingTemplate: '{client}_{asset}_{colourway}{scale}',
  },
  'logo-only': {
    name: 'Logo Only',
    colourways: ['full-colour'],
    formats: ['svg', 'png'],
    scales: [1, 2],
    folderTemplate: STANDARD_FOLDERS,
    namingTemplate: '{client}_{asset}{scale}',
  },
  'social-kit': {
    name: 'Social Kit',
    colourways: ['full-colour', 'mono-white'],
    formats: ['png'],
    scales: [1, 2, 3],
    folderTemplate: { ...STANDARD_FOLDERS, png: '04 Social/PNG' },
    namingTemplate: '{client}_{asset}_{colourway}{scale}',
  },
  /** Requires a vector-master source; Figma cannot produce EPS or CMYK. */
  'print-package': {
    name: 'Print Package',
    colourways: ['full-colour', 'mono-black', 'mono-white'],
    formats: ['svg', 'pdf', 'eps', 'pdf-cmyk'],
    scales: [1],
    folderTemplate: STANDARD_FOLDERS,
    namingTemplate: '{client}_{asset}_{colourway}',
  },
  /** Everything, digital and print. Vector-master source only. */
  'full-brand-package': {
    name: 'Full Brand Package',
    colourways: ['full-colour', 'mono-black', 'mono-white'],
    formats: ['svg', 'png', 'pdf', 'eps', 'pdf-cmyk'],
    scales: [1, 2, 3],
    folderTemplate: STANDARD_FOLDERS,
    namingTemplate: '{client}_{asset}_{colourway}{scale}',
  },
};

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    // Strip combining diacritical marks so "Café" folds to "cafe".
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Renders a filename from the naming template.
 *
 * `{scale}` renders as "" at 1x and "@2x"/"@3x" above, matching the convention
 * designers already use. Vector formats never carry a scale suffix.
 */
export function renderFilename(
  template: string,
  parts: { client: string; asset: string; colourway: string; format: Format; scale: number },
): string {
  const isRaster = RASTER_FORMATS.has(parts.format);
  const scaleSuffix = isRaster && parts.scale > 1 ? `@${parts.scale}x` : '';

  // CMYK output shares the .pdf extension, so it needs a distinguishing
  // suffix or it would collide with the RGB PDF in the same folder tree.
  const variantSuffix = parts.format === 'pdf-cmyk' ? '_cmyk' : '';

  const base = template
    .replace(/\{client\}/g, slugify(parts.client))
    .replace(/\{asset\}/g, slugify(parts.asset))
    .replace(/\{colourway\}/g, slugify(parts.colourway))
    .replace(/\{color\}/g, slugify(parts.colourway))
    .replace(/\{format\}/g, parts.format)
    .replace(/\{scale\}/g, scaleSuffix)
    // Collapse separators left behind by an empty token.
    .replace(/[_-]{2,}/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '');

  return `${base}${variantSuffix}.${fileExtension(parts.format)}`;
}

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

/**
 * Resolves which Figma node should be rendered for a given (asset, colourway).
 *
 * Approach A from the PRD: if the designer drew the variant themselves
 * (`@export/logo-primary/mono-black`) we use that node. If they did not, the
 * combination is reported as unresolved rather than silently faked — a wrongly
 * recoloured logo is worse than a missing one.
 */
function resolveNode(nodes: SourceNode[], assetSlug: string, colourway: string): SourceNode | null {
  const variant = nodes.find((n) => n.assetSlug === assetSlug && n.colourway === colourway);
  if (variant) return variant;

  // The base node serves the default colourway only.
  const base = nodes.find((n) => n.assetSlug === assetSlug && n.colourway === null);
  if (base && (colourway === 'full-colour' || colourway === 'default')) return base;

  return null;
}

export interface ExpansionResult {
  files: PlannedFile[];
  /** (asset, colourway) pairs with no matching node in Figma. */
  unresolved: Array<{ assetSlug: string; colourway: string }>;
}

export function expandMatrix(
  nodes: SourceNode[],
  matrix: ExportMatrix,
  client: string,
): ExpansionResult {
  const assetSlugs = [...new Set(nodes.map((n) => n.assetSlug))].sort();
  const files: PlannedFile[] = [];
  const unresolved: Array<{ assetSlug: string; colourway: string }> = [];
  const seenPaths = new Set<string>();

  for (const assetSlug of assetSlugs) {
    for (const colourway of matrix.colourways) {
      const node = resolveNode(nodes, assetSlug, colourway);
      if (!node) {
        unresolved.push({ assetSlug, colourway });
        continue;
      }

      for (const format of matrix.formats) {
        // Vector formats render once; only raster formats multiply by scale.
        const scales = RASTER_FORMATS.has(format) ? matrix.scales : [1];

        for (const scale of scales) {
          const filename = renderFilename(matrix.namingTemplate, {
            client,
            asset: assetSlug,
            colourway,
            format,
            scale,
          });
          const folderPath = matrix.folderTemplate[format];
          const path = `${folderPath}/${filename}`;

          // Guard against a naming template that collapses two distinct
          // variants onto the same filename — silent overwrites in a client
          // deliverable are unacceptable.
          if (seenPaths.has(path)) continue;
          seenPaths.add(path);

          files.push({
            sourceNodeId: node.nodeId,
            assetSlug,
            colourway,
            format,
            scale,
            filename,
            folderPath,
            path,
            // Machine-converted CMYK is structurally valid but not colour
            // accurate. Flagged so the README and UI can say so plainly.
            ...(format === 'pdf-cmyk' ? { colourUnverified: true } : {}),
          });
        }
      }
    }
  }

  return { files, unresolved };
}

/**
 * Groups the file plan into render batches — one Figma /v1/images call per
 * (format, scale) pair, carrying every node id needed for that pair.
 *
 * This is the single most important function in the codebase. A per-file
 * implementation would need one Tier 1 request per output file; at 10 requests
 * per minute a 200-file package would take twenty minutes of pure waiting.
 * Batched, the same package costs five requests.
 */
export function planBatches(files: PlannedFile[]): RenderBatch[] {
  const groups = new Map<string, RenderBatch>();

  for (const file of files) {
    const key = `${file.format}@${file.scale}`;
    let batch = groups.get(key);
    if (!batch) {
      batch = { format: file.format, scale: file.scale, nodeIds: [] };
      groups.set(key, batch);
    }
    if (!batch.nodeIds.includes(file.sourceNodeId)) {
      batch.nodeIds.push(file.sourceNodeId);
    }
  }

  return [...groups.values()];
}

/**
 * Flags renders that Figma would silently scale down.
 *
 * Figma caps image exports at 32 megapixels and quietly downscales anything
 * larger rather than returning an error. A 3500x3500 artboard at @3x is
 * 110 megapixels — the client receives a soft logo and nobody is told. This is
 * exactly the kind of defect that shows up as rework rather than as a failure,
 * so it is surfaced at plan time, before anything renders.
 */
export function checkMegapixels(
  nodes: SourceNode[],
  matrix: ExportMatrix,
  /**
   * Ceiling to enforce. `null` means the source has none — local conversion
   * rasterises at any size, so only Figma triggers this. Omitting the argument
   * defaults to Figma's 32MP.
   *
   * `null` rather than `undefined` because a default parameter fires on
   * `undefined`, which would make "no ceiling" silently become "32MP".
   */
  ceiling: number | null = MAX_RENDER_MEGAPIXELS,
): MegapixelWarning[] {
  const warnings: MegapixelWarning[] = [];
  if (ceiling === null) return warnings;
  const hasRaster = matrix.formats.some((f) => RASTER_FORMATS.has(f));
  if (!hasRaster) return warnings;

  const seen = new Set<string>();

  for (const node of nodes) {
    if (!node.width || !node.height) continue;

    for (const scale of matrix.scales) {
      const megapixels = (node.width * scale * node.height * scale) / 1_000_000;
      if (megapixels <= ceiling) continue;

      const key = `${node.assetSlug}@${scale}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const maxSafeScale =
        Math.floor(Math.sqrt((ceiling * 1_000_000) / (node.width * node.height)) * 100) / 100;

      warnings.push({
        assetSlug: node.assetSlug,
        scale,
        megapixels: Math.round(megapixels * 10) / 10,
        maxSafeScale,
      });
    }
  }

  return warnings;
}

/** What a source can do. Mirrors AdapterCapabilities without importing it. */
export interface PlanCapabilities {
  formats: ReadonlySet<Format>;
  rateLimited: boolean;
  renderBudgetPerMinute?: number;
  maxMegapixels?: number;
}

const FIGMA_DEFAULT_CAPS: PlanCapabilities = {
  formats: new Set<Format>(['svg', 'png', 'jpg', 'pdf']),
  rateLimited: true,
  renderBudgetPerMinute: 10,
  maxMegapixels: MAX_RENDER_MEGAPIXELS,
};

/**
 * Builds the full plan against a given source's capabilities.
 *
 * Formats the source cannot produce are dropped from the plan and reported,
 * rather than attempted and failed one file at a time. A designer asking a
 * Figma project for EPS should be told once, up front — not handed a package
 * with 30 missing files.
 */
export function buildPlan(args: {
  client: string;
  fileKey: string;
  fileName: string;
  nodes: SourceNode[];
  matrix: ExportMatrix;
  capabilities?: PlanCapabilities;
}): GenerationPlan & {
  unresolved: ExpansionResult['unresolved'];
  unsupportedFormats: Format[];
} {
  const caps = args.capabilities ?? FIGMA_DEFAULT_CAPS;

  const unsupportedFormats = args.matrix.formats.filter((f) => !caps.formats.has(f));
  const usableMatrix: ExportMatrix =
    unsupportedFormats.length > 0
      ? { ...args.matrix, formats: args.matrix.formats.filter((f) => caps.formats.has(f)) }
      : args.matrix;

  const { files, unresolved } = expandMatrix(args.nodes, usableMatrix, args.client);
  const batches = planBatches(files);

  // Rate-limited sources pay 1 GET file + 1 render call per batch, all Tier 1.
  // Local conversion pays nothing, so the estimate is CPU-bound, not API-bound.
  const tier1Requests = caps.rateLimited ? 1 + batches.length : 0;
  const perMinute = caps.renderBudgetPerMinute ?? 10;
  const estimatedMinutes = caps.rateLimited
    ? Math.max(0.5, tier1Requests / perMinute)
    : Math.max(0.1, files.length / 120); // ~2 conversions/sec, measured

  return {
    client: args.client,
    fileKey: args.fileKey,
    fileName: args.fileName,
    sourceNodes: args.nodes,
    files,
    batches,
    tier1Requests,
    estimatedMinutes,
    // A source with no declared ceiling genuinely has none — map to null so
    // the default parameter does not quietly reimpose Figma's 32MP.
    megapixelWarnings: checkMegapixels(args.nodes, usableMatrix, caps.maxMegapixels ?? null),
    unresolved,
    unsupportedFormats,
  };
}
