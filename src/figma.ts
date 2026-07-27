/**
 * Figma REST API client.
 *
 * Every call goes through the rate limiter, and 429s are handled by reading the
 * exact Retry-After header. The image endpoint is deliberately batch-only —
 * there is no renderOne() method, because offering one would invite the
 * per-asset call pattern that makes the product unusable.
 */

import {
  RateLimiter,
  systemClock,
  type Clock,
  type Tier,
  PROFESSIONAL_FULL_SEAT,
  type TierBudget,
} from './ratelimit.js';
import type { SourceNode, RenderBatch, Format, ExtractedTokens, ColourStyle, TextStyle } from './types.js';

const API = 'https://api.figma.com';

/** Layer-name prefix that marks a node for export. */
export const EXPORT_PREFIX = '@export/';

export class FigmaRateLimitError extends Error {
  constructor(
    message: string,
    readonly retryAfterSeconds: number,
    readonly planTier: string | null,
    readonly upgradeLink: string | null,
  ) {
    super(message);
    this.name = 'FigmaRateLimitError';
  }
}

export class FigmaApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'FigmaApiError';
  }
}

interface FigmaNode {
  id: string;
  name: string;
  type: string;
  children?: FigmaNode[];
  styles?: Record<string, string>;
  absoluteBoundingBox?: { width: number; height: number } | null;
  /** Populated only when GET file is called with ?plugin_data=shared */
  sharedPluginData?: Record<string, Record<string, string>>;
  fills?: Array<{ type: string; color?: { r: number; g: number; b: number }; visible?: boolean }>;
  style?: {
    fontFamily?: string;
    fontWeight?: number;
    fontSize?: number;
    lineHeightPx?: number;
    letterSpacing?: number;
  };
}

interface FigmaFileResponse {
  name: string;
  document: FigmaNode;
  styles?: Record<string, { key: string; name: string; styleType: string; description?: string }>;
}

interface FigmaImagesResponse {
  err: string | null;
  images: Record<string, string | null>;
}

/** Minimal shape of `fetch`, so tests can substitute a stub. */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface RateLimitNotice {
  tier: Tier;
  retryAfterSeconds: number;
  attempt: number;
  planTier: string | null;
  upgradeLink: string | null;
}

export interface FigmaClientOptions {
  budget?: Record<Tier, TierBudget>;
  maxRetries?: number;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** Injectable for tests. Defaults to the system clock. */
  clock?: Clock;
  /** Called on each 429, so the UI can report the wait rather than hang. */
  onRateLimit?: (notice: RateLimitNotice) => void;
}

export class FigmaClient {
  private readonly limiter: RateLimiter;
  private readonly maxRetries: number;
  private readonly fetchImpl: FetchLike;
  private readonly onRateLimit: ((notice: RateLimitNotice) => void) | undefined;

  constructor(
    private readonly accessToken: string,
    options: FigmaClientOptions = {},
  ) {
    this.limiter = new RateLimiter(
      options.budget ?? PROFESSIONAL_FULL_SEAT,
      options.clock ?? systemClock,
    );
    this.maxRetries = options.maxRetries ?? 5;
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.onRateLimit = options.onRateLimit;
  }

  private async request<T>(path: string, tier: Tier): Promise<T> {
    let attempt = 0;
    for (;;) {
      await this.limiter.acquire(tier);

      const res = await this.fetchImpl(`${API}${path}`, {
        headers: { Authorization: `Bearer ${this.accessToken}` },
      });

      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after')) || 60;
        const planTier = res.headers.get('x-figma-plan-tier');
        const upgradeLink = res.headers.get('x-figma-upgrade-link');

        if (attempt++ >= this.maxRetries) {
          throw new FigmaRateLimitError(
            `Figma rate limit exceeded after ${attempt} attempts.`,
            retryAfter,
            planTier,
            upgradeLink,
          );
        }

        // Honour Figma's exact Retry-After rather than guessing a backoff.
        // Surfaced as a callback rather than written to stderr so the UI can
        // show "resuming in 47s" instead of the designer seeing nothing.
        this.onRateLimit?.({ tier, retryAfterSeconds: retryAfter, attempt, planTier, upgradeLink });
        await this.limiter.penalise(tier, retryAfter);
        continue;
      }

      if (!res.ok) {
        throw new FigmaApiError(`Figma ${res.status}: ${await res.text()}`, res.status);
      }

      return (await res.json()) as T;
    }
  }

  /**
   * GET /v1/files/:key — Tier 1. Call once per generation and cache.
   *
   * `plugin_data=shared` returns any `sharedPluginData` written into the file
   * by plugins, which is how the Handoff Figma plugin marks nodes without
   * touching the designer's layer names.
   */
  async getFile(fileKey: string, includePluginData = true): Promise<FigmaFileResponse> {
    const qs = includePluginData ? '?plugin_data=shared' : '';
    return this.request<FigmaFileResponse>(`/v1/files/${encodeURIComponent(fileKey)}${qs}`, 1);
  }

  /**
   * GET /v1/images — Tier 1. Batched by design: one call renders every node in
   * the batch at a single format and scale. With five (format, scale) pairs a
   * 200-file package costs five Tier 1 requests, not two hundred.
   */
  async renderBatch(fileKey: string, batch: RenderBatch): Promise<Record<string, string | null>> {
    const params = new URLSearchParams({
      ids: batch.nodeIds.join(','),
      format: batch.format,
    });
    // Scale is only meaningful for raster output.
    if (batch.format === 'png' || batch.format === 'jpg') {
      params.set('scale', String(batch.scale));
    }

    const res = await this.request<FigmaImagesResponse>(
      `/v1/images/${encodeURIComponent(fileKey)}?${params.toString()}`,
      1,
    );

    if (res.err) throw new FigmaApiError(`Figma image render failed: ${res.err}`, 500);
    return res.images;
  }
}

