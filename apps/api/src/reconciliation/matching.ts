import { Prisma } from '@prisma/client';
import { MatchingConfig } from './matching.config';

type D = Prisma.Decimal;
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

export interface TxnLike {
  id: string;
  providerRef: string;
  reference: string | null;
  customerId: string | null;
  amount: D;
  currency: string;
  occurredAt: Date;
}

export interface InvoiceLike {
  id: string;
  reference: string;
  customerId: string | null;
  amount: D;
  amountPaid: D;
  currency: string;
  dueAt: Date;
}

export interface Reason {
  criterion: 'reference' | 'amount' | 'currency' | 'date' | 'customer';
  matched: boolean;
  detail: string;
}

export interface Candidate {
  transactionId: string;
  invoiceId: string;
  score: number; // 0..100
  exact: boolean;
  partial: boolean; // payment is smaller than the outstanding balance
  overpayment: boolean;
  currencyMismatch: boolean;
  amountDiff: D; // transaction - outstanding (signed)
  reasons: Reason[];
}

/** Case-/punctuation-insensitive reference normalisation: "INV-2024/001" ≡ "inv 2024 001". */
export const normaliseRef = (s: string | null | undefined) =>
  (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

export const outstanding = (inv: Pick<InvoiceLike, 'amount' | 'amountPaid'>): D => inv.amount.minus(inv.amountPaid);

export function referenceMatch(txn: TxnLike, inv: InvoiceLike): 'exact' | 'contains' | 'none' {
  const invRef = normaliseRef(inv.reference);
  if (!invRef) return 'none';
  const candidates = [normaliseRef(txn.reference), normaliseRef(txn.providerRef)].filter(Boolean);
  if (candidates.some((c) => c === invRef)) return 'exact';
  // Payers often append text ("Payment for INV-001"); only accept when the invoice ref is long enough to be unambiguous.
  if (invRef.length >= 5 && candidates.some((c) => c.includes(invRef))) return 'contains';
  return 'none';
}

export function amountsEqual(a: D, b: D, tolerance: number): boolean {
  return a.minus(b).abs().lte(D(tolerance));
}

const daysBetween = (a: Date, b: Date) => Math.abs(a.getTime() - b.getTime()) / 86_400_000;

/**
 * Score one transaction against one invoice.
 *
 * Exact  = reference matches exactly AND currency equal AND amount equals the outstanding
 *          balance (within tolerance) AND customers do not conflict.
 * Anything else is at best a suggestion that a finance user must confirm.
 * Amounts are compared with decimal arithmetic — never floating point.
 */
export function scoreCandidate(txn: TxnLike, inv: InvoiceLike, cfg: MatchingConfig): Candidate {
  const due = outstanding(inv);
  const reasons: Reason[] = [];
  const ref = referenceMatch(txn, inv);
  const currencyOk = txn.currency === inv.currency;
  const diff = txn.amount.minus(due);
  const amountOk = currencyOk && amountsEqual(txn.amount, due, cfg.amountTolerance);
  const dateOk = daysBetween(txn.occurredAt, inv.dueAt) <= cfg.dateWindowDays;
  const customerKnown = !!txn.customerId && !!inv.customerId;
  const customerOk = customerKnown && txn.customerId === inv.customerId;

  reasons.push({
    criterion: 'reference',
    matched: ref !== 'none',
    detail: ref === 'exact' ? 'Reference matches invoice' : ref === 'contains' ? 'Invoice reference found inside payment reference' : 'No reference match',
  });
  reasons.push({
    criterion: 'amount',
    matched: amountOk,
    detail: !currencyOk ? 'Amount not comparable (different currency)' : amountOk ? 'Amount equals outstanding balance' : `Amount differs from outstanding by ${diff.toFixed(2)}`,
  });
  reasons.push({ criterion: 'currency', matched: currencyOk, detail: currencyOk ? `Both ${txn.currency}` : `${txn.currency} vs ${inv.currency}` });
  reasons.push({ criterion: 'date', matched: dateOk, detail: dateOk ? 'Within date window of due date' : 'Outside date window' });
  reasons.push({
    criterion: 'customer',
    matched: customerOk,
    detail: customerOk ? 'Customer matches' : customerKnown ? 'Customer differs' : 'Customer unknown on one side',
  });

  const w = cfg.weights;
  const total = w.reference + w.amount + w.currency + w.date + w.customer;
  const earned =
    (ref === 'exact' ? w.reference : ref === 'contains' ? w.reference * 0.7 : 0) +
    (amountOk ? w.amount : 0) +
    (currencyOk ? w.currency : 0) +
    (dateOk ? w.date : 0) +
    (customerOk ? w.customer : 0);
  const score = Math.round((earned / total) * 100);

  const customerConflict = customerKnown && !customerOk;
  const exact = ref === 'exact' && currencyOk && amountOk && !customerConflict;

  return {
    transactionId: txn.id,
    invoiceId: inv.id,
    score,
    exact,
    partial: currencyOk && ref !== 'none' && diff.isNegative() && !amountOk,
    overpayment: currencyOk && ref !== 'none' && diff.isPositive() && !amountOk,
    currencyMismatch: !currencyOk && ref !== 'none',
    amountDiff: diff,
    reasons,
  };
}

/**
 * Pick the best candidate per transaction. Ties between two *exact* matches are ambiguous
 * and therefore downgraded to suggestions (a human must choose), never auto-confirmed.
 */
export function rankCandidates(txn: TxnLike, invoices: InvoiceLike[], cfg: MatchingConfig): Candidate[] {
  const scored = invoices.map((i) => scoreCandidate(txn, i, cfg)).filter((c) => c.score >= cfg.suggestMinScore || c.exact);
  scored.sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score);
  const exacts = scored.filter((c) => c.exact);
  if (exacts.length > 1) exacts.forEach((c) => (c.exact = false));
  return scored;
}

/** Same customer + same amount + same currency + same reference within the window ⇒ likely duplicate payment. */
export function findDuplicateGroups<T extends TxnLike>(txns: T[], windowHours = 72): T[][] {
  const buckets = new Map<string, T[]>();
  for (const t of txns) {
    const key = [t.customerId ?? '', t.currency, t.amount.toFixed(4), normaliseRef(t.reference)].join('|');
    if (!t.reference && !t.customerId) continue; // too little signal to call anything a duplicate
    (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(t);
  }
  const groups: T[][] = [];
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    let current: T[] = [list[0]];
    for (const t of list.slice(1)) {
      const prev = current[current.length - 1];
      if ((t.occurredAt.getTime() - prev.occurredAt.getTime()) / 3_600_000 <= windowHours) current.push(t);
      else {
        if (current.length > 1) groups.push(current);
        current = [t];
      }
    }
    if (current.length > 1) groups.push(current);
  }
  return groups;
}
