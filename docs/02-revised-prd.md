# Product Requirements Document — v4
**Working name:** Handoff
**Date:** 26 July 2026
**Status:** Draft for validation. Do not build past the prototype until Section 9 is complete.

---

## v4 changelog — the engine is no longer Figma-only

| Change | Section | Why |
| --- | --- | --- |
| **Figma is now one `SourceAdapter`, not the architecture** | 4, 6 | Everything valuable — the variant grid, naming, foldering, README, delta detection, delivery — is source-agnostic. Only the ingestion differs |
| **Vector-master adapter added** — local SVG→PNG/PDF/EPS/CMYK conversion | 5.2, 5.6 | Escapes all three Figma constraints at once: no rate limit, no 32MP ceiling, and it produces the print formats Figma cannot |
| **EPS and CMYK PDF moved from "impossible" to "supported"** | 5.6, 8 | Verified end to end: 35-file package with conforming EPS and `DeviceCMYK` PDFs, generated with zero Figma involvement |
| **CMYK colour explicitly marked untrustworthy** | 5.6 | Geometry converts safely; colour does not. Measured on one navy: Ghostscript gives C95 M78 Y39 K30, naive maths gives C72 M37 Y0 K64, and the printer needs neither |
| **Phase 0 validation no longer needs OAuth** | 9 | With a vector source you just ask a designer for their logo SVGs. No install, no permissions, works for Illustrator and Affinity users |
| Print-asset merge downgraded in importance | 5.6 | Still useful for `.ai` originals, but much of what it was covering is now generated directly |

---

## v3 changelog

| Change | Section | Why |
| --- | --- | --- |
| Packaging is streaming end-to-end; nothing is buffered | 5.3, 5.5, 6 | A 300-file package of @3x PNGs exceeds the 500MB–1GB serverless memory and `/tmp` ceiling. Verified: 1.5GB of payload now streams through with **6.7MB** of RSS growth |
| Figma plugin moved from Phase 4 into **v1 scope** | 5.2, 8, 10 | Hand-typed layer conventions are error-prone, and the Figma Community is the answer to the discovery problem the market scan found |
| Plugin marks nodes via `sharedPluginData`, not renaming | 4, 5.2 | Non-destructive — the designer keeps their own layer names. Confirmed readable via `GET /v1/files/:key?plugin_data=shared` |
| Print-asset merge replaces the hard print kill criterion | 5.5, 9 | Print-native work no longer kills the product, it changes the workflow. Savings estimate revised down from 80% to a defensible 55–65% |
| Added the 32MP silent-downscale guard | 4, 5.3 | Figma silently scales down renders above 32 megapixels. A large artboard at @3x ships a soft logo with no error anywhere |

---

## 0. What changed from v1, and why

Five things in the original PRD were wrong or unbuildable. They're listed here first because they invalidate the original architecture, not just its details.

| # | v1 said | Reality | Impact |
| --- | --- | --- | --- |
| 1 | The MVP is "webhook → extract → sync to Drive" | The 4–5 hours goes into **producing format and colour variants of each asset**, not into moving files. Syncing was never the bottleneck | **Fatal to the value prop.** v1 automates the fast part |
| 2 | Request the `file_read` OAuth scope | `file_read` is **deprecated**. Correct scopes are `file_content:read`, `file_metadata:read`, `webhooks:read`, `webhooks:write`, `current_user:read` | Auth would not work as specced |
| 3 | Extract design tokens (colours, typography) | Figma's **Variables API is Enterprise-plan only** (`file_variables:read`). Freelancers are on Professional. Local styles must be parsed out of the document tree instead | Token extraction as described is impossible for the target user |
| 4 | "Upon publishing a Figma file, the system intercepts the event" — sub-5-second acknowledgment | `FILE_UPDATE` fires **within 30 minutes of editing inactivity**, not on save. There is no real-time publish hook for ordinary design files | "Syncs every time you change it" is not achievable. Must use `FILE_VERSION_UPDATE` (named version) as an explicit publish signal |
| 5 | Freely call `/v1/images` per asset | `GET file`, `GET file nodes` and `GET image` are **Tier 1: 10 requests/minute** on Professional. A 240-file package would hit the ceiling instantly | Batching is mandatory and shapes the whole worker design |

