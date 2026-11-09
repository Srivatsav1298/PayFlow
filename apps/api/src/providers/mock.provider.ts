import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { signWebhook, verifyWebhookSignature } from '../common/crypto.util';
import { MONEY_REGEX, CURRENCY_REGEX } from '../common/money';
import {
  EVENT_TO_STATUS, InvalidWebhookPayloadError, ListPaymentsResult, NormalizedEvent, NormalizedPayment,
  PaymentProviderInterface, ProviderCredentials, ProviderUnavailableError,
} from './provider.types';

/** Small deterministic PRNG so a given seed always yields the same "provider" data. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const seedNum = (s: string) => parseInt(createHash('sha256').update(s).digest('hex').slice(0, 8), 16);

export interface MockCredentials extends ProviderCredentials {
  seed?: string;
  /** How many payments the simulated provider holds. */
  count?: number;
  /** Fail the next N list calls — used to exercise API-failure handling. */
  simulateOutage?: boolean;
  /** ISO date of the first simulated payment. Fixed per connection at creation so data is deterministic. */
  startDate?: string;
}

/**
 * MockPaymentProvider — a SANDBOX simulation. No network calls, no real money, no real credentials.
 *
 * Its data deliberately includes realistic problems so reconciliation has something to find:
 *   every 8th payment failed · 9th has an unknown reference · 11th is overpaid by 5.00
 *   13th is in USD · 17th duplicates the previous payment · every 5th is still pending.
 */
@Injectable()
export class MockPaymentProvider implements PaymentProviderInterface {
  readonly key = 'mock';
  readonly name = 'Mock Payments (sandbox)';
  readonly isSandbox = true;

  private paymentAt(seed: string, i: number, base: number): { sequence: bigint; payment: NormalizedPayment } {
    const rnd = mulberry32(seedNum(`${seed}:${i}`));
    const baseAmounts = [49, 99, 120, 250, 399, 750, 1200, 85.5, 310.25, 640];
    const dup = i > 0 && i % 17 === 0;
    const src = dup ? i - 1 : i; // duplicates reuse the previous payment's details
    const r = mulberry32(seedNum(`${seed}:${src}`));
    let amount = baseAmounts[Math.floor(r() * baseAmounts.length)];
    let currency = 'EUR';
    let reference: string | null = `INV-${1000 + src}`;
    if (src % 9 === 0 && src > 0) reference = `UNKNOWN-${src}`;
    if (src % 11 === 0 && src > 0) amount += 5;
    if (src % 13 === 0 && src > 0) currency = 'USD';

    let status: NormalizedPayment['status'] = 'SUCCEEDED';
    if (i % 8 === 0 && i > 0) status = 'FAILED';
    else if (i % 5 === 0 && i > 0) status = 'PENDING';
    void rnd;

    const occurredAt = new Date(base + i * 6 * 3_600_000);
    return {
      sequence: BigInt(status === 'PENDING' ? 2 : 3),
      payment: {
        providerRef: `mock_pay_${seed}_${i}`,
        reference,
        customerId: `cust_${src % 7}`,
        amount: amount.toFixed(2),
        currency,
        status,
        occurredAt,
        metadata: { simulated: true, index: i },
      },
    };
  }

  async listPayments(creds: MockCredentials, cursor: string | null, limit: number): Promise<ListPaymentsResult> {
    if (creds.simulateOutage) throw new ProviderUnavailableError('Mock provider simulated outage (503)');
    const seed = creds.seed ?? 'default';
    const total = Math.min(Number(creds.count ?? 60), 5000);
    const parsed = Date.parse(creds.startDate ?? '');
    const base = Number.isNaN(parsed) ? Date.UTC(2025, 0, 1) : parsed;
    const start = cursor ? Number(cursor) : 0;
    if (!Number.isInteger(start) || start < 0) throw new ProviderUnavailableError('Invalid cursor', false);
    const end = Math.min(start + limit, total);
    const payments = Array.from({ length: Math.max(end - start, 0) }, (_, k) => this.paymentAt(seed, start + k, base));
    return { payments, nextCursor: String(end), hasMore: end < total };
  }

  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>, secret: string): boolean {
    const h = headers['x-payflow-signature'];
    return verifyWebhookSignature(rawBody, Array.isArray(h) ? h[0] : h, secret);
  }

  parseWebhook(rawBody: string): NormalizedEvent {
    let body: any;
    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new InvalidWebhookPayloadError('Body is not valid JSON');
    }
    const fail = (m: string): never => { throw new InvalidWebhookPayloadError(m); };
    if (!body || typeof body !== 'object') fail('Body must be an object');
    const { id, type, sequence, created, data } = body;
    if (typeof id !== 'string' || !id || id.length > 128) fail('id is required');
    if (!(type in EVENT_TO_STATUS)) fail(`Unsupported event type: ${String(type).slice(0, 50)}`);
    if (!Number.isInteger(sequence) || sequence < 0) fail('sequence must be a non-negative integer');
    const when = new Date(created);
    if (Number.isNaN(when.getTime())) fail('created must be an ISO date');
    const p = data?.payment;
    if (!p || typeof p.id !== 'string' || !p.id) fail('data.payment.id is required');
    if (typeof p.amount !== 'string' || !MONEY_REGEX.test(p.amount)) fail('data.payment.amount must be a decimal string');
    if (typeof p.currency !== 'string' || !CURRENCY_REGEX.test(p.currency)) fail('data.payment.currency must be ISO 4217');
    const occurredAt = new Date(p.created ?? created);
    if (Number.isNaN(occurredAt.getTime())) fail('data.payment.created must be an ISO date');

    return {
      providerEventId: id,
      type,
      sequence: BigInt(sequence),
      occurredAt: when,
      payment: {
        providerRef: p.id,
        reference: typeof p.reference === 'string' ? p.reference.slice(0, 200) : null,
        customerId: typeof p.customer_id === 'string' ? p.customer_id.slice(0, 100) : null,
        amount: p.amount,
        currency: p.currency,
        status: EVENT_TO_STATUS[type],
        occurredAt,
        metadata: typeof p.metadata === 'object' && p.metadata ? p.metadata : {},
      },
    };
  }

  // ── Simulation helpers (sandbox only) ──────────────────────────────────────

  /** Build a signed webhook exactly as a real provider would deliver it. */
  buildSignedEvent(
    secret: string,
    e: { id: string; type: string; sequence: number; payment: Record<string, unknown>; created?: Date },
    timestamp = Math.floor(Date.now() / 1000),
  ) {
    const created = (e.created ?? new Date()).toISOString();
    const rawBody = JSON.stringify({
      id: e.id, type: e.type, sequence: e.sequence, created,
      data: { payment: { created, ...e.payment } },
    });
    return { rawBody, signature: signWebhook(rawBody, secret, timestamp) };
  }
}
