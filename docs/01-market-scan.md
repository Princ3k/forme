# Market & Competitor Scan
**Date:** 26 July 2026

---

## Headline finding

The designer told you "there's nothing out there that actually solves it for freelancers." That is not accurate — **there is a real, funded, growing category** serving exactly this persona. Bravemark has 2,000+ brand designers on it at $8–40/month. Brandpad charges $42/month and counts IKEA, MoMA and IDEO as users. There are at least half a dozen Figma→Google Drive export plugins in the Figma Community.

**This is not a reason to stop.** It is a reason to change what you build.

Two things follow from it:

1. **A working designer with this exact pain did not know these tools existed.** That is a distribution signal, not a product-gap signal. It tells you the category has weak discovery among freelancers — reachable, but you'd be fighting for attention, not filling a vacuum.
2. **Every incumbent solves the *downstream* half only.** They are all beautiful destinations that you must *manually upload assets into*. None of them ingest from Figma. The 4–5 hours your designer described happens *before* she ever opens Bravemark. **That upstream half is genuinely unserved.**

---

## Competitive landscape

### Tier 1 — Brand guideline / delivery platforms (the closest competitors)

| Product | Price | Who it's for | What it does | The gap |
| --- | --- | --- | --- | --- |
| **Bravemark** | Free → $8 / $15 / $40 per month | Freelance brand designers, small studios | No-code builder for responsive online brand guidelines; hosts downloadable assets in "use-case modules"; global ZIP download; public/private URL; custom domain; password-protected pages | **Manual upload of every asset.** No Figma ingestion, no format generation, no auto-update from source |
| **Brandpad** | From $42/month for 2 guidelines | Premium studios and agencies | Template-forward guideline builder, very polished, strong brand credibility | Same — manual upload, no source-of-truth sync |
| **Frontify** | Custom quote; median negotiated contract ≈ $32k/year | Mid-market to enterprise | Full brand portal + DAM + collaboration | Priced entirely out of the freelancer market |
| **Brandfolder** | From ~$5k/year; median contract ≈ $24.7k/year; small teams $6k–18k | Enterprise marketing teams | DAM, internal asset governance | Enterprise-only. Correctly identified as not a freelancer tool |
| **Bynder** | $15k–50k/year; median ≈ $41k | Enterprise | DAM | Same |

**Read:** the $8–42/month freelancer tier is *occupied and competitive*. The $5k–40k/year enterprise tier is a different market. Your PRD's positioning ("cheap alternative to Frontify") targets the wrong competitor — you'd actually be competing with Bravemark, at Bravemark's price point.

### Tier 2 — Figma → Drive export plugins (the direct feature overlap)

Several already exist in the Figma Community: **ExportHub** (Figma→Drive in one click), **Google Drive Uploader**, **Export to Google Drive**, **Ultimate Exporter**, plus a **Figma Drive** MCP server that exports frames to a hierarchical Drive folder structure. Make and Tray both ship Figma↔Drive connectors.

**Read:** the literal feature described in your PRD's MVP — "export selected frames from Figma into a Google Drive folder" — is a free Figma plugin, several times over. Shipping that as a paid SaaS product is not viable.

**But:** these plugins all do a *dumb pipe*. Select frames → export at the settings you specify → dump to a folder. They do not multiply formats, do not enforce naming conventions, do not build a structured deliverable, do not remember what a "brand handoff package" looks like. They automate the *upload*, which was never the slow part.

### Tier 3 — Adjacent

Figma Dev Mode (free, covers dev handoff — not brand/client handoff), Dropbox (the default "just send a folder" behaviour), Notion/Google Drive (what most freelancers actually use today).

**The real incumbent is Dropbox + a manually assembled folder.** That is who you have to beat.

---

## Where the 4–5 hours actually goes

This is the most important thing to get right, and it needs validating with real designers rather than assumed. The plausible breakdown:

| Step | Est. share of time | Automatable from Figma? |
| --- | --- | --- |
| Producing every format/colour variant of each mark (primary, secondary, submark, wordmark × SVG/PNG/JPG/PDF × 1x/2x/3x × full-colour/mono-black/mono-white/reversed) | **~50–60%** | **Yes — this is the wedge** |
| Consistent file naming across the whole package | ~10% | Yes, trivially |
| Building and organising the folder tree | ~10% | Yes, trivially |
| Zipping, uploading, waiting on transfer | ~10% | Yes, trivially |
| Writing the handoff email / instructions | ~10% | Partly |
| Print formats (EPS, AI, CMYK/Pantone PDF) | Varies | **No — see limitations** |

**The combinatorial explosion of variants is the bottleneck.** One logo with 4 lockups × 4 colourways × 5 formats × 3 scales is 240 files. Doing that by hand, correctly named, is where the afternoon disappears. Nobody automates this today.

---

## Strategic conclusion

**Do not build "Figma syncs to Google Drive."** That's a free plugin and a solved problem.

**Build the export matrix.** Mark a node once in Figma, define the variant grid once per client, and have the system generate, name, folder, package and deliver the entire set on command. Then let the output land wherever the designer wants — Drive, a zip, a share link, or eventually pushed into Bravemark/Brandpad via their APIs if they have them.

Positioned this way you are **complementary to the incumbents rather than competing with them**, which is a much better place to start: you'd be the thing that fills Bravemark up, not a worse Bravemark.

**Before writing production code, validate two things with 8–10 freelance brand designers:**

1. Confirm the time actually goes where the table above assumes. If it turns out most of it is print-format work in Illustrator, the Figma-first thesis is wrong and the product should start somewhere else.
2. Ask what they currently use. If most of them already use Bravemark or Brandpad, your product is a plugin/integration. If most of them use Dropbox and a hand-built folder, it's a standalone product. That answer changes the entire business.

---

## Sources

- [Bravemark — online brand guidelines platform and pricing](https://www.bravemark.co/)
- [Brandpad plans and pricing](https://brandpad.io/pricing)
- [Best Brand Guidelines Software 2026 — Overmatter](https://www.overmatter.design/blog/best-brand-guidelines-software-compare-10-platforms-for-designers-agencies)
- [Best Brand Guidelines Software in 2026 — BrandyHQ](https://brandyhq.com/blog/best-brand-guidelines-software/)
- [Brandfolder pricing 2026 — Vendr](https://www.vendr.com/marketplace/brandfolder)
- [Frontify vs Brandfolder cost 2026 — ITQlick](https://www.itqlick.com/compare/frontify/brandfolder)
- [Digital Asset Management pricing: real 2026 numbers — Masset](https://www.getmasset.com/resources/blog/dam-pricing-2026)
- [ExportHub — Figma to Google Drive in 1 click](https://www.figma.com/community/plugin/1632760206607254511/figma-to-google-drive-in-1-click-exporthub)
- [Google Drive Uploader — Figma Community](https://www.figma.com/community/plugin/1621192171405523626/google-drive-uploader)
- [Ultimate Exporter — Figma Community](https://www.figma.com/community/plugin/928903217538015942/ultimate-exporter)
- [Figma Drive MCP server](https://mcpmarket.com/server/figma-drive)
- [What every brand guide should include when you hand off to a client](https://jadeagarddesign.com/what-every-brand-guide-should-include-when-you-hand-off-to-a-client/)