Corrections 4 and 5 are the ones that most change the product. Taken together they mean: **event-driven continuous sync is the wrong architecture.** An explicit, user-triggered publish is both technically necessary and better UX — designers do not want work-in-progress shipped to a client automatically.

---

## 1. Product overview

### Mission
Collapse the brand handoff — producing every format and colour variant of every asset, naming them, organising them, packaging them and delivering them — from half a day into one click.

### The problem, precisely stated
A brand identity freelancer finishes a project. The client needs the identity as a usable file package: each lockup (primary, secondary, submark, wordmark) in each colourway (full colour, mono black, mono white, reversed) in each format (SVG, PNG, JPG, PDF) at each scale (1x, 2x, 3x). That is a combinatorial grid — commonly 100–300 files. Today it is produced by hand, one export dialog at a time, renamed by hand, foldered by hand, zipped and emailed. It takes 4–5 unbillable hours per project.

### What this product is
A **package generator**. The designer marks assets once and defines a variant grid once per client. On command, the system fans that grid out into every required file, applies a naming convention, builds the folder tree, zips it, and delivers it.

**Figma is an ingestion adapter, not the product.** The engine takes artwork from any source that implements `SourceAdapter`. Two ship today:

| Source | Formats | Constraints |
| --- | --- | --- |
| **Figma** | SVG, PNG, JPG, PDF | 10 Tier 1 req/min; 32MP silent downscale; no print formats. Best "stays in sync" story |
| **Vector masters** (SVG folder) | SVG, PNG, JPG, PDF, **EPS, CMYK PDF** | None. No OAuth, no rate limit, no megapixel ceiling |

This matters strategically. It means the product is not hostage to Figma's roadmap or rate limits, it serves Illustrator and Affinity designers on day one, and — most immediately — **Phase 0 validation needs nothing but a folder of the designer's logo files.**

### What this product is *not*
- Not a Figma→Drive sync tool. That is a free Figma plugin, several times over (see market scan).
- Not a brand guidelines portal. Bravemark and Brandpad already own that, well, at $8–42/month.
- Not a DAM. Brandfolder and Bynder own that at $25k+/year.

### Positioning
**Complement, don't compete.** The incumbents are destinations you must manually fill. This fills them. The long-term wedge is being the layer between the design file and every delivery surface — Drive, zip, share link, and eventually Bravemark/Brandpad/Notion.

---

## 2. Success metrics

### The only metric that matters for the MVP
**Time-to-package.** Median wall-clock time from "designer clicks Generate" to "shareable, complete, correctly named package exists," measured against a stopwatch-timed manual baseline from the same designer on the same project.

Target: **under 10 minutes, versus a 4–5 hour manual baseline.**

### Supporting metrics
- **Rework rate:** % of generated packages the designer edits before sending. Above 30% means the naming convention or variant grid is wrong. This is the quality signal that matters most.
- **Package completeness:** % of files the designer expected that were actually generated.
- **Repeat use:** % of designers who generate a second package for a *different* client within 30 days. This is the real retention signal — a brand project is a one-off, so the product only has a business if it survives across projects.

### Deliberately not a metric
"Sync success rate" and "webhook acknowledgment latency" from v1. Those measure a system that isn't the product any more.

---

## 3. Personas

### Primary — Maya, freelance brand identity designer
Runs 4–8 brand projects a year for mid-size brands and music artists. Works in Figma for digital, Illustrator/InDesign for print. Bills by project. Loses 4–5 hours per project to the export grind, which she cannot bill for and resents. Uses Dropbox or Google Drive and a hand-built folder. Has not heard of Bravemark. Price-sensitive but would pay $15–30/month to get that afternoon back.

**Note on Illustrator/InDesign:** this is a live risk to the whole thesis. If a meaningful share of her deliverable is print-format (EPS, AI, CMYK/Pantone), a Figma-first product only addresses part of her problem. Section 9 must resolve this before you build.

### Secondary — Sam, two-person studio
Same workflow, more volume, and a consistency problem — two people naming files differently across projects. Values the enforced naming convention as much as the time saving.

