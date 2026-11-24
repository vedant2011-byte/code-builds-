/**
 * CODE BUILTS ARCADE — rules shared by the browser game and the Worker.
 *
 * The browser renders the game; the Worker owns the score. A bounce is only
 * worth points once the server has accepted the event.
 */

export const POINTS_PER_BOUNCE = 10;

/** Fastest a human paddle return can physically happen, in ms. */
export const MIN_BOUNCE_GAP_MS = 120;

/** A session cannot be finished later than this after it started. */
export const SESSION_TTL_MS = 5 * 60 * 1000;

/** Anything longer than this is not a credible attempt. */
export const MAX_PLAY_MS = 4 * 60 * 1000;

/** How far ahead of the server clock a client event may claim to be. */
export const CLOCK_TOLERANCE_MS = 2000;

/** Claims one IP may create per hour. */
export const CLAIMS_PER_IP_PER_HOUR = 6;

export interface Tier {
  min: number;
  max: number | null;
  discount: number;
}

export const DEFAULT_TIERS: Tier[] = [
  { min: 400, max: null, discount: 10 },
  { min: 300, max: 399, discount: 7 },
  { min: 200, max: 299, discount: 5 },
  { min: 100, max: 199, discount: 2 },
  { min: 0, max: 99, discount: 0 },
];

export const SERVICE_CATALOGUE = [
  'Website development',
  'Landing page development',
  'Web applications',
  'Automation services',
  'API integrations',
  'Digital solutions',
] as const;

export const DEFAULT_ELIGIBLE_SERVICES: string[] = [
  'Website development',
  'Landing page development',
  'Web applications',
  'Automation services',
];

export type Difficulty = 'relaxed' | 'standard' | 'challenging';

export interface ArcadeSettings {
  arcadeEnabled: boolean;
  claimsEnabled: boolean;
  difficulty: Difficulty;
  couponValidDays: number;
  minProjectValue: number;
  maxCouponUses: number;
  tiers: Tier[];
  eligibleServices: string[];
}

export const DEFAULT_SETTINGS: ArcadeSettings = {
  arcadeEnabled: true,
  claimsEnabled: true,
  difficulty: 'standard',
  couponValidDays: 7,
  minProjectValue: 0,
  maxCouponUses: 1,
  tiers: DEFAULT_TIERS,
  eligibleServices: DEFAULT_ELIGIBLE_SERVICES,
};

/** What the browser is allowed to know. */
export interface PublicArcadeConfig {
  arcadeEnabled: boolean;
  claimsEnabled: boolean;
  difficulty: Difficulty;
  tiers: Tier[];
  couponValidDays: number;
  minProjectValue: number;
  eligibleServices: string[];
  pointsPerBounce: number;
}

export function discountForScore(score: number, tiers: Tier[] = DEFAULT_TIERS): number {
  const sorted = [...tiers].sort((a, b) => b.min - a.min);
  for (const tier of sorted) {
    if (score >= tier.min) return tier.discount;
  }
  return 0;
}

export function tierRangeLabel(tier: Tier): string {
  if (tier.max === null) return `${tier.min}+`;
  if (tier.min === 0) return `0–${tier.max}`;
  return `${tier.min}–${tier.max}`;
}

/**
 * Strict validation of a tier table. Returns an error string, or null when the
 * table is usable: contiguous, ordered, non-negative, max <= 100%.
 */
export function validateTiers(tiers: unknown): string | null {
  if (!Array.isArray(tiers) || tiers.length === 0) return 'At least one reward tier is required.';
  if (tiers.length > 8) return 'No more than 8 reward tiers are allowed.';

  let previousMin = Number.POSITIVE_INFINITY;
  for (const raw of tiers) {
    if (typeof raw !== 'object' || raw === null) return 'Each tier must be an object.';
    const tier = raw as Partial<Tier>;
    if (typeof tier.min !== 'number' || !Number.isInteger(tier.min) || tier.min < 0) {
      return 'Tier minimums must be whole, non-negative numbers.';
    }
    if (tier.max !== null && (typeof tier.max !== 'number' || !Number.isInteger(tier.max) || tier.max < tier.min)) {
      return 'Tier maximums must be null or a whole number at least as large as the minimum.';
    }
    if (typeof tier.discount !== 'number' || !Number.isInteger(tier.discount) || tier.discount < 0 || tier.discount > 100) {
      return 'Discounts must be whole percentages between 0 and 100.';
    }
    if (tier.min >= previousMin) return 'Tiers must not overlap when sorted from highest to lowest.';
    previousMin = tier.min;
  }

  const lowest = [...tiers].sort((a, b) => (a as Tier).min - (b as Tier).min)[0] as Tier;
  if (lowest.min !== 0) return 'The lowest tier must start at score 0.';
  return null;
}
