# Build Plan — Handoff
**Date:** 26 July 2026

---

## Status — read this first

**The prototype already implements most of Phase 1.** Epics 1.2, 1.2b and 1.3
are largely built and tested in this repo: 34 passing tests, clean typecheck,
memcheck at ~7MB RSS for 1.5GB of payload. Roughly 18 of the 22 days those
epics budget are already spent.

Tickets below are marked:

- **[DONE]** — built and tested in the prototype
- **[HARDEN]** — logic exists, needs productionising (config, errors, wiring)
- no marker — genuinely outstanding

**Revised Phase 1 estimate: 1.5–2 weeks, not 3–4.** What actually remains is
Epic 1.1 (foundations), Epic 1.4 (orchestration), the S3 sink, and hardening.

**But do not start Phase 1 yet.** Phase 0 needs no Epic 1.1 ticket — validation
runs entirely off the CLI on the vector source. Install the toolchain, generate
three real packages, talk to eight designers. That is the cheapest next move by
a wide margin.

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
| 0.0 | **Install the conversion toolchain** | `pip3 install cairosvg && brew install ghostscript`, then `npm run doctor` until green. **0.1 is blocked until this passes** — the vector source is the Phase 0 critical path and it shells out | `npm run doctor` reports all present |
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
| 1.1.1 | Next.js + TypeScript + Tailwind scaffold; env config; CI running typecheck, tests and memcheck. **Add ESLint — there is currently no linter at all, only a typecheck script** | 1.5d |
| 1.1.2 | Supabase project; schema migration for PRD §7. **§7 was rewritten to be source-agnostic — no `figma_` columns. Use `source_kind` + `source_ref`, and note `generated_files.colour_unverified` must be persisted (invariant 4).** RLS on every table from day one | 1.5d |
| 1.1.3 | Token encryption helper (AES-GCM, key from env/KMS). Unit tested. No plaintext tokens, ever | 0.5d |
| ~~1.1.4~~ | ~~Upstash Redis token-bucket limiter~~ **CUT from Phase 1.** Phase 1 targets one hardcoded user; a distributed limiter for one user is premature. The in-process `RateLimiter` is correct and now tested. Inngest also ships per-key `concurrency` and `throttle`, which covers most of this declaratively — and Inngest is already committed in 1.4.1. Revisit when Epic 2.1 introduces real multi-tenancy | — |

### Epic 1.2 — Source adapters
| # | Ticket | Est. |
| --- | --- | --- |
| 1.2.0a | **[DONE]** `SourceAdapter` interface + `AdapterCapabilities`. Planner drops unsupported formats and reports them once, up front | — |
| 1.2.0b | **[DONE]** Vector-master adapter: SVG folder, `<asset>[.<colourway>].svg`, optional `palette.json`, cairosvg + Ghostscript + Pillow | — |
| 1.2.0c | **[DONE]** Toolchain preflight (`doctor`). Probes cairosvg, Pillow and Ghostscript. **Keep exhaustive:** every binary `convert.ts` invokes must be probed here, or failures surface per-file mid-package | — |
| 1.2.0d | **[DONE]** CMYK fidelity guard: `colourUnverified` flag, excluded from ready-to-send, prominent README warning | — |
| 1.2.0e | **[HARDEN]** Vector adapter currently reads from a local directory. Repoint at object storage for uploaded masters | 1d |

### Epic 1.2b — Figma adapter
| # | Ticket | Est. |
| --- | --- | --- |
| 1.2.1 | **[DONE]** Typed Figma REST client wrapping every call in the rate limiter | — |
| 1.2.2 | **[DONE]** 429 handling honouring exact `Retry-After`; captures `X-Figma-Plan-Tier` and `X-Figma-Upgrade-Link`. Six `RATE LIMIT:` tests against an injected clock and stubbed fetch | — |
| 1.2.3 | **[DONE]** `GET /v1/files/:key?plugin_data=shared` + tree walker; plugin data and `@export/` prefix, with colourway siblings | — |
| 1.2.4 | **[DONE]** Local style extraction → palette + typography JSON. Not the Variables API (Enterprise-gated) | — |
| 1.2.5 | **[DONE]** Batched image rendering, one `/v1/images` call per (format, scale). Two `BATCHING:` tests lock this in — 200 files cost 6 Tier 1 requests | — |
| 1.2.6 | **[DONE]** Bounded-concurrency download via `orderedPrefetch` | — |
| 1.2.7 | **[HARDEN]** Wire `onRateLimit` through to generation progress so the UI shows "resuming in 47s" (satisfies 2.5.3) | 0.5d |

### Epic 1.3 — Packaging (streaming throughout)
| # | Ticket | Est. |
| --- | --- | --- |
| 1.3.1 | **[DONE]** Export Matrix expander: (assets × colourways × formats × scales) → file plan | — |
| 1.3.2 | **[DONE]** Naming template engine with slug sanitisation and path-collision guard | — |
| 1.3.3 | **[DONE]** Folder tree assembler from matrix `folder_template` | — |
| 1.3.4 | **[DONE]** README.txt generator — contents, usage guidance, colour values, skipped-file list, CMYK warning | — |
| 1.3.5 | **[HARDEN]** Streaming zip is done and benchmarked, piping into any `Writable`. **Outstanding: the S3 sink.** `@aws-sdk/lib-storage` `Upload` accepts a stream directly, so this is hours, not days — it was previously unowned by any ticket | 0.5d |
| 1.3.6 | **[DONE]** In-stream content hashing via `HashingPassThrough` | — |
| 1.3.7 | **[HARDEN]** `npm run memcheck` exists and passes (~7MB for 1.5GB). Outstanding: wire it into CI | 0.25d |
| 1.3.8 | **[DONE]** 32MP downscale detection with max safe scale per artboard | — |

### Epic 1.4 — Orchestration
| # | Ticket | Est. |
| --- | --- | --- |
| 1.4.1 | Inngest setup; `generation.requested` event. Use per-key `throttle`/`concurrency` for Figma rate budget rather than a separate Redis limiter (see cut 1.1.4) | 1d |
| 1.4.2 | Generation step function: fetch → parse → render → stream-package → deliver, with per-step retry. **Step return values carry keys and manifests only — never file contents.** Inngest persists step output and size-limits it | 2d |
| 1.4.3 | Progress persistence to `generations` + `generated_files`; failure states carry a usable error message | 1d |

**Phase 1 exit:** the existing engine runs as a durable background job against
both sources, writing to object storage, with the memory benchmark green in CI.

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
| 2.2.5 | Figma Community listing: description, cover art, submission. Depends on 2.2.1–2.2.4, so it cannot literally start early. **What can be front-loaded, in Phase 0/1:** read the Community review guidelines, confirm current review turnaround, and prepare cover art and copy. Do that, then submit the day the plugin works | 1d |

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

**Front-load the Figma Community *research*, not the submission.** The listing
itself depends on a working plugin (2.2.1–2.2.4), so it cannot start early. What
you can do now is confirm the review turnaround and prepare the assets, so
submission is same-day once the plugin lands. Review time is outside your
control and this is the distribution channel, not a nice-to-have.

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
