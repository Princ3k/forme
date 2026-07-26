/**
 * The source adapter seam.
 *
 * Everything valuable in this engine — the variant grid, naming convention,
 * folder tree, README, delta detection, delivery — is source-agnostic. Figma is
 * one way to get pixels; it is not the product. This interface is the line
 * between "where the artwork comes from" and "what we do with it".
 *
 * Two adapters ship today:
 *
 *   FigmaAdapter    Renders via the Figma REST API. Best "stays in sync" story,
 *                   but inherits Figma's constraints: 10 Tier 1 req/min, a 32MP
 *                   silent downscale ceiling, and no EPS/CMYK output at all.
 *
 *   VectorAdapter   Converts local SVG/PDF masters. Escapes all three of those
 *                   constraints and is the only path to print formats. Also
 *                   requires no OAuth, which makes it the cheap way to run
 *                   validation with designers who use Illustrator or Affinity.
 */

import type { Readable } from 'node:stream';
import type { Format, PlannedFile, RenderBatch, SourceNode, ExtractedTokens } from './types.js';

/** What an adapter reports about its own limits, so the planner can adapt. */
export interface AdapterCapabilities {
  /** Formats this adapter can produce. */
  formats: ReadonlySet<Format>;
  /**
   * Whether render calls are rate limited. Figma is; local conversion is not.
   * Drives whether the planner bothers batching and estimating wait time.
   */
  rateLimited: boolean;
  /** Requests per minute against the render path, if rate limited. */
  renderBudgetPerMinute?: number;
  /** Megapixel ceiling above which output is silently degraded, if any. */
  maxMegapixels?: number;
  /** Whether the adapter can emit CMYK colour output. */
  supportsCmyk: boolean;
  /** Human-readable name for progress output and error messages. */
  label: string;
}

export type FetchOutcome =
  | { body: Readable; skip?: false }
  | { body?: undefined; skip: true; reason: string };

/**
 * A source of brand artwork.
 *
 * Adapters are responsible only for (a) telling the planner what assets exist,
 * and (b) producing bytes for a planned file. They know nothing about naming,
 * foldering, zipping or delivery.
 */
export interface SourceAdapter {
  readonly capabilities: AdapterCapabilities;

  /** Human-readable description of the source, e.g. a Figma file name. */
  describe(): Promise<string>;

  /** Every asset marked for export, with colourway variants resolved. */
  discover(): Promise<SourceNode[]>;

  /**
   * Colour and typography tokens, where the source can supply them.
   * Figma reads local styles; the vector adapter returns empty unless a
   * palette file is supplied alongside the artwork.
   */
  extractTokens(): Promise<ExtractedTokens>;

  /**
   * Prepare to render the given batches. Adapters that call a remote API do
   * their expensive work here, once per batch; local adapters can no-op.
   */
  prepare(batches: RenderBatch[], onProgress?: (msg: string) => void): Promise<void>;

  /** Produce the bytes for one planned file. Called after `prepare`. */
  fetch(file: PlannedFile): Promise<FetchOutcome>;

  /** Release any temporary resources. */
  dispose?(): Promise<void>;
}