### End consumer — the client
Non-technical. Marketing manager, artist manager, or founder. Wants to find "the white version of the logo for a dark background" without asking anyone. Success is them never emailing the designer to ask for a file.

---

## 4. Core concept: the Export Matrix

This is the product. Everything else is plumbing.

### Definition
An **Export Matrix** is a per-client reusable spec that maps *marked source nodes* × *colourways* × *formats* × *scales* to a set of output files with a deterministic naming convention.

### How the designer marks assets

**Primary path — the Handoff Figma plugin.** Select a frame, click "Mark as Primary Logo / Mono Black / …". The plugin writes `sharedPluginData` under a `handoff` namespace and **does not touch the layer name.** The backend reads it via `GET /v1/files/:key?plugin_data=shared`.

This is non-destructive, which matters more than it first appears: a designer's layer names are their own working system ("Primary Logo — final v3"), and a tool that renames them is a tool they will resent and eventually stop using.

**Fallback — the `@export/` name prefix.** For anyone who hasn't installed the plugin, and for scripted use:

```
@export/logo-primary              base node
@export/logo-primary/mono-black   designer-drawn colourway variant
```

Plugin data wins where both are present.

### How the designer uses it
1. Mark the assets (plugin, or prefix fallback).
2. In the web app, pick a matrix preset (Standard Brand Package, Logo Only, Social Kit) or customise the grid.
3. Click Generate.

### Example expansion

Given source nodes `logo-primary`, `logo-submark` and a grid of:
- colourways: `full-colour`, `mono-black`, `mono-white`
- formats: `svg`, `png`, `pdf`
- scales (raster only): `1x`, `2x`, `3x`

The system produces 2 × 3 × (1 svg + 3 png + 1 pdf) = **30 files**, named:

```
acme_logo-primary_full-colour.svg
acme_logo-primary_full-colour@2x.png
acme_logo-primary_mono-white@3x.png
...
```

Foldered as:

```
Acme Brand Package/
├── 01 Logos/
│   ├── SVG/
│   ├── PNG/
│   └── PDF/
├── 02 Colour/
│   └── acme-colour-palette.json + .txt (hex/rgb swatch list)
├── 03 Typography/
│   └── acme-typography.json + .txt
└── README.txt  (what's in here, which file to use when)
```

### Colourway generation — the hard part, and the honest answer

Figma's `/v1/images` endpoint renders a node **as it appears**. It cannot recolour. So mono/reversed variants must come from one of three places, in order of preference:

- **A. The designer already made them in Figma.** Detect sibling nodes (`@export/logo-primary/mono-black`) and use them directly. Zero risk, zero cleverness. **This is the v1 approach.**
- **B. SVG post-processing.** Export the SVG once, then rewrite `fill`/`stroke` attributes to a single colour. Works reliably for flat vector marks; breaks on gradients, embedded images, clipping masks and multi-tone illustrations. **v1.5, behind a preview-and-confirm step.** Never ship this silently — a wrongly recoloured logo sent to a client is worse than no product.
- **C. Ask the designer to supply the variant once, then reuse.** Fallback when A and B both fail.

Being upfront about this is important. A tool that *sometimes* mangles a logo is unusable in this market, where the mark is the entire deliverable.

### The 32-megapixel silent downscale

Figma caps image renders at 32 megapixels and **quietly scales anything larger down rather than returning an error.** A 4000×1200 wordmark at @3x is 43.2MP — the client receives a soft asset, and nothing in the API response says so.

This is precisely the class of defect that shows up as rework rather than as a failure, so it is checked at plan time, before anything renders, and the designer is told the maximum safe scale for that artboard:

```
SILENT DOWNSCALE WARNING
wordmark at @3x = 43.2MP (Figma caps at 32MP)
    Figma will downscale this without reporting an error.
    Max safe scale for this artboard: @2.58x
```

Note also that `scale` is capped at 4 by the API, so @5x and above are not available at any artboard size.

### Known limitations to state plainly in the product

Most of these are **Figma-source limitations**, not product limitations — the vector-master source clears them.

