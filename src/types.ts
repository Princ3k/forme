/** Shared domain types for the Handoff core engine. */

export type Format = 'svg' | 'png' | 'jpg' | 'pdf' | 'eps' | 'pdf-cmyk';

/** Formats that rasterise at a scale factor. Vector formats render once. */
export const RASTER_FORMATS: ReadonlySet<Format> = new Set<Format>(['png', 'jpg']);

/**
 * Print-native formats. Figma cannot produce any of these — they require a
 * vector master and a local conversion toolchain, which is the main reason the
 * engine is not Figma-only.
 */
export const PRINT_FORMATS: ReadonlySet<Format> = new Set<Format>(['eps', 'pdf-cmyk']);

/** On-disk extension for a format. `pdf-cmyk` is still a .pdf file. */
export function fileExtension(format: Format): string {
  return format === 'pdf-cmyk' ? 'pdf' : format;
}

/**
 * A source node marked for export in the Figma file.
 *
 * The base node is discovered by the `@export/<slug>` naming convention.
 * A colourway variant is a node named `@export/<slug>/<colourway>` — the
 * designer has drawn the mono/reversed version themselves. This is
 * "approach A" from the PRD: zero risk, no automated recolouring.
 */
export interface SourceNode {
  /** Figma node id, e.g. "1:23" */
  nodeId: string;
  /** Raw layer name in Figma */
  nodeName: string;
  /** Slug, from plugin data if present, otherwise parsed from the layer name */
  assetSlug: string;
  /** Colourway this node represents, or null if it is the base node */
  colourway: string | null;
  /** How this node was marked. Plugin data is authoritative over the name prefix. */
  markedBy: 'plugin' | 'prefix';
  /** Frame dimensions in px, used for the 32MP downscale check. */
  width?: number;
  height?: number;
}

/**
 * Figma silently scales down any render above 32 megapixels rather than
 * failing. A large artboard at @3x can cross that line and ship a degraded
 * asset with no error anywhere — so it is checked at plan time.
 */
export const MAX_RENDER_MEGAPIXELS = 32;

export interface MegapixelWarning {
  assetSlug: string;
  scale: number;
  megapixels: number;
  /** Largest scale that stays under the ceiling for this node. */
  maxSafeScale: number;
}

/**
 * The Export Matrix: the reusable per-client spec that turns a handful of
 * marked nodes into a complete deliverable package.
 */
export interface ExportMatrix {
  name: string;
  colourways: string[];
  formats: Format[];
  /** Applied to raster formats only. Vector formats always render once. */
  scales: number[];
  /** Maps a format to the folder it lands in, under the asset section. */
  folderTemplate: Record<Format, string>;
  /** e.g. "{client}_{asset}_{colourway}{scale}" */
  namingTemplate: string;
}

/**
 * One planned output file. The full set of these is the "file plan" —
 * computed before a single byte is fetched, so the designer can review
 * exactly what they are about to generate.
 */
export interface PlannedFile {
  sourceNodeId: string;
  assetSlug: string;
  colourway: string;
  format: Format;
  scale: number;
  filename: string;
  folderPath: string;
  /** Full path within the package */
  path: string;
  /**
   * True for machine-converted CMYK output. Colour conversion is not
   * trustworthy for brand work, so these files are labelled in the README and
   * excluded from the "ready to send" count. See `CMYK_WARNING`.
   */
  colourUnverified?: boolean;
}

/**
 * Automated RGB to CMYK conversion produces plausible but wrong values for
 * brand colours. Measured on one navy (#1A3A5C): Ghostscript yields
 * C95 M78 Y39 K30, naive arithmetic yields C72 M37 Y0 K64 — and the value a
 * printer actually needs is whichever coated-stock or Pantone match the
 * designer chose. Geometry converts safely; colour does not.
 */
export const CMYK_WARNING =
  'CMYK values were machine-converted from RGB and are NOT colour-accurate. ' +
  'Replace them with the values your designer specified before sending to print.';

/** A render batch: one Figma /v1/images call covering many nodes at once. */
export interface RenderBatch {
  format: Format;
  scale: number;
  nodeIds: string[];
}

export interface ColourStyle {
  name: string;
  hex: string;
  rgb: { r: number; g: number; b: number };
}

export interface TextStyle {
  name: string;
  fontFamily: string;
  fontWeight: number;
  fontSize: number;
  lineHeightPx: number | null;
  letterSpacing: number | null;
}

export interface ExtractedTokens {
  colours: ColourStyle[];
  typography: TextStyle[];
}

export interface GenerationPlan {
  client: string;
  fileKey: string;
  fileName: string;
  sourceNodes: SourceNode[];
  files: PlannedFile[];
  batches: RenderBatch[];
  /** Estimated Figma Tier 1 request count for this generation. */
  tier1Requests: number;
  /** Estimated minutes to complete given the plan's rate limit budget. */
  estimatedMinutes: number;
  /** Renders that Figma would silently downscale. */
  megapixelWarnings: MegapixelWarning[];
}