/** Shared plugin data namespace written by the Handoff Figma plugin. */
export const PLUGIN_NAMESPACE = 'handoff';

/**
 * Walks the document tree for nodes marked for export.
 *
 * Two mechanisms, in priority order:
 *
 * 1. **Shared plugin data** (`sharedPluginData.handoff.asset` / `.colourway`),
 *    written by the Handoff Figma plugin. This is the primary path. It is
 *    non-destructive — the designer keeps their own layer names — and it
 *    removes the transcription errors that a hand-typed convention invites.
 *    Requires GET file with `?plugin_data=shared`.
 *
 * 2. **The `@export/` name prefix**, as a fallback for anyone who has not
 *    installed the plugin, and for scripted use:
 *      `@export/logo-primary`             -> base node
 *      `@export/logo-primary/mono-black`  -> designer-drawn colourway variant
 *
 * Plugin data wins where both are present.
 */
export function findExportNodes(document: unknown): SourceNode[] {
  const found: SourceNode[] = [];

  const walk = (node: FigmaNode): void => {
    const pluginData = node.sharedPluginData?.[PLUGIN_NAMESPACE];
    const pluginAsset = pluginData?.['asset']?.trim();

    if (pluginAsset) {
      const colourway = pluginData?.['colourway']?.trim();
      found.push({
        nodeId: node.id,
        nodeName: node.name,
        assetSlug: pluginAsset,
        colourway: colourway ? colourway : null,
        markedBy: 'plugin',
        width: node.absoluteBoundingBox?.width,
        height: node.absoluteBoundingBox?.height,
      });
    } else if (typeof node.name === 'string' && node.name.startsWith(EXPORT_PREFIX)) {
      const path = node.name.slice(EXPORT_PREFIX.length).trim();
      const parts = path.split('/').map((p) => p.trim()).filter(Boolean);
      const assetSlug = parts[0];
      if (assetSlug) {
        found.push({
          nodeId: node.id,
          nodeName: node.name,
          assetSlug,
          colourway: parts.length > 1 ? (parts[1] ?? null) : null,
          markedBy: 'prefix',
          width: node.absoluteBoundingBox?.width,
          height: node.absoluteBoundingBox?.height,
        });
      }
    }

    for (const child of node.children ?? []) walk(child);
  };

  walk(document as FigmaNode);
  return found;
}

const toHex = (c: { r: number; g: number; b: number }): string => {
  const h = (v: number): string =>
    Math.round(Math.max(0, Math.min(1, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`.toUpperCase();
};

/**
 * Extracts colour and text styles from the document tree.
 *
 * Note: this reads LOCAL STYLES, not Figma Variables. The Variables API
 * (file_variables:read) is Enterprise-plan only, and the target user is on
 * Professional — so variables are simply not available to this product.
 */
export function extractTokens(file: { document: unknown; styles?: Record<string, { name: string; styleType: string }> }): ExtractedTokens {
  const styleMeta = file.styles ?? {};
  const colours = new Map<string, ColourStyle>();
  const typography = new Map<string, TextStyle>();

  const walk = (node: FigmaNode): void => {
    const styleRefs = node.styles ?? {};

    // Colour styles come from fill references.
    const fillStyleId = styleRefs['fill'] ?? styleRefs['fills'];
    if (fillStyleId && styleMeta[fillStyleId]?.styleType === 'FILL') {
      const name = styleMeta[fillStyleId].name;
      const solid = (node.fills ?? []).find((f) => f.type === 'SOLID' && f.visible !== false);
      if (solid?.color && !colours.has(name)) {
        const { r, g, b } = solid.color;
        colours.set(name, {
          name,
          hex: toHex(solid.color),
          rgb: { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) },
        });
      }
    }

    // Text styles come from text references.
    const textStyleId = styleRefs['text'];
    if (textStyleId && styleMeta[textStyleId]?.styleType === 'TEXT' && node.style) {
      const name = styleMeta[textStyleId].name;
      if (!typography.has(name)) {
        typography.set(name, {
          name,
          fontFamily: node.style.fontFamily ?? 'Unknown',
          fontWeight: node.style.fontWeight ?? 400,
          fontSize: node.style.fontSize ?? 0,
          lineHeightPx: node.style.lineHeightPx ?? null,
          letterSpacing: node.style.letterSpacing ?? null,
        });
      }
    }

    for (const child of node.children ?? []) walk(child);
  };

  walk(file.document as FigmaNode);

  return {
    colours: [...colours.values()].sort((a, b) => a.name.localeCompare(b.name)),
    typography: [...typography.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** Parses a Figma file key out of a share URL, or passes a bare key through. */
export function parseFileKey(input: string): string {
  const match = input.match(/figma\.com\/(?:file|design)\/([A-Za-z0-9]+)/);
  return match?.[1] ?? input.trim();
}

export type { Format };