| Limitation | Figma source | Vector source |
| --- | --- | --- |
| EPS output | Impossible | **Supported** |
| CMYK PDF | Impossible | **Supported** (structure only — see below) |
| Renders above 32MP | Silently downscaled; warned | No ceiling |
| Render rate | 10 Tier 1 req/min | Unlimited |
| Design tokens | Local styles only (Variables are Enterprise-gated) | From an optional `palette.json` |
| Pantone / spot colour | Not derivable | Not derivable |
| Native `.ai` originals | Not produced | Not produced — use the print merge (5.6) |

**CMYK colour is the one that needs saying loudly.** Machine conversion produces structurally valid CMYK with *wrong colour values*. Those files are flagged `colourUnverified`, excluded from the "ready to send" count, and carry a prominent warning in the client-facing README. Never ship auto-converted brand colour as if it were correct.

---

## 5. Functional requirements

### 5.1 Authentication

- **Account:** email + password or Google sign-in, via Supabase Auth.
- **Figma OAuth2.** Scopes: `current_user:read`, `file_content:read`, `file_metadata:read`, `webhooks:read`, `webhooks:write`. Explicitly **not** `file_read` (deprecated) and **not** `file_variables:read` (Enterprise-only, would fail for the target user).
- **Google OAuth2.** Scope: `drive.file` only — per-file access to files the app creates. This is a non-sensitive scope and avoids Google's restricted-scope security review, which is a multi-week, multi-thousand-dollar process. Do not request `drive` or `drive.readonly`.
- Access and refresh tokens encrypted at rest (pgcrypto or app-level AES-GCM with a KMS-held key). Never stored in plaintext.

### 5.2 Project setup

- **Figma plugin** (in v1 scope): select a frame, assign it an asset role and colourway. Writes `sharedPluginData`; never renames layers.
- Connect a Figma file by URL; extract and store the file key.
- Scan for marked nodes — plugin data first, `@export/` prefix as fallback — and present them for confirmation.
- Choose or customise an Export Matrix.
- Choose a destination: Google Drive folder, downloadable zip, or both.

### 5.3 Generation (the core engine)

Triggered by an explicit **Generate** action, or optionally by a `FILE_VERSION_UPDATE` webhook when the designer names a version in Figma history.

The worker must:

1. `GET /v1/files/:key?plugin_data=shared` once — full document tree plus plugin markings. Cache aggressively; this is a Tier 1 call.
2. Walk the tree for marked nodes and any colourway siblings.
3. Parse `styles` from the document for local colour and text styles → build palette and typography JSON + human-readable `.txt`.
4. **Batch** `/v1/images` calls: **one call per (format, scale) pair with all node IDs in that call.** Never one call per asset. With 5 format/scale combinations this is 5 requests, comfortably inside the 10/min Tier 1 budget.
5. Check every planned raster render against the 32MP ceiling; warn before rendering.
6. **Stream** each download through the zip and into the destination. See below.
7. Record a content hash per file, computed in flight, for delta detection on regeneration.

#### Streaming is mandatory, not an optimisation

A 300-file package of @3x PNGs and PDFs is comfortably over a gigabyte. Serverless functions cap at roughly 500MB–1GB of memory, with a similar `/tmp` ceiling — so any design that assembles the folder tree on disk or holds files in memory before zipping will fail on exactly the large packages that matter most.

The pipeline must therefore:

- Pipe each Figma download **directly** into a live `archiver` zip stream, which pipes **directly** into an S3 multipart upload. Nothing is fully materialised — not the individual files, not the tree, not the finished zip.
- Compute the SHA-256 with a transform in the stream path, since buffering the file to hash it afterwards would defeat the purpose.
- Bound concurrency with an **ordered prefetch window** (~6). Zip entries must be appended sequentially, but downloading one at a time is latency-bound; an ordered window gives concurrency while capping how many response bodies are open at once. That window is what actually bounds memory.
- **Store rather than deflate** PNG, JPG and PDF. They are already compressed; deflating them burns billed CPU for effectively zero size reduction. SVG, JSON and TXT deflate normally.

**Verified in the prototype:** 305 files totalling 1,500MB of payload streamed through with **6.7MB of peak RSS growth** against a ~1GB ceiling. `npm run memcheck` reproduces this and fails the build if someone reintroduces buffering.

