# Handoff — core engine prototype

A runnable prototype of the Export Matrix: the thing that turns a handful of marked assets into a complete, correctly named, correctly foldered brand asset package.

**This is a Phase 0 validation tool, not a v1.** Its job is to make the conversations in PRD §9 concrete — show a designer real generated output and ask whether they'd send it to a client as-is.

**It is not Figma-only.** Figma is one `SourceAdapter`; local vector masters are another.

## Quick start

```bash
npm install
npm test          # 28 tests, no API access or network needed
npm run memcheck  # proves the pipeline streams rather than buffers
npm run plan -- --client "Acme Records"
```

`plan` runs entirely offline against a demo asset set. Use it in a validation call to show the shape and volume of the output before asking anyone for anything.

### Generating from vector masters (no Figma, no auth)

```bash
npm run -s start -- doctor          # check cairosvg + ghostscript
npm run -s start -- generate \
  --client "Acme Records" \
  --vectors ./masters \
  --preset full-brand-package
```

Name the files `<asset>.svg` or `<asset>.<colourway>.svg`:

```
masters/
  logo-primary.svg
  logo-primary.mono-black.svg
  logo-primary.mono-white.svg
  submark.svg
  palette.json          (optional — supplies colour and type tokens)
```

**This is the path to use for validation.** No OAuth, no plugin, no Figma seat — and it works for designers on Illustrator or Affinity.

### Generating from Figma

```bash
export FIGMA_TOKEN=<personal access token>
npm run -s start -- generate --client "Acme Records" --figma https://figma.com/design/abc123/Brand
```

Presets: `standard-brand-package` (default), `logo-only`, `social-kit`, `print-package`, `full-brand-package`.

## Sources

| | Figma | Vector masters |
| --- | --- | --- |
| Formats | SVG, PNG, JPG, PDF | SVG, PNG, JPG, PDF, **EPS, CMYK PDF** |
| Rate limit | 10 Tier 1 req/min | none |
| Megapixel ceiling | 32MP, silently downscaled | none |
| Auth | OAuth / PAT | none |
| Tokens | local styles | optional `palette.json` |
| Best for | staying in sync with a live file | print work, non-Figma tools, cheap validation |

Asking a source for a format it can't produce drops those files from the plan and reports it once, up front — rather than handing back a package with thirty silent gaps.

## Marking assets

Two mechanisms, plugin data taking priority.

**Primary — the Figma plugin** (Phase 2 of the build plan; the backend support is here). The plugin writes `sharedPluginData` under a `handoff` namespace and **leaves layer names alone**:

```json
{ "sharedPluginData": { "handoff": { "asset": "logo-primary", "colourway": "mono-white" } } }
```

Read back via `GET /v1/files/:key?plugin_data=shared`. Non-destructive matters here — a designer's layer names are their own working system, and a tool that rewrites them is one they'll stop using.

**Fallback — the `@export/` name prefix**, for scripted use and anyone without the plugin:

```
@export/logo-primary
@export/logo-primary/mono-black     <- designer-drawn colourway variant
@export/logo-primary/mono-white
@export/submark
```

## What it does

1. Fetches the Figma document once, with `plugin_data=shared` (Tier 1 — expensive, cached)
2. Finds marked nodes and their colourway variants
3. Extracts local colour and text styles into JSON + human-readable text
4. Expands the Export Matrix into a full file plan — colourways × formats × scales
5. **Batches render calls by (format, scale)** — the critical rate-limit optimisation
6. Warns about any render Figma would silently downscale above 32MP
7. **Streams** each download through the zip into the sink, hashing in flight
8. Writes a client-facing README explaining which file to use when

## The two things to understand

### 1. Batching — why the rate limit doesn't kill it

`planBatches()` in `src/matrix.ts`.

Figma's `GET image` endpoint is **Tier 1: 10 requests/minute** on the Professional plan. The obvious implementation — one render call per output file — means a 200-file package needs 200 requests, which is **20 minutes of pure rate-limit waiting** before a single byte is downloaded.

Batching by `(format, scale)` and passing all node IDs in one call collapses that to **5 requests, under a minute**:

```
$ npm run plan -- --client "Acme Records"

  Output files generated         45
  Figma render calls needed      5
  Total Tier 1 requests          6  (budget: 10/min)
  Estimated time                 ~0.6 min

  Without batching this would need 46 Tier 1 requests
  — about 5 minutes of pure rate-limit waiting.
```

The test `BATCHING: adding assets does not add render calls` locks this in: 20 assets producing 100 files still costs 5 render calls. If someone later "simplifies" this into a per-file loop, that test fails.

### 2. Streaming — why large packages don't OOM

`streamPackage()` in `src/packager.ts`.

