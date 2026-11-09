import { Injectable, NotFoundException } from '@nestjs/common';
import { MockPaymentProvider } from './mock.provider';
import { PaymentProviderInterface, ProviderUnavailableError } from './provider.types';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Exponential backoff: base · 2^(attempt-1), capped. Pure so it can be unit-tested. */
export function backoffDelay(attempt: number, baseMs: number, capMs = 60_000): number {
  return Math.min(baseMs * 2 ** Math.max(attempt - 1, 0), capMs);
}

/** Registry of provider adapters. Register new adapters here; nothing else changes. */
@Injectable()
export class PaymentProviderService {
  private readonly adapters = new Map<string, PaymentProviderInterface>();

  constructor(mock: MockPaymentProvider) {
    this.register(mock);
  }

  register(p: PaymentProviderInterface) {
    this.adapters.set(p.key, p);
  }

  get(key: string): PaymentProviderInterface {
    const a = this.adapters.get(key);
    if (!a) throw new NotFoundException(`Unknown payment provider: ${key}`);
    return a;
  }

  list() {
    return [...this.adapters.values()].map((a) => ({ key: a.key, name: a.name, isSandbox: a.isSandbox }));
  }

  /** Retry transient provider failures (timeouts/5xx) with exponential backoff; fail fast on permanent ones. */
  async withRetry<T>(fn: () => Promise<T>, opts: { attempts?: number; baseMs?: number } = {}): Promise<T> {
    const attempts = opts.attempts ?? 3;
    let last: unknown;
    for (let i = 1; i <= attempts; i++) {
      try {
        return await fn();
      } catch (e) {
        last = e;
        const retryable = e instanceof ProviderUnavailableError ? e.retryable : false;
        if (!retryable || i === attempts) break;
        await sleep(backoffDelay(i, opts.baseMs ?? 200));
      }
    }
    throw last;
  }
}
