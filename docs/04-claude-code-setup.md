# Building this out with Claude Code in VS Code

A practical guide to taking the prototype to a shipped product. The single most
important idea: **do not ask for the whole thing in one prompt.** Ship one epic
per session, verify, commit, move on.

---

## 1. Setup (15 minutes)

```bash
# Install Claude Code
npm install -g @anthropic-ai/claude-code

# Set up the repo
mkdir handoff && cd handoff
cp -r /path/to/prototype/* .
cp /path/to/0*.md ./docs/     # PRD, build plan, market scan

git init && git add -A && git commit -m "Core engine prototype"
npm install && npm test       # confirm 28 passing before you start
```

In VS Code: install the **Claude Code** extension from the marketplace, then
`Cmd+Esc` (Mac) / `Ctrl+Esc` (Windows) to open it. It picks up your open file
and selection as context automatically.

`CLAUDE.md` is already in the prototype folder. Claude Code reads it at the
start of every session — it is what stops the model re-simplifying the batching
and streaming logic in three weeks when nobody remembers why they exist.

---

## 2. The rule that matters most

**One epic per session.** Long sessions drift: context fills, early decisions get
forgotten, and you end up reviewing 2,000 lines you don't understand.

A good session is:

1. `/clear` to start fresh
2. Point at one epic from the build plan
3. Let it plan before it writes
4. Review the diff
5. Run tests
6. Commit
7. `/clear`

If a session runs past ~90 minutes without a commit, stop and split the work.

---

## 3. Session prompts, in order

Paste these more or less verbatim. Each assumes a fresh `/clear`.

### Session 0 — orient

```
Read CLAUDE.md and docs/03-build-plan.md.

Don't write any code. Tell me:
1. What's already built and tested
2. What Epic 1.1 requires that doesn't exist yet
3. Anything in the build plan you think is wrong or out of order

Be direct about disagreements.
```

Worth doing. It surfaces misunderstandings before they cost you a day.

### Session 1 — foundations (Epic 1.1)

```
Implement Epic 1.1 from docs/03-build-plan.md: Next.js + TypeScript + Tailwind
scaffold, Supabase schema from PRD §7, token encryption, Upstash rate limiter.

Constraints:
- RLS policies on every table from the start, not added later
- Tokens encrypted at rest, never plaintext, with a unit test proving it
- Don't touch src/matrix.ts, src/packager.ts or src/stream.ts

Plan first, show me the plan, wait for approval.
```

### Session 2 — wire the engine to jobs (Epic 1.4)

```
Wire the existing engine into an Inngest step function per Epic 1.4.

Critical: step return values are size-limited and persisted. Pass object keys
and manifests between steps — never file contents. The streaming guarantee in
CLAUDE.md invariant 2 must survive; `npm run memcheck` must still pass.
```

### Session 3 — auth (Epic 2.1)

```
Implement Epic 2.1: Figma and Google OAuth.

Scopes are specified exactly in CLAUDE.md — use those, they're verified against
live docs. In particular: not `file_read` (deprecated), not `file_variables:read`
(Enterprise-only), and Google gets `drive.file` and nothing broader.

Also implement 2.1.4: detect Figma seat type at onboarding and block View/Collab
seats with a clear explanation. They get 6 Tier 1 requests per month and the
product cannot work for them. Better to lose the signup than take their money.
```

### Session 4+ — continue by epic

Same shape. Reference the epic number, restate the relevant invariant, ask for a
plan first.

---

## 4. Techniques that actually help

**Plan mode.** `Shift+Tab` twice, or just say "plan first, don't write code yet."
For anything touching the engine, always. Reviewing a plan takes two minutes;
reviewing a wrong implementation takes an hour.

**Point at files explicitly.** `@src/matrix.ts` beats "the matrix file". Claude
Code reads what you reference and guesses at what you don't.

**Ask for the reasoning on risky changes.** "Before you change planBatches,
explain what the rate limit consequence is." If the answer is wrong, you've
caught it for free.

**Use `/clear` aggressively.** Between epics, always. Stale context causes more
bad output than short context does.

**Let it run the tests.** "Run npm test and npm run memcheck, fix anything that
fails" is a complete instruction. Don't hand-verify what the suite covers.

**Subagents for review.** After a big epic: "Use a subagent to review this diff
against the invariants in CLAUDE.md." Fresh context catches things the
implementing session is blind to.

**Screenshots for UI.** Paste a screenshot of a broken layout directly into the
chat. Far faster than describing it.

---

## 5. Guard the invariants

The realistic failure mode is not bad code — it's a future session "cleaning up"
`planBatches` into a readable per-file loop, or replacing the streaming packager
with something simpler that buffers. Both changes look like improvements and
both destroy the product.

Three defences, all already in place:

1. **CLAUDE.md** states each invariant and why it exists
2. **Tests named in caps** (`BATCHING:`, `STREAMING:`) signal load-bearing
3. **`npm run memcheck`** fails the build if buffering returns

Put both in CI on day one:

```yaml
- run: npm test
- run: npm run memcheck
```

If Claude proposes changing either, ask it to explain the constraint first. If
it can't, it shouldn't be touching that code.

---

## 6. Where to actually start

**Not with Epic 1.1.** Start with Phase 0.

The engine already generates real packages from vector masters with no auth, no
plugin and no Figma seat. That means you can run validation this week:

```bash
npm run start -- generate --client "Their Client" --vectors ./their-svgs \
  --preset full-brand-package
```

Ask eight designers for a folder of logo SVGs. Hand back a finished package.
Watch what they change before they'd send it. Every change is a requirement you
don't have yet, and the rework rate is the metric that decides whether this is a
product.

Building Epics 1.1 through 3.6 is roughly ten weeks. Finding out you automated
the wrong 25% is a phone call. Do the phone call first.
