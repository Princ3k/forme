# Build Plan — Handoff
**Date:** 26 July 2026

---

## What changed in this revision

The engine is no longer Figma-only. Figma is one `SourceAdapter`; a vector-master adapter (local SVG→PNG/PDF/EPS/CMYK conversion) is the second. Consequences for this plan:

- **Phase 0 no longer blocks on auth.** Validation runs on the vector source, which needs no OAuth, no plugin and no Figma seat — just a folder of the designer's SVGs. You can start interviews immediately.
- **Figma OAuth moves off the critical path.** It's still needed for the flagship experience, but it no longer gates the thing you most need to learn.
- **EPS and CMYK move from "impossible" to "shipped".** The print-asset merge is downgraded from essential to a convenience for native `.ai` originals.

---

## Sequencing principle

**Phase 0 is not optional and comes before everything.** The prototype in `prototype/` exists to make Phase 0 conversations concrete. Do not start Phase 1 until Phase 0's kill criteria are cleared — the market scan showed this space has real incumbents, so building on an unvalidated thesis is expensive.

Estimates assume one competent full-stack developer. Halve nothing.

---

## Phase 0 — Validate (1–2 weeks, no production code)

| # | Ticket | Detail | Done when |
| --- | --- | --- | --- |
| 0.1 | Run the prototype against 3 real brand identities | **Use the vector source** — ask for a folder of SVGs. No OAuth, no plugin, works regardless of their tool | You have 3 generated packages to show |
| 0.2 | Time a real manual handoff | Screen-record a designer doing one end to end. Log where every minute goes | You have a per-step time breakdown, not an estimate |
| 0.3 | Interview 8–10 freelance brand designers | Script in PRD §9. Focus on: print-format share, current tooling, willingness to send generated output unedited | 8+ completed calls, written up |
| 0.4 | Price test | "$19/month unlimited" — reaction before answer | Documented |
| 0.5 | **Go / no-go decision** | Against PRD §9 kill criteria | Written decision, either way |

**Kill criteria — stop if either holds:**
- Variant generation is under ~25% of handoff time
- Designers won't send generated output without hand-fixing it

*(The print-native criterion is retired — the vector source generates EPS and CMYK directly, so a print-heavy designer is a supported user, not a disqualifying signal.)*

---

## Phase 1 — Core engine (3–4 weeks)

The point of this phase is a working generation pipeline for one hardcoded user. No multi-tenancy, no polish.

### Epic 1.1 — Foundations
| # | Ticket | Est. |
| --- | --- | --- |
| 1.1.1 | Next.js + TypeScript + Tailwind scaffold; env config; CI with typecheck and lint | 1d |
| 1.1.2 | Supabase project; schema migration for all tables in PRD §7; **RLS policies on every table from day one** | 1d |
| 1.1.3 | Token encryption helper (AES-GCM, key from env/KMS). Unit tested. No plaintext tokens, ever | 0.5d |
| 1.1.4 | Upstash Redis token-bucket limiter, keyed per user per tier | 1d |

### Epic 1.2 — Source adapters
| # | Ticket | Est. |
| --- | --- | --- |
| 1.2.0a | `SourceAdapter` interface + `AdapterCapabilities`. Matrix planner drops formats the source can't produce and reports them once, up front | 1d |
| 1.2.0b | **Vector-master adapter**: ingest SVG folder, filename convention `<asset>[.<colourway>].svg`, optional `palette.json`. cairosvg + Ghostscript for PNG/PDF/EPS/CMYK. **Build this first — Phase 0 depends on it** | 2.5d |
| 1.2.0c | Toolchain preflight (`doctor`): verify cairosvg and Ghostscript present, fail with install instructions rather than mid-package | 0.5d |
| 1.2.0d | CMYK fidelity guard: flag machine-converted files `colourUnverified`, exclude from ready-to-send counts, prominent README warning | 0.5d |

### Epic 1.2b — Figma adapter
| # | Ticket | Est. |
| --- | --- | --- |
| 1.2.1 | Typed Figma REST client wrapping every call in the rate limiter | 1d |
| 1.2.2 | **429 handling: read `Retry-After` and sleep exactly that long.** Capture `X-Figma-Plan-Tier` and `X-Figma-Upgrade-Link`. Unit test with a mocked 429 | 1d |
| 1.2.3 | `GET /v1/files/:key` + document tree walker; find `@export/`-prefixed nodes and colourway siblings | 1.5d |
| 1.2.4 | Local style extraction → palette + typography JSON. **Not** the Variables API (Enterprise-gated) | 1.5d |
| 1.2.5 | **Batched image rendering: one `/v1/images` call per (format, scale) with all node IDs.** This is the single most important ticket in the phase — a per-asset implementation makes the product unusable | 2d |
| 1.2.6 | Parallel download of returned S3 URLs with a concurrency cap | 0.5d |

