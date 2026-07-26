/**
 * Vector master source adapter.
 *
 * Takes a folder of SVG masters and converts locally. No OAuth, no API, no
 * rate limit, no megapixel ceiling — and it is the only path to EPS and CMYK
 * output, which Figma cannot produce at all.
 *
 * Practically this matters most for validation: running a package for a
 * designer needs nothing but their logo files. No plugin to install, no
 * permissions to grant, and it works whether they use Figma, Illustrator,
 * Affinity or Inkscape.
 *
 * Filename convention:
 *
 *   logo-primary.svg              base artwork for "logo-primary"
 *   logo-primary.mono-black.svg   the mono-black colourway of it
 *   submark.mono-white.svg        the mono-white colourway of "submark"
 *
 * An optional `palette.json` alongside the artwork supplies colour and type
 * tokens, since an SVG folder carries no design system of its own.
 */

import { readFile, readdir } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { basename, extname, join } from 'node:path';
import type { SourceAdapter, AdapterCapabilities, FetchOutcome } from '../adapter.js';
import { convertSvg, svgDimensions, ConversionError } from '../convert.js';
import type {
  ColourStyle,
  ExtractedTokens,
  Format,
  PlannedFile,
  RenderBatch,
  SourceNode,
  TextStyle,
} from '../types.js';

interface Master {
  node: SourceNode;
  filePath: string;
  svg: Buffer;
}

export class VectorAdapter implements SourceAdapter {
  readonly capabilities: AdapterCapabilities = {
    label: 'Vector masters',
    // Everything Figma can do, plus the two print formats it cannot.
    formats: new Set<Format>(['svg', 'png', 'jpg', 'pdf', 'eps', 'pdf-cmyk']),
    rateLimited: false,
    // No ceiling: rasterisation is local, so scale is bounded by disk and time.
    supportsCmyk: true,
  };

  private masters = new Map<string, Master>();
  private tokens: ExtractedTokens = { colours: [], typography: [] };
  private loaded = false;

  constructor(private readonly sourceDir: string) {}

  private async load(): Promise<void> {
    if (this.loaded) return;

    const entries = await readdir(this.sourceDir);

    for (const entry of entries) {
      if (extname(entry).toLowerCase() !== '.svg') continue;

      const stem = basename(entry, extname(entry));
      // "logo-primary.mono-black" -> asset "logo-primary", colourway "mono-black"
      const parts = stem.split('.');
      const assetSlug = parts[0];
      if (!assetSlug) continue;
      const colourway = parts.length > 1 ? (parts[1] ?? null) : null;

      const filePath = join(this.sourceDir, entry);
      const svg = await readFile(filePath);
      const dims = svgDimensions(svg.toString('utf8'));

      const node: SourceNode = {
        nodeId: stem,
        nodeName: entry,
        assetSlug,
        colourway,
        markedBy: 'prefix',
        width: dims?.width,
        height: dims?.height,
      };

      this.masters.set(`${assetSlug}|${colourway ?? ''}`, { node, filePath, svg });
    }

    // Optional palette file — an SVG folder has no design system of its own.
    try {
      const raw = await readFile(join(this.sourceDir, 'palette.json'), 'utf8');
      const parsed = JSON.parse(raw) as { colours?: ColourStyle[]; typography?: TextStyle[] };
      this.tokens = { colours: parsed.colours ?? [], typography: parsed.typography ?? [] };
    } catch {
      // Absent or malformed palette is fine; tokens stay empty.
    }

    this.loaded = true;
  }

  async describe(): Promise<string> {
    await this.load();
    return `${this.masters.size} vector master(s) in ${basename(this.sourceDir)}`;
  }

  async discover(): Promise<SourceNode[]> {
    await this.load();
    return [...this.masters.values()].map((m) => m.node);
  }

  async extractTokens(): Promise<ExtractedTokens> {
    await this.load();
    return this.tokens;
  }

  /** Nothing to prefetch — conversion is local and happens per file. */
  async prepare(_batches: RenderBatch[], onProgress?: (msg: string) => void): Promise<void> {
    await this.load();
    onProgress?.(`${this.masters.size} masters loaded; converting locally (no rate limit)`);
  }

  async fetch(file: PlannedFile): Promise<FetchOutcome> {
    await this.load();

    const master = [...this.masters.values()].find((m) => m.node.nodeId === file.sourceNodeId);
    if (!master) {
      return { skip: true, reason: `No vector master found for "${file.sourceNodeId}"` };
    }

    try {
      const bytes = await convertSvg(master.svg, file.format, file.scale);
      return { body: Readable.from([bytes]) };
    } catch (err) {
      return {
        skip: true,
        reason:
          err instanceof ConversionError
            ? err.message
            : `Conversion failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}
