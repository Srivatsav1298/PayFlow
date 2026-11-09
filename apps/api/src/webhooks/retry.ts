import { backoffDelay } from '../providers/payment-provider.service';

export interface RetryDecision {
  /** True when the event has exhausted its attempts and must stop retrying. */
  deadLetter: boolean;
  /** Delay before the next attempt (ms); 0 when dead-lettering. */
  delayMs: number;
}

/**
 * Decide what happens after attempt number `attempts` (1-based) failed.
 * Delay doubles each time: base, 2·base, 4·base… Capped, so a long outage cannot push retries out forever.
 */
export function decideRetry(attempts: number, maxAttempts: number, baseMs: number): RetryDecision {
  if (attempts >= maxAttempts) return { deadLetter: true, delayMs: 0 };
  return { deadLetter: false, delayMs: backoffDelay(attempts, baseMs) };
}
