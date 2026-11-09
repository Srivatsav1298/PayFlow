export type Role = 'ADMIN' | 'MANAGER' | 'ANALYST';
export type TxnStatus = 'CREATED' | 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'REFUNDED';
export interface Paginated<T> { data: T[]; meta: { page: number; pageSize: number; total: number; totalPages: number } }
export interface Money { currency: string; amount: string }

export interface Membership { organisationId: string; organisationName: string; role: Role }
export interface User { id: string; email: string; name: string; memberships: Membership[] }

export interface Transaction {
  id: string; providerRef: string; reference: string | null; customerId: string | null; amount: string; currency: string;
  status: TxnStatus; occurredAt: string; lastEventSequence: string;
  connection: { id: string; label: string; provider: { key: string; name: string } };
}
export interface HistoryEntry { id: string; fromStatus: TxnStatus | null; toStatus: TxnStatus; eventType: string; occurredAt: string; note: string | null }
export interface Invoice {
  id: string; reference: string; customerId: string | null; customerName: string | null; amount: string; amountPaid: string; outstanding: string;
  currency: string; status: 'OPEN' | 'PARTIALLY_PAID' | 'PAID' | 'VOID'; issuedAt: string; dueAt: string; isOverdue: boolean;
}
export interface Reason { criterion: string; matched: boolean; detail: string }
export interface Match {
  id: string; type: 'EXACT' | 'PARTIAL' | 'MANUAL'; status: 'SUGGESTED' | 'CONFIRMED' | 'REJECTED'; score: number; reasons: Reason[];
  matchedAmount: string; createdAt: string; reviewedAt: string | null; note: string | null;
  transaction: { id: string; providerRef: string; reference: string | null; amount: string; currency: string; customerId: string | null };
  invoice: { id: string; reference: string; amount: string; amountPaid: string; currency: string };
}
export interface Run {
  id: string; status: 'RUNNING' | 'COMPLETED' | 'FAILED'; startedAt: string; finishedAt: string | null; transactionsScanned: number;
  invoicesScanned: number; exactMatches: number; suggestedMatches: number; exceptionsRaised: number; error: string | null;
}
export type ExceptionType = 'DUPLICATE_TRANSACTION' | 'MISSING_PAYMENT' | 'AMOUNT_DISCREPANCY' | 'CURRENCY_MISMATCH' | 'UNMATCHED_INVOICE' | 'UNMATCHED_TRANSACTION' | 'FAILED_PAYMENT' | 'DELAYED_EVENT';
export type ExceptionStatus = 'OPEN' | 'INVESTIGATING' | 'RESOLVED' | 'DISMISSED';
export interface PayException {
  id: string; type: ExceptionType; status: ExceptionStatus; summary: string; details: Record<string, unknown>; resolution: string | null;
  notes: { at: string; by: string; text: string }[]; createdAt: string; resolvedAt: string | null;
  transaction: (Pick<Transaction, 'id' | 'providerRef' | 'reference' | 'amount' | 'currency' | 'status'>) | null;
  invoice: { id: string; reference: string; amount: string; currency: string } | null;
  assignee: { id: string; name: string; email: string } | null;
}
export interface Overview {
  totals: { transactions: number; volume: Money[]; succeeded: { count: number; amount: Money[] }; failed: { count: number; amount: Money[] }; pending: { count: number; amount: Money[] }; refunded: { count: number; amount: Money[] } };
  reconciliation: { succeededPayments: number; reconciledPayments: number; unmatchedPayments: number; successRate: number | null };
  invoices: { overdue: number; outstanding: Money[] };
  openExceptions: { total: number; byType: { type: ExceptionType; count: number }[] };
  trends: { daily: Trend[]; monthly: Trend[] };
}
export interface Trend { bucket: string; currency: string; total: number; succeeded: number; failed: number; pending: number; volume: string }
export interface Notification { id: string; kind: string; title: string; body: string; createdAt: string; readAt: string | null }
export interface Connection { id: string; label: string; isActive: boolean; lastSyncAt: string | null; lastSyncError: string | null; webhookPath: string; provider: { key: string; name: string; isSandbox: boolean } }
export interface Member { id: string; role: Role; user: { id: string; email: string; name: string; isActive: boolean } }
export interface WebhookEvent { id: string; providerEventId: string; type: string; sequence: string; status: string; attempts: number; lastError: string | null; receivedAt: string; duplicateCount: number }
export interface AuditEntry { id: string; action: string; entityType: string; entityId: string | null; actorId: string | null; createdAt: string; ip: string | null }