### Epic 1.3 — Packaging (streaming throughout)
| # | Ticket | Est. |
| --- | --- | --- |
| 1.3.1 | Export Matrix expander: (nodes × colourways × formats × scales) → file plan | 1.5d |
| 1.3.2 | Naming template engine (`{client}_{asset}_{colourway}{scale}`) with slug sanitisation and collision guard | 1d |
| 1.3.3 | Folder tree assembler from matrix `folder_template` | 1d |
| 1.3.4 | README.txt generator — contents, usage guidance, copyable colour values, list of anything that failed | 0.5d |
| 1.3.5 | **Streaming zip: `archiver` piped into an S3 multipart `Upload`.** Ordered prefetch window for bounded concurrency; `store` for PNG/JPG/PDF, deflate for text. Nothing buffered | 2d |
| 1.3.6 | Content hashing via an in-stream transform, persisted for delta detection | 0.5d |
| 1.3.7 | **Memory benchmark in CI.** Push >1GB of synthetic payload through the real path and fail the build if RSS growth exceeds 100MB. This is the regression guard for 1.3.5 | 0.5d |
| 1.3.8 | 32MP downscale detection — warn at plan time with the max safe scale for each artboard | 0.5d |

### Epic 1.4 — Orchestration
| # | Ticket | Est. |
| --- | --- | --- |
| 1.4.1 | Inngest setup; `generation.requested` event | 0.5d |
| 1.4.2 | Generation step function: fetch → parse → render → stream-package → deliver, with per-step retry. **Step return values carry keys and manifests only — never file contents.** Inngest persists step output and size-limits it | 2d |
| 1.4.3 | Progress persistence to `generations` + `generated_files`; failure states carry a usable error message | 1d |

**Phase 1 exit:** a script generates a complete, correctly named, correctly foldered zip from a real Figma file without hitting a rate limit — and the memory benchmark passes.

---

## Phase 2 — Product shell (3–4 weeks)

### Epic 2.1 — Auth & connections
| # | Ticket | Est. |
| --- | --- | --- |
| 2.1.1 | Supabase Auth: email + Google sign-in | 1d |
| 2.1.2 | **Figma OAuth2 with correct scopes:** `current_user:read`, `file_content:read`, `file_metadata:read`, `webhooks:read`, `webhooks:write`. Refresh-token rotation | 2d |
| 2.1.3 | **Google OAuth2, `drive.file` scope only.** Do not request broader scopes — restricted-scope verification is weeks and thousands of dollars | 1.5d |
| 2.1.4 | **Detect Figma seat type at onboarding. Block or warn View/Collab seats** (6 Tier 1 requests per *month* — the product cannot work). Better to lose the signup than take the money | 1d |

### Epic 2.2 — Figma plugin (moved into v1)
| # | Ticket | Est. |
| --- | --- | --- |
| 2.2.1 | Plugin scaffold; manifest; build pipeline | 1d |
| 2.2.2 | **Marking UI: select frame → assign asset role + colourway.** Writes `setSharedPluginData('handoff', …)`. Never renames the designer's layers | 2.5d |
| 2.2.3 | Panel showing everything currently marked in the file, with unmark and re-assign | 2d |
| 2.2.4 | Backend reads markings via `GET /v1/files/:key?plugin_data=shared`; `@export/` prefix retained as fallback | 1d |
| 2.2.5 | Figma Community listing: description, cover art, submission. **Check review turnaround early — it may gate launch** | 1d |

### Epic 2.3 — Project setup UI
| # | Ticket | Est. |
| --- | --- | --- |
| 2.3.1 | Connect-a-Figma-file flow; parse file key from URL; validate access | 1d |
| 2.3.2 | Detected-node review screen — confirm/rename/exclude before generating | 2d |
| 2.3.3 | Export Matrix editor + 3 presets (Standard Brand Package, Logo Only, Social Kit) | 3d |
| 2.3.4 | Destination picker: Drive folder / zip / both | 1.5d |
| 2.3.5 | **Print asset merge:** matrix-derived checklist of expected print files, upload slots, auto-rename to convention, file into `05 Print/` | 2.5d |

### Epic 2.4 — Google Drive delivery
| # | Ticket | Est. |
| --- | --- | --- |
| 2.4.1 | Drive client: folder tree creation, resumable upload above 5 MB, fed from the same stream | 2d |
| 2.4.2 | `permissions.create` — anyone-with-link reader, or a named email | 1d |
| 2.4.3 | Drive folder picker UI | 1d |

### Epic 2.5 — Generation UX
| # | Ticket | Est. |
| --- | --- | --- |
| 2.5.1 | Generate button + live progress (per-step, with file counts) | 2d |
| 2.5.2 | Result screen: file manifest, share link, download zip | 1.5d |
| 2.5.3 | **Human-readable failure states.** "Figma rate limit reached, resuming in 47s" — not "Error 429" | 1d |
| 2.5.4 | Surface 32MP downscale warnings in the UI with the max safe scale, before generation runs | 0.5d |

**Phase 2 exit:** a designer who has never seen the codebase can install the plugin, mark assets, connect Drive, and generate a package unaided.

---

## Phase 3 — Make it good enough to send (2–3 weeks)