#### Inngest step payload limits

A related trap: Inngest persists every step's return value, and step outputs are size-limited. **Never return file contents from a step.** Steps pass object keys, manifests and counts; bytes move through the stream, not through the orchestrator.

### 5.4 Rate limit handling (non-negotiable)

Tier 1 endpoints are **10/min on Professional** for Full/Dev seats. Requirements:

- A token-bucket limiter in front of every Figma call, keyed per user.
- On `429`, read the `Retry-After` header and back off for exactly that duration. Do not use a fixed backoff.
- Surface `X-Figma-Upgrade-Link` to the user when the 429 is caused by their seat type rather than app behaviour.
- Users on **View or Collab seats are capped at 6 Tier 1 requests per month** — effectively unusable. Detect this at onboarding and tell them before they pay.

### 5.5 Delivery

- **Zip:** streamed to object storage, downloadable via a signed expiring URL.
- **Google Drive:** structured folder tree, resumable upload for anything over 5 MB, `permissions.create` with `role: reader`, `type: anyone` to produce a link — or a specific email address for a private share.
- **README.txt** auto-generated into every package: what's inside, which file to use when, colour values in copyable text, and an explicit list of anything that failed to generate.

### 5.6 Print asset merge

Figma cannot produce EPS, AI, or CMYK/Pantone output. Rather than leaving that as a hole in the deliverable, the packaging step accepts designer-supplied print files and merges them into the generated tree.

**The important design decision:** this is not a bare drop-zone. The Export Matrix already knows the full set of assets, so the UI presents a **checklist of expected print files** derived from the matrix, and matches each upload to a slot:

```
Print assets — 2 of 4 supplied
  ✓ acme_logo-primary_full-colour.eps      uploaded
  ✓ acme_logo-primary_mono-black.eps       uploaded
  ○ acme_logo-secondary_full-colour.eps    missing
  ○ acme_submark_full-colour.eps           missing
```

Uploads are renamed to the package convention automatically and filed into `05 Print/`. This converts a dumb upload box into a completion tracker — and it means the designer finds out about a missing print file *before* the package goes to the client rather than after.

**Honest accounting of what this saves.** If the handoff splits roughly 55% digital variant generation / 15% naming and foldering / 10% zip and delivery / 20% print-file creation in Illustrator, then automating everything except the print creation itself saves **around 55–65%**, not 80%. The designer still has to draw the EPS. That's a very good outcome — 4.5 hours down to about 1.5 — and it's worth stating accurately, because a product that promises 80% and delivers 60% loses the trust that gets it renewed.

### 5.7 Regeneration

- Re-running against the same file compares content hashes and uploads only changed files.
- The designer sees a diff summary before anything is sent: "4 files changed, 2 added, 1 removed."
- Never silently overwrite a package a client already has.

---

## 6. Technical architecture

Broadly as v1, with corrections.

| Layer | Technology | Notes |
| --- | --- | --- |
| Framework | Next.js (App Router) + TypeScript | Unchanged |
| Styling | Tailwind CSS | Unchanged |
| Figma plugin | Figma Plugin API + TypeScript | **In v1.** Writes `sharedPluginData`; also the primary distribution channel |
| DB & Auth | Supabase (Postgres) | Unchanged. Use Row Level Security from day one |
| Background jobs | Inngest | **Required, not optional.** Generation takes minutes and will blow any serverless request timeout. Step functions give per-step retries. Keep step return values small — never file contents |
| Object storage | S3 or Supabase Storage | Written via `@aws-sdk/lib-storage`'s `Upload`, which handles multipart from a stream. Supabase Storage exposes an S3-compatible endpoint, so the same code targets either |
| Zip | `archiver` | Streamed, never buffered. `store` for precompressed formats, deflate for text |
| Rate limiting | Upstash Redis | Token bucket, per user, in front of every Figma call |
| Integrations | Figma REST API, Google Drive API v3 | See scope corrections in 5.1 |