A 300-file package of @3x PNGs and PDFs is over a gigabyte. Serverless functions cap around 500MB–1GB of memory with a similar `/tmp` ceiling, so anything that assembles the tree on disk or buffers files before zipping fails on exactly the packages worth automating.

So nothing is ever materialised. Each download pipes straight through a live `archiver` stream into the sink — a file locally, an S3 multipart upload in production. Four details make it work:

- **Ordered prefetch window.** Zip entries must be appended sequentially, but sequential downloading is latency-bound. `orderedPrefetch` keeps ~6 requests in flight while yielding in plan order. That window is what bounds memory.
- **Hash in flight.** Delta detection needs a SHA-256 per file, but buffering to hash would defeat the point. `HashingPassThrough` computes it as bytes flow past.
- **Store, don't deflate, precompressed formats.** PNG/JPG/PDF are already compressed; deflating them burns billed CPU for ~0% gain.
- **Backpressure on append.** Each entry waits for archiver's `entry` event, so the internal queue can't grow without bound.

```
$ npm run memcheck

  Files streamed        305
  Payload through zip   1500 MB
  Peak RSS              103.1 MB
  Growth                6.7 MB
  Serverless ceiling    ~1024 MB
  Verdict               STREAMING — memory is flat
```

`memcheck` exits non-zero if growth exceeds 100MB, so it works as a CI regression guard.

**Related trap for production:** Inngest persists every step's return value and size-limits it. Steps must pass object keys and manifests — never file contents.

## Deliberate design decisions

**Missing colourways are reported, never faked.** If the designer hasn't drawn a `mono-white` variant, the tool says so and tells them what to name the layer. It does not auto-recolour the SVG. Automated recolouring breaks on gradients, embedded images and clipping masks — and a mangled logo reaching a client is worse than a missing file. Auto-recolouring is post-MVP, behind mandatory preview-and-confirm.

**Silent downscaling is caught before it happens.** Figma caps renders at 32 megapixels and quietly scales larger ones down rather than erroring. A 4000×1200 wordmark at @3x is 43.2MP — the client gets a soft asset and nothing reports it. Checked at plan time, with the max safe scale surfaced:

```
SILENT DOWNSCALE WARNING
wordmark at @3x = 43.2MP (Figma caps at 32MP)
    Figma will downscale this without reporting an error.
    Max safe scale for this artboard: @2.58x
```

**429s honour `Retry-After` exactly**, rather than applying a generic exponential backoff. Figma tells you precisely how long to wait; guessing is strictly worse.

**Local styles, not Variables.** Figma's Variables API requires `file_variables:read`, which is Enterprise-plan only. The target user is on Professional, so variables are simply unavailable and styles are parsed from the document tree instead.

**Path collisions are guarded.** A naming template that collapses two variants onto one filename would silently overwrite a client deliverable. `expandMatrix` dedupes and a test asserts it.

**Failures are recorded, not swallowed.** A file that can't be rendered or downloaded is skipped, listed in the result, and named in the client-facing README — so the designer finds out before the client does.

## What's missing (on purpose)

No Google Drive upload, no OAuth, no database, no UI, and the Figma plugin itself is not built (though the backend support for reading its data is). Those are Phases 1–2 in the build plan. This prototype exists to prove the engine and produce artefacts for validation calls.

**EPS, AI and CMYK/Pantone cannot be generated at all** — the Figma API has no path to them. The build plan handles this with a print-asset merge: the designer uploads their Illustrator files and the system slots them into the generated tree against a matrix-derived checklist. Realistic saving lands around 55–65% rather than the full afternoon; see PRD §5.6.

## Layout

```
src/
  types.ts             Domain types, format model, 32MP ceiling, CMYK warning
  adapter.ts           THE SEAM — SourceAdapter + AdapterCapabilities
  adapters/
    figma-adapter.ts   Figma REST source (rate limited, no print formats)
    vector-adapter.ts  Local SVG masters (no limits, print formats)
  convert.ts           cairosvg + ghostscript: SVG → PNG/PDF/EPS/CMYK
  ratelimit.ts         Token bucket; Figma's published per-tier budgets
  stream.ts            Hashing transform, ordered prefetch, stream helpers
  figma.ts             REST client, node discovery (plugin data + prefix)
  matrix.ts            Export Matrix expansion, naming, BATCHING, guards
  packager.ts          STREAMING zip, README, tokens, content-hash diffing
  generate.ts          Source-agnostic pipeline (→ Inngest in production)
  index.ts             CLI
  engine.test.ts       28 tests
memcheck.ts            Memory benchmark / CI regression guard
```

`generate.ts` contains no reference to Figma. Swapping sources is one constructor call.
