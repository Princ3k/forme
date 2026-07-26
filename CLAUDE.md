# Handoff — project context for Claude Code

Read this before making changes. It exists because several decisions here look
like arbitrary complexity and are not — they are the constraints the product
depends on. Re-simplifying them breaks it.

## What this is

A brand asset package generator for freelance brand designers. A designer marks
their logo assets once and defines a variant grid once per client. The system
fans that grid out into every required file (colourways × formats × scales),
names them, folders them, documents them, packages and delivers them.

The problem it solves: producing 100–300 correctly named brand asset files by
hand takes 4–5 unbillable hours per project.

**The Export Matrix is the product.** Everything else is plumbing.

## Reference documents

- `../02-revised-prd.md` — requirements, verified API constraints, validation plan
- `../03-build-plan.md` — epics, tickets, sequencing, risk register
- `../01-market-scan.md` — competitors and positioning

Do not start Phase 1 work until Phase 0 validation in PRD §9 is complete.

## Invariants — do not break these

These have tests attached. If a test named in caps fails, you have broken a
load-bearing property, not a detail.

### 1. Rendering is batched by (format, scale), never per file

`planBatches()` in `src/matrix.ts`.

Figma's `GET image` is a Tier 1 endpoint capped at **10 requests/minute** on the
Professional plan. One render call per output file means a 200-file package
needs 200 calls — 20 minutes of pure rate-limit waiting. Batched, it is 5 calls.

Tests: `BATCHING: render calls scale with format/scale pairs, not with file count`,
`BATCHING: adding assets does not add render calls`.

### 2. Packaging streams; nothing is ever buffered

`streamPackage()` in `src/packager.ts`.

A 300-file package of @3x PNGs exceeds the 500MB–1GB serverless memory and
`/tmp` ceiling. Downloads pipe through a live `archiver` stream into the sink.
Four details make this work and all four matter:

- zip entries are appended **sequentially**, with concurrency supplied by
  `orderedPrefetch` — that window is what bounds memory
- hashing happens **in-stream** via `HashingPassThrough`; buffering to hash
  would defeat the purpose
- PNG/JPG/PDF are **stored, not deflated** — already compressed
- each append waits for archiver's `entry` event, or the internal queue grows

Verified: 1.5GB of payload streams through with ~7MB of RSS growth.
`npm run memcheck` fails the build above 100MB.

### 3. Missing colourways are reported, never generated

`resolveNode()` in `src/matrix.ts`.

If a designer has not drawn a `mono-white` variant, say so. Do **not** auto
recolour the SVG. Recolouring breaks on gradients, embedded images and clipping
masks, and a mangled logo reaching a client is worse than a missing file.

Test: `missing colourways are reported, never silently substituted`.

### 4. Machine-converted CMYK is never presented as correct

`CMYK_WARNING` in `src/types.ts`.

RGB→CMYK conversion produces plausible, wrong values. On one navy: Ghostscript
gives C95 M78 Y39 K30, naive maths gives C72 M37 Y0 K64, and the printer needs
whichever coated/Pantone match the designer chose. Geometry converts safely;
colour does not. These files carry `colourUnverified: true`, are excluded from
ready-to-send counts, and are flagged prominently in the client README.

### 5. The engine is source-agnostic

`src/adapter.ts` is the seam. `src/generate.ts` contains **no reference to
Figma** and must stay that way. Figma is one adapter; local vector masters are
another. Adding Dropbox, Sketch or Illustrator means adding an adapter, not
touching the pipeline.

### 6. 429s honour `Retry-After` exactly

`src/figma.ts`. Figma tells you precisely how long to wait. A generic
exponential backoff is strictly worse.

## Verified API facts — do not "correct" these

Checked against live Figma docs, July 2026:

- `file_read` scope is **deprecated**. Use `file_content:read`,
  `file_metadata:read`, `webhooks:read`, `webhooks:write`, `current_user:read`.
- `file_variables:read` (the Variables API) is **Enterprise plan only**. Target
  users are on Professional. Parse local styles from the document tree instead.
- Tier 1 (`GET file`, `GET file nodes`, `GET image`): **10/min** on Professional
  for Full/Dev seats. **6 per month** for View/Collab seats — detect and warn at
  onboarding, those users cannot use the product.
- `FILE_UPDATE` fires within **30 minutes of editing inactivity**, not on save.
  For an explicit publish signal use `FILE_VERSION_UPDATE`.
- `GET image` caps at **32 megapixels** and **silently downscales** above that.
  `scale` maxes at 4. Rendered URLs expire after 30 days.
- `GET /v1/files/:key?plugin_data=shared` returns `sharedPluginData`. This is how
  the Figma plugin marks nodes **without renaming the designer's layers**.
- Google Drive: request **`drive.file` only**. Broader scopes trigger a
  restricted-scope security review costing weeks and thousands of dollars.

## Commands

```bash
npm test          # 28 tests, no network needed
npm run memcheck  # streaming regression guard
npm run doctor    # check cairosvg + ghostscript for the vector source
npm run plan -- --client "Acme"
npm run start -- generate --client "Acme" --vectors ./masters --preset full-brand-package
npm run start -- generate --client "Acme" --figma <url>   # needs FIGMA_TOKEN
```

## Conventions

- TypeScript strict, `noUncheckedIndexedAccess` on. No `any`, no non-null `!`
  assertions except where a preceding check makes it provably safe.
- Comments explain **why**, not what. If a line looks odd, say why it is odd.
- Tests assert behaviour and invariants, not implementation shape.
- Errors surfaced to designers are human-readable: "Figma rate limit reached,
  resuming in 47s", never "Error 429".

## Current state

The core engine is built and tested. Not built: OAuth, database, background
jobs, web UI, Google Drive delivery, and the Figma plugin itself (the backend
support for reading its data exists). See `../03-build-plan.md` Phases 1–3.