### Why generation cannot run in a request handler
A 200-file package involves ~5 Figma image calls (some of which may 429 and back off for 60s+), 200 downloads, a zip build and a Drive upload. Realistic p50 is 2–5 minutes; p95 could be 15. This must be a durable background job with per-step retries and a progress stream to the UI.

### Why it cannot buffer
See 5.3. The short version: a large package exceeds the serverless memory and `/tmp` ceilings, so the bytes must never stop moving. Measured at 6.7MB of RSS growth for 1.5GB of payload.

---

## 7. Data model

**This schema is source-agnostic by construction.** An earlier draft had `projects.figma_file_key` and `source_nodes.figma_node_id`, which would have baked Figma into the column names and broken invariant 5 at the database layer — the most expensive place to undo it. Sources are now polymorphic.

```
users
  id, email, created_at
  google_access_token_enc, google_refresh_token_enc, google_expires_at

source_connections         -- one row per connected source, per user
  id, user_id
  kind                     -- 'figma' | 'vector_upload'  (extensible)
  access_token_enc, refresh_token_enc, expires_at   -- null for vector_upload
  seat_type                -- figma only; gate View/Collab at onboarding
  plan_tier                -- figma only; from X-Figma-Plan-Tier
  created_at

projects
  id, user_id, name, client_name
  source_connection_id
  source_kind              -- denormalised for query convenience
  source_ref               -- figma: file key. vector_upload: storage prefix
  source_label             -- human-readable: file name or folder name
  export_matrix_id
  destination_type         -- 'drive' | 'zip' | 'both'
  drive_folder_id
  naming_template          -- e.g. '{client}_{asset}_{colourway}{scale}'
  created_at

source_assets              -- was source_nodes; "node" was a Figma word
  id, project_id
  source_ref               -- figma: node id "1:23". vector: storage object key
  source_name              -- original layer or file name
  asset_slug
  colourway                -- null if this is the base asset
  marked_by                -- 'plugin' | 'prefix' | 'filename'
  width_px, height_px      -- null if unknown; drives the 32MP check
  detected_at

uploaded_masters           -- vector_upload sources and print merge (5.6)
  id, project_id
  storage_key              -- object storage path
  original_filename
  kind                     -- 'vector_master' | 'print_asset'
  format                   -- 'svg' | 'pdf' | 'eps' | 'ai'
  bytes, content_hash
  uploaded_at

export_matrices
  id, user_id, name, is_preset
  colourways               -- jsonb: ['full-colour','mono-black','mono-white']
  formats                  -- jsonb: ['svg','png','pdf','eps','pdf-cmyk']
  scales                   -- jsonb: [1,2,3]
  folder_template          -- jsonb: folder tree structure
  naming_template

generations                -- replaces v1's sync_jobs
  id, project_id
  trigger                  -- 'manual' | 'webhook' | 'scheduled'
  status                   -- 'queued'|'fetching'|'rendering'|'packaging'|'delivering'|'complete'|'failed'
  files_expected, files_completed
  files_colour_unverified  -- excluded from the ready-to-send count
  unsupported_formats      -- jsonb; formats this source could not produce
  error_code, error_detail
  drive_folder_id, zip_storage_key
  started_at, completed_at

generated_files            -- replaces v1's assets
  id, generation_id, source_asset_id
  filename, folder_path
  format, scale, colourway
  colour_unverified        -- bool NOT NULL DEFAULT false; see invariant 4
  content_hash             -- for delta detection on regeneration
  bytes
  drive_file_id
  status                   -- 'pending'|'rendered'|'uploaded'|'skipped'|'failed'
  skip_reason              -- surfaced in the client README
```

Three things worth stating explicitly, because each encodes an invariant:

- **No `figma_` prefixed columns anywhere.** `source_kind` + `source_ref` is the polymorphic pair. Adding Illustrator or Dropbox is a new `kind` value and a new adapter, not a migration.
- **`generated_files.colour_unverified` is persisted, not computed.** Invariant 4 requires excluding machine-converted CMYK from ready-to-send counts, and that count has to survive a page reload.
- **`generations`, not `sync_jobs`.** The unit of work is producing a package, not syncing a file. If the schema still says "sync," the team will keep building v1.

---

## 8. Scope