This phase determines whether the product is usable. Rework rate is the metric.

| # | Ticket | Est. |
| --- | --- | --- |
| 3.1 | Regeneration with content-hash delta detection | 2d |
| 3.2 | **Diff preview before delivery** — "4 changed, 2 added, 1 removed." Never silently overwrite a package a client already has | 2d |
| 3.3 | Custom naming template editor with live preview | 2d |
| 3.4 | Package preview — thumbnail grid of every generated file before it ships | 3d |
| 3.5 | Per-project matrix overrides | 1d |
| 3.6 | Error recovery: resume a partially failed generation instead of restarting | 2d |

---

## Phase 4 — Post-MVP, in priority order

| Priority | Item | Note |
| --- | --- | --- |
| 1 | **Colourway auto-generation (approach B)** | SVG fill/stroke rewriting. **Behind mandatory preview-and-confirm.** Breaks on gradients, embedded images, clipping masks. A silently mangled logo is worse than no feature |
| 2 | `FILE_VERSION_UPDATE` webhook opt-in | Auto-generate when the designer names a version. Only after manual generation is proven |
| 3 | Bravemark / Brandpad integration | Possibly the strongest strategic move — see PRD §10 Q5 |
| 4 | Dropbox destination | Second-most-requested, likely |
| 5 | Client-facing package page | Careful: this is Bravemark's product, not yours |

*(The Figma plugin was priority 1 here in v1 of this plan; it has been promoted into Phase 2 as Epic 2.2.)*

**Deliberately never:** *generating* EPS/AI (impossible via Figma API — merged from uploads instead), CMYK/Pantone colour conversion, two-way sync, SSO/RBAC.

---

## Critical path

```
1.2.0a adapter interface
  └─> 1.2.0b VECTOR ADAPTER ──> 0.1-0.5 PHASE 0 VALIDATION ──> go/no-go
        │                            (no auth needed)              │
        └─> 1.3.1 matrix expander                                  │
              └─> 1.3.5 STREAMING ZIP ─> 1.3.7 memory benchmark    │
                    └─> 1.4.2 step function <──────────────────────┘
                          ├─> 1.2.1 Figma client ─> 1.2.5 BATCHED RENDERING
                          │     └─> 2.1.2 Figma OAuth
                          │           └─> 2.2.2 plugin marking UI
                          │                 └─> 2.2.5 Community listing (long lead)
                          └─> 2.5.1 generate UI
                                └─> 3.4 package preview
```

Note the reordering: **the vector adapter now precedes validation, and Figma follows it.** The cheapest path to learning whether this product should exist runs entirely through local conversion.

**Two highest-risk tickets, both in Phase 1:**

- **1.2.5 (batched rendering).** Everything downstream assumes generation fits a 10 req/min budget. Load-test against a real 200-file package before any UI work.
- **1.3.5 (streaming zip).** If this buffers, large packages OOM on serverless — and large packages are exactly the ones worth automating. Pair it with 1.3.7 so the guarantee is enforced by CI rather than by memory.

**Start 2.2.5 (Figma Community submission) early.** Review turnaround is outside your control and it is the distribution channel, not a nice-to-have.

---

## Risk register

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Figma Tier 1 rate limits make large packages impractically slow | **Medium** *(was High)* | Batch by (format, scale). Load-test with 200+ files. **Also de-risked structurally: the vector source has no rate limit at all**, so Figma's ceiling can no longer sink the product |
| Print-native work dominates the handoff | **Low** *(was High)* | Retired as a kill criterion — the vector source generates EPS and CMYK directly |
| **Auto-converted CMYK ships as if colour-accurate** | **High** | Flagged `colourUnverified`, excluded from ready-to-send counts, prominent README warning. Never present machine colour as correct |
| Conversion toolchain absent in the deploy environment | Medium | `doctor` preflight; bundle cairosvg + Ghostscript in the container image |
| **Serverless OOM on large packages** | **High** | Stream end to end; never buffer. Enforced by the CI memory benchmark (1.3.7). Verified at 6.7MB RSS for 1.5GB of payload |
| Generated output isn't good enough to send unedited | **High** | Phase 3.4 preview. Track rework rate |
| **Figma silently downscales renders above 32MP** | Medium | Detected at plan time (1.3.8), surfaced in UI (2.5.4). Would otherwise ship soft logos with no error. Absent entirely on the vector source |
| **Figma Community review gates launch** | Medium | Submit early (2.2.5). Prefix fallback means the product works without the plugin if review drags |
| Bravemark ships Figma ingestion | Medium | Move fast; consider partnering instead |
| Google restricted-scope review | Medium | `drive.file` only. Never request broader |
| Auto-recolouring mangles a logo | Medium | Approach A in v1. B behind confirm, never silent |
| Retention — brand projects are one-offs | Medium | Test per-package pricing alongside subscription in Phase 0 |
| Inngest step payload limits | Low | Steps pass keys and manifests, never file bytes |
| Figma changes rate limits again | Low | They changed 17 Nov 2025 and reserve the right to again. Keep limits configurable, not hardcoded |
