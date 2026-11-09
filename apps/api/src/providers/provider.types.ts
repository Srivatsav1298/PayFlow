import { TransactionStatus } from '@prisma/client';

/** Provider-agnostic payment, as PayFlow stores it. `amount` is a decimal string. */
export interface NormalizedPayment {
  providerRef: string;
  reference: string | null;
  customerId: string | null;
  amount: string;
  currency: string;
  status: TransactionStatus;
  occurredAt: Date;
  metadata: Record<string, unknown>;
}

/** A state change for one payment. `sequence` orders events per payment (higher = newer). */
export interface NormalizedEvent {
  providerEventId: string;
  type: string;
  sequence: bigint;
  occurredAt: Date;
  payment: NormalizedPayment;
}

export interface ProviderCredentials {
  [key: string]: unknown;
}

export interface ListPaymentsResult {
  payments: Array<{ sequence: bigint; payment: NormalizedPayment }>;
  /** Position to resume from on the next call/sync — valid even when hasMore is false (incremental sync). */
  nextCursor: string;
  hasMore: boolean;
}

export class ProviderUnavailableError extends Error {
  constructor(message: string, readonly retryable = true) {
    super(message);
  }
}

export class InvalidWebhookPayloadError extends Error {}

/**
 * Every payment provider adapter implements this. The rest of PayFlow only ever sees
 * NormalizedPayment / NormalizedEvent, so adding a provider never touches core logic.
 */
export interface PaymentProviderInterface {
  readonly key: string;
  readonly name: string;
  readonly isSandbox: boolean;

  /** Pull payments newer than `cursor` (incremental sync). Must be safe to call repeatedly. */
  listPayments(creds: ProviderCredentials, cursor: string | null, limit: number): Promise<ListPaymentsResult>;

  /** Verify authenticity using the provider's documented mechanism. NEVER trust a payload before this passes. */
  verifyWebhook(rawBody: string, headers: Record<string, string | string[] | undefined>, secret: string): boolean;

  /** Validate and normalise a (verified) webhook body. Throws InvalidWebhookPayloadError. */
  parseWebhook(rawBody: string): NormalizedEvent;
}

export const SUPPORTED_EVENT_TYPES = [
  'payment.created',
  'payment.pending',
  'payment.succeeded',
  'payment.failed',
  'payment.refunded',
] as const;

export const EVENT_TO_STATUS: Record<string, TransactionStatus> = {
  'payment.created': 'CREATED',
  'payment.pending': 'PENDING',
  'payment.succeeded': 'SUCCEEDED',
  'payment.failed': 'FAILED',
  'payment.refunded': 'REFUNDED',
};
