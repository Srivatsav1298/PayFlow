import { BadRequestException } from '@nestjs/common';

export interface MatchingConfig {
  /** Absolute amount tolerance (in currency units) still treated as an exact amount match. */
  amountTolerance: number;
  /** A payment counts as "on time" if within this many days of the invoice due date. */
  dateWindowDays: number;
  /** Criterion weights; they are normalised, so only ratios matter. Set to 0 to disable a criterion. */
  weights: { reference: number; amount: number; currency: number; date: number; customer: number };
  /** Minimum score for a non-exact candidate to be shown to reviewers as a suggestion. */
  suggestMinScore: number;
  /** Confirm exact matches automatically. Uncertain matches are NEVER auto-confirmed. */
  autoConfirmExact: boolean;
  /** Days after due date before an unpaid invoice raises a MISSING_PAYMENT exception. */
  missingPaymentGraceDays: number;
  /** Hours a PENDING transaction may stay pending before a DELAYED_EVENT exception is raised. */
  delayedEventHours: number;
}

export const DEFAULT_CONFIG: MatchingConfig = {
  amountTolerance: 0,
  dateWindowDays: 30,
  weights: { reference: 40, amount: 30, currency: 10, date: 10, customer: 10 },
  suggestMinScore: 50,
  autoConfirmExact: true,
  missingPaymentGraceDays: 3,
  delayedEventHours: 24,
};

const NUMERIC_RANGES: Record<string, [number, number]> = {
  amountTolerance: [0, 1_000_000],
  dateWindowDays: [0, 3650],
  suggestMinScore: [1, 100],
  missingPaymentGraceDays: [0, 365],
  delayedEventHours: [1, 24 * 365],
};

/** Merge user config over defaults and validate. Throws 400 on out-of-range values. */
export function resolveConfig(input: unknown): MatchingConfig {
  const raw = (input && typeof input === 'object' ? input : {}) as Partial<MatchingConfig>;
  const cfg: MatchingConfig = {
    ...DEFAULT_CONFIG,
    ...raw,
    weights: { ...DEFAULT_CONFIG.weights, ...(raw.weights ?? {}) },
  };
  for (const [key, [min, max]] of Object.entries(NUMERIC_RANGES)) {
    const v = (cfg as unknown as Record<string, unknown>)[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
      throw new BadRequestException(`reconciliationConfig.${key} must be a number between ${min} and ${max}`);
    }
  }
  if (typeof cfg.autoConfirmExact !== 'boolean') {
    throw new BadRequestException('reconciliationConfig.autoConfirmExact must be a boolean');
  }
  for (const [k, w] of Object.entries(cfg.weights)) {
    if (typeof w !== 'number' || !Number.isFinite(w) || w < 0 || w > 1000) {
      throw new BadRequestException(`reconciliationConfig.weights.${k} must be a number between 0 and 1000`);
    }
  }
  if (Object.values(cfg.weights).every((w) => w === 0)) {
    throw new BadRequestException('At least one matching weight must be greater than zero');
  }
  return cfg;
}
