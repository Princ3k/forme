/**
 * Token-bucket rate limiter for Figma REST API calls.
 *
 * This exists because Figma's Tier 1 endpoints — GET file, GET file nodes and
 * GET image — are capped at 10 requests/minute on the Professional plan for
 * Full/Dev seats. GET image being Tier 1 is the constraint that shapes this
 * entire product: a naive one-request-per-asset implementation would exhaust
 * the budget after ten files.
 *
 * View and Collab seats are capped at 6 Tier 1 requests per MONTH, which makes
 * the product unusable for them. Detect seat type at onboarding.
 *
 * Verified against https://developers.figma.com/docs/rest-api/rate-limits/
 * (limits updated 17 November 2025; Figma reserves the right to change them,
 * so these are configuration, not constants).
 */

export type Tier = 1 | 2 | 3;

export interface TierBudget {
  /** Requests permitted per minute. */
  perMinute: number;
}

/** Professional plan, Full or Dev seat. */
export const PROFESSIONAL_FULL_SEAT: Record<Tier, TierBudget> = {
  1: { perMinute: 10 },
  2: { perMinute: 25 },
  3: { perMinute: 50 },
};

/** Organization plan, Full or Dev seat. */
export const ORGANIZATION_FULL_SEAT: Record<Tier, TierBudget> = {
  1: { perMinute: 15 },
  2: { perMinute: 50 },
  3: { perMinute: 100 },
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class RateLimiter {
  private tokens: Record<Tier, number>;
  private lastRefill: Record<Tier, number>;

  constructor(private readonly budget: Record<Tier, TierBudget> = PROFESSIONAL_FULL_SEAT) {
    this.tokens = { 1: budget[1].perMinute, 2: budget[2].perMinute, 3: budget[3].perMinute };
    const now = Date.now();
    this.lastRefill = { 1: now, 2: now, 3: now };
  }

  private refill(tier: Tier): void {
    const now = Date.now();
    const last = this.lastRefill[tier];
    const elapsedMs = now - last;
    const ratePerMs = this.budget[tier].perMinute / 60_000;
    const gained = elapsedMs * ratePerMs;
    if (gained > 0) {
      this.tokens[tier] = Math.min(this.budget[tier].perMinute, this.tokens[tier] + gained);
      this.lastRefill[tier] = now;
    }
  }

  /** Blocks until a token is available for the given tier. */
  async acquire(tier: Tier): Promise<void> {
    for (;;) {
      this.refill(tier);
      if (this.tokens[tier] >= 1) {
        this.tokens[tier] -= 1;
        return;
      }
      const ratePerMs = this.budget[tier].perMinute / 60_000;
      const deficit = 1 - this.tokens[tier];
      await sleep(Math.ceil(deficit / ratePerMs) + 50);
    }
  }

  /**
   * Called after a 429. Figma returns an exact Retry-After in seconds — honour
   * it precisely rather than applying a generic exponential backoff, and drain
   * the bucket so concurrent callers also wait.
   */
  async penalise(tier: Tier, retryAfterSeconds: number): Promise<void> {
    this.tokens[tier] = 0;
    this.lastRefill[tier] = Date.now() + retryAfterSeconds * 1000;
    await sleep(retryAfterSeconds * 1000);
  }
}