### In scope for v1
- Figma + Google OAuth with correct scopes
- **Figma plugin** for node marking via `sharedPluginData`, plus `@export/` prefix fallback
- Node detection and confirmation UI
- Export Matrix with 3 presets and a custom editor
- Batched, rate-limit-aware rendering via `/v1/images`
- 32MP silent-downscale detection and warning
- Colourway approach **A only** (designer-supplied variants detected from Figma)
- Local style extraction → palette and typography JSON + txt
- **Fully streamed** packaging: download → zip → object storage, nothing buffered
- Naming convention, folder tree, README generation
- **Print asset merge** with a matrix-derived completion checklist
- Google Drive upload + share link
- Generation progress UI with per-step status

### Explicitly out of scope for v1
- **Automatic colourway recolouring (approach B)** — v1.5, behind preview-and-confirm
- **Continuous / webhook-triggered sync** — the 30-minute `FILE_UPDATE` lag makes it a bad experience; add `FILE_VERSION_UPDATE` opt-in later once manual generation is proven
- Generating EPS, AI, CMYK or Pantone — impossible via the Figma API. Merged from designer uploads instead (5.6)
- Figma Variables — Enterprise-plan gated
- Dropbox, Notion, Slack destinations
- Two-way sync, conflict resolution
- Client-facing portal (that's Bravemark's product)
- Teams, SSO, RBAC

---

## 9. Validation plan — do this before writing production code

The prototype exists to make these conversations concrete. It is not a v1.

**Recruit 8–10 freelance brand identity designers.** Your designer contact plus her network is the obvious start.

**Use the vector source for this, not Figma.** It removes every barrier to running the test: no OAuth consent, no plugin install, no Figma seat requirement, and it works for designers who don't use Figma at all. You ask for a folder of SVGs and hand back a finished package. That turns a multi-week "build auth first" dependency into a same-day conversation.

For each, in one 45-minute call:

1. **Watch them do a real handoff, timed.** Don't ask how long it takes — watch. Record where each minute goes. This validates or kills the assumption that variant generation is 50–60% of the time.
2. **Measure what share of their deliverable is print-format** (EPS, AI, CMYK, Pantone) and whether it originates in Illustrator/InDesign rather than Figma. This is no longer a binary kill test — the print asset merge (5.6) means print-heavy designers still get the digital expansion automated. What the number changes is *the honest savings claim*, and therefore pricing and positioning:

   | Print share of handoff time | Savings from Handoff | Implication |
   | --- | --- | --- |
   | Under 20% | ~75–80% | Strong standalone product |
   | 20–40% | ~55–65% | Still compelling; lead with the digital grid |
   | Over 50% | ~35–45% | Marginal. Figma is the wrong entry point — reconsider an Illustrator-first tool |
3. **Ask what they use today.** If they already use Bravemark or Brandpad, you are building an integration, not a product. If they use Dropbox and a hand-built folder, you are building a product. This determines the business.
4. **Show the prototype's output** — a generated package — and ask: would you send this to a client as-is, or would you fix things first? Every fix they'd make is a v1 requirement you don't have yet.
5. **Price test:** "$19/month, unlimited packages." Watch the reaction before they answer.

### Kill criteria
Be willing to stop. Stop if:
- Variant generation turns out to be under ~25% of the handoff time — the wedge isn't real. **This is now the only true kill criterion.**
- Designers won't send generated output without hand-fixing it — the quality bar is unreachable.

**The print criterion is retired.** In v2 it was "most work is print-native → kill". In v3 it softened to a threshold. In v4 it is gone: the vector source generates EPS and CMYK directly, so a print-heavy designer is a *supported user*, not a disqualifying signal. What print share now changes is which source you lead with, not whether the product exists.

---

## 10. Open questions

