/**
 * Figma source adapter.
 *
 * Wraps the REST client behind the SourceAdapter interface. Behaviour is
 * unchanged from before the refactor — batched rendering, exact Retry-After
 * handling, plugin-data node discovery — it is simply no longer the only way
 * artwork can enter the engine.
 *
 * Inherits Figma's limits, which the vector adapter does not have:
 *   - Tier 1 endpoints capped at 10 req/min on Professional
 *   - renders above 32MP silently downscaled
 *   - no EPS or CMYK output at any price
 */

import { Readable } from 'node:stream';
import { FigmaClient, findExportNodes, extractTokens } from '../figma.js';
import type { SourceAdapter, AdapterCapabilities, FetchOutcome } from '../adapter.js';
import type { ExtractedTokens, PlannedFile, RenderBatch, SourceNode, Format } from '../types.js';

interface FigmaFileShape {
  name: string;
  document: unknown;
  styles?: Record<string, { name: string; styleType: string }>;
}

export class FigmaAdapter implements SourceAdapter {
  readonly capabilities: AdapterCapabilities = {
    label: 'Figma',
    formats: new Set<Format>(['svg', 'png', 'jpg', 'pdf']),
    rateLimited: true,
    renderBudgetPerMinute: 10,
    maxMegapixels: 32,
    supportsCmyk: false,
  };

  private readonly client: FigmaClient;
  private file: FigmaFileShape | null = null;
  private readonly urls = new Map<string, string>();

  constructor(
    accessToken: string,
    private readonly fileKey: string,
  ) {
    this.client = new FigmaClient(accessToken);
  }

  private async load(): Promise<FigmaFileShape> {
    if (!this.file) {
      this.file = (await this.client.getFile(this.fileKey)) as FigmaFileShape;
    }
    return this.file;
  }

  async describe(): Promise<string> {
    return (await this.load()).name;
  }

  async discover(): Promise<SourceNode[]> {
    return findExportNodes((await this.load()).document);
  }

  async extractTokens(): Promise<ExtractedTokens> {
    return extractTokens(await this.load());
  }

  /** One /v1/images call per batch — never one per file. */
  async prepare(batches: RenderBatch[], onProgress?: (msg: string) => void): Promise<void> {
    for (const [i, batch] of batches.entries()) {
      onProgress?.(
        `Batch ${i + 1}/${batches.length}: ${batch.format}@${batch.scale}x, ${batch.nodeIds.length} nodes`,
      );
      const images = await this.client.renderBatch(this.fileKey, batch);
      for (const [nodeId, url] of Object.entries(images)) {
        if (url) this.urls.set(`${nodeId}|${batch.format}|${batch.scale}`, url);
      }
    }
  }

  async fetch(file: PlannedFile): Promise<FetchOutcome> {
    const url = this.urls.get(`${file.sourceNodeId}|${file.format}|${file.scale}`);
    if (!url) {
      return { skip: true, reason: 'Figma returned no render URL for this node' };
    }

    const res = await fetch(url);
    if (!res.ok || !res.body) {
      return { skip: true, reason: `Download failed: HTTP ${res.status}` };
    }

    return { body: Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]) };
  }
}
