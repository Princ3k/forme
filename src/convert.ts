/**
 * Local vector conversion.
 *
 * Turns one SVG master into the full output matrix — PNG at any scale, PDF,
 * EPS, and CMYK PDF. This is what makes the engine source-agnostic, and it
 * clears three Figma limits at once:
 *
 *   - no 10 req/min rate limit
 *   - no 32 megapixel silent downscale
 *   - EPS and CMYK output, which the Figma API cannot produce at all
 *
 * Toolchain: cairosvg for rasterising and vector output, Ghostscript for the
 * EPS and CMYK conversions. Both are open source and run locally.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Format } from './types.js';

const exec = promisify(execFile);

export class ConversionError extends Error {
  constructor(message: string, readonly format: Format) {
    super(message);
    this.name = 'ConversionError';
  }
}

/** Formats this toolchain can emit from an SVG master. */
export const CONVERTIBLE: ReadonlySet<Format> = new Set<Format>([
  'svg',
  'png',
  'jpg',
  'pdf',
  'eps',
  'pdf-cmyk',
]);

/**
 * Verifies every external dependency this module actually invokes.
 *
 * This must stay exhaustive. A preflight that passes while a conversion path is
 * missing its binary is worse than no preflight: the failure then surfaces
 * per-file, mid-package, after the designer has already waited.
 *
 * Pillow is checked explicitly even though cairosvg declares it as a hard
 * dependency — a broken or partial install should be caught here, not at the
 * first JPEG.
 */
export async function checkToolchain(): Promise<{ ok: boolean; missing: string[] }> {
  const missing: string[] = [];

  try {
    await exec('python3', ['-c', 'import cairosvg']);
  } catch {
    missing.push('cairosvg  (pip3 install cairosvg)');
  }

  try {
    // Used for the PNG -> JPEG step. Ships with cairosvg, but verify.
    await exec('python3', ['-c', 'import PIL']);
  } catch {
    missing.push('Pillow    (pip3 install pillow)');
  }

  try {
    await exec('gs', ['--version']);
  } catch {
    missing.push('ghostscript  (brew install ghostscript / apt install ghostscript)');
  }

  return { ok: missing.length === 0, missing };
}

/**
 * Reads intrinsic dimensions from an SVG, preferring viewBox because width and
 * height are often percentages. Used for the megapixel estimate.
 */
export function svgDimensions(svg: string): { width: number; height: number } | null {
  const viewBox = svg.match(/viewBox\s*=\s*["']\s*[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)/i);
  if (viewBox?.[1] && viewBox[2]) {
    return { width: Number(viewBox[1]), height: Number(viewBox[2]) };
  }

  const w = svg.match(/\bwidth\s*=\s*["']([\d.]+)(?:px)?["']/i);
  const h = svg.match(/\bheight\s*=\s*["']([\d.]+)(?:px)?["']/i);
  if (w?.[1] && h?.[1]) return { width: Number(w[1]), height: Number(h[1]) };

  return null;
}

/**
 * Converts an SVG master to the requested format, returning the bytes.
 *
 * All work happens in a scratch directory that is always cleaned up, and the
 * result is returned as a Buffer so the caller can stream it into the zip.
 * Individual assets are small; it is the *package* that must never be
 * materialised, and that guarantee lives in the packager.
 */
export async function convertSvg(
  svgSource: Buffer,
  format: Format,
  scale = 1,
): Promise<Buffer> {
  if (format === 'svg') return svgSource;

  const dir = await mkdtemp(join(tmpdir(), 'handoff-'));
  const src = join(dir, 'in.svg');

  try {
    await writeFile(src, svgSource);

    switch (format) {
      case 'png':
      case 'jpg': {
        const out = join(dir, `out.${format}`);
        // cairo has no JPEG target, so JPG goes via PNG.
        const png = format === 'png' ? out : join(dir, 'out.png');
        await exec('python3', [
          '-c',
          'import sys,cairosvg;cairosvg.svg2png(url=sys.argv[1],write_to=sys.argv[2],scale=float(sys.argv[3]))',
          src,
          png,
          String(scale),
        ]);

        if (format === 'jpg') {
          // Pillow rather than ImageMagick. Pillow is a hard dependency of
          // cairosvg so it is guaranteed present; ImageMagick was an undeclared
          // dependency the preflight never checked, and its binary was renamed
          // `convert` -> `magick` in v7, so the old call was broken on any
          // current install.
          //
          // JPEG has no alpha channel, so transparency is composited onto white
          // rather than turning black.
          await exec('python3', [
            '-c',
            'import sys;from PIL import Image;' +
              'im=Image.open(sys.argv[1]).convert("RGBA");' +
              'bg=Image.new("RGB",im.size,(255,255,255));' +
              'bg.paste(im,mask=im.split()[3]);' +
              'bg.save(sys.argv[2],"JPEG",quality=92,optimize=True)',
            png,
            out,
          ]);
        }

        return await readFile(out);
      }

      case 'pdf': {
        const out = join(dir, 'out.pdf');
        await exec('python3', [
          '-c',
          'import sys,cairosvg;cairosvg.svg2pdf(url=sys.argv[1],write_to=sys.argv[2])',
          src,
          out,
        ]);
        return await readFile(out);
      }

      case 'eps': {
        // cairosvg emits PostScript; Ghostscript's eps2write makes it a
        // conforming EPS that print vendors will accept.
        const ps = join(dir, 'out.ps');
        const out = join(dir, 'out.eps');
        await exec('python3', [
          '-c',
          'import sys,cairosvg;cairosvg.svg2ps(url=sys.argv[1],write_to=sys.argv[2])',
          src,
          ps,
        ]);
        await exec('gs', [
          '-q', '-dNOPAUSE', '-dBATCH', '-dSAFER',
          '-sDEVICE=eps2write',
          `-sOutputFile=${out}`,
          ps,
        ]);
        return await readFile(out);
      }

      case 'pdf-cmyk': {
        // Structurally correct CMYK. NOT colour-accurate — see CMYK_WARNING.
        const rgb = join(dir, 'rgb.pdf');
        const out = join(dir, 'cmyk.pdf');
        await exec('python3', [
          '-c',
          'import sys,cairosvg;cairosvg.svg2pdf(url=sys.argv[1],write_to=sys.argv[2])',
          src,
          rgb,
        ]);
        await exec('gs', [
          '-q', '-dNOPAUSE', '-dBATCH', '-dSAFER',
          '-sDEVICE=pdfwrite',
          '-sColorConversionStrategy=CMYK',
          '-dProcessColorModel=/DeviceCMYK',
          `-sOutputFile=${out}`,
          rgb,
        ]);
        return await readFile(out);
      }

      default:
        throw new ConversionError(`Unsupported format: ${format}`, format);
    }
  } catch (err) {
    if (err instanceof ConversionError) throw err;
    throw new ConversionError(
      `Failed to convert to ${format}: ${err instanceof Error ? err.message : String(err)}`,
      format,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Verifies a produced PDF actually carries a CMYK colour space. */
export function isCmyk(pdf: Buffer): boolean {
  return pdf.includes('DeviceCMYK') && !pdf.includes('DeviceRGB');
}