1. **Naming conventions vary per designer and per client.** Is a configurable template enough, or does every designer have idiosyncratic rules that make templating insufficient? (Test in validation call 4.)
2. ~~Does the `@export/` prefix feel natural, or is a plugin required?~~ **Resolved: build the plugin, in v1.** Asking a visual designer to hand-type `@export/logo-primary/mono-black` invites exactly the transcription errors that inflate the rework metric. `sharedPluginData` lets the plugin mark nodes without renaming layers, and it is readable over REST via `?plugin_data=shared`. The Figma Community listing is also the most direct answer to the discovery problem the market scan surfaced. Remaining sub-question: **how long does Figma Community review take,** and does it gate launch? Check before committing the timeline.
3. **Is Google Drive even the right destination,** or do designers prefer a share link they control? Drive means the file lives in the client's world and the designer loses the ability to update it.
4. **What's the retention story?** A brand project is a one-off. If a designer does 6 projects a year, is a monthly subscription defensible, or is this a per-package purchase?
5. **Should this be a Bravemark/Brandpad integration rather than a standalone product?** Strategically this may be the strongest position — you'd inherit their distribution and solve the half they don't. Worth a conversation with Bravemark directly.

---

## Appendix — verified API constraints

Everything below was checked against Figma's live developer documentation on 26 July 2026.

**OAuth scopes:** `file_read` is deprecated. Granular scopes now: `file_content:read`, `file_metadata:read`, `file_versions:read`, `webhooks:read`, `webhooks:write`, `current_user:read`, `library_content:read`. `file_variables:read` and `library_analytics:read` are **Enterprise plan only**.

**Rate limits (updated 17 Nov 2025):**

| Tier | Endpoints | Professional (Full/Dev seat) | View/Collab seat |
| --- | --- | --- | --- |
| 1 | GET file, GET file nodes, **GET image** | **10/min** | 6/**month** |
| 2 | GET image fills, webhooks, version history, projects, variables | 25/min | 5/min |
| 3 | GET file metadata, components & styles, users | 50/min | 10/min |

Leaky bucket algorithm. `429` returns `Retry-After`, `X-Figma-Plan-Tier`, `X-Figma-Rate-Limit-Type`, `X-Figma-Upgrade-Link`.

**Webhook events:**
- `FILE_UPDATE` — fires **within 30 minutes of editing inactivity**. Not real-time.
- `FILE_VERSION_UPDATE` — fires when a user names a version in file history. **This is the correct publish signal.**
- `LIBRARY_PUBLISH` — library files only; may arrive split across multiple events for large publishes.

**Webhook limits:** 3 per file, 5 per project, 20 per team. Total file webhooks: 150 (Professional), 300 (Organization), 600 (Enterprise). Creating a file webhook requires `Can edit` on that file.

**Webhook retries:** Figma retries failures 3 times — at 5 minutes, 30 minutes, then 3 hours. Endpoints with frequent errors are not deactivated.

**GET image constraints:**
- **Images up to 32 megapixels.** Anything larger is silently scaled down, not rejected.
- `scale` accepts 0.01–4, so @4x is the hard ceiling.
- Rendered URLs **expire after 30 days** — the bytes must be copied, not linked.
- `svg_outline_text` defaults to `true`, converting text to vector paths. Correct for logos and wordmarks: it removes the font dependency at the client's end.
- `use_absolute_bounds` is needed to export text nodes without cropping.

**Plugin data:** `GET /v1/files/:key` and `GET /v1/files/:key/nodes` both accept a `plugin_data` query parameter taking a comma-separated list of plugin IDs and/or the string `shared`. Matching data is returned in `pluginData` / `sharedPluginData`. This is what makes non-destructive plugin marking possible.

**Google Drive:** `drive.file` is a non-sensitive scope granting per-file access to files the app created — sufficient for upload and for `permissions.create`, and it avoids restricted-scope verification.

### Sources
- [Figma REST API — Scopes](https://developers.figma.com/docs/rest-api/scopes/)
- [Figma REST API — Rate Limits](https://developers.figma.com/docs/rest-api/rate-limits/)
- [Figma REST API — File endpoints (GET file, GET image, plugin_data)](https://developers.figma.com/docs/rest-api/file-endpoints/)
- [Figma REST API — Webhooks V2](https://developers.figma.com/docs/rest-api/webhooks/)
- [Figma REST API — Webhook Events](https://developers.figma.com/docs/rest-api/webhooks-events/)
- [Google Drive API — Choose scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Google Drive API — Share files](https://developers.google.com/workspace/drive/api/guides/manage-sharing)
