import { Prisma } from '@prisma/client';
import { DEFAULT_CONFIG, resolveConfig } from './matching.config';
import {
  amountsEqual, findDuplicateGroups, InvoiceLike, normaliseRef, rankCandidates, scoreCandidate, TxnLike,
} from './matching';

const D = (v: string | number) => new Prisma.Decimal(v);
const day = (n: number) => new Date(Date.UTC(2025, 0, 1) + n * 86_400_000);

const inv = (o: Partial<InvoiceLike> = {}): InvoiceLike => ({
  id: 'i1', reference: 'INV-2025-001', customerId: 'cust_1', amount: D('100.00'), amountPaid: D(0), currency: 'EUR', dueAt: day(10), ...o,
});
const txn = (o: Partial<TxnLike> = {}): TxnLike => ({
  id: 't1', providerRef: 'pay_1', reference: 'INV-2025-001', customerId: 'cust_1', amount: D('100.00'), currency: 'EUR', occurredAt: day(9), ...o,
});

describe('normaliseRef', () => {
  it('ignores case and punctuation', () => {
    expect(normaliseRef('INV-2025/001')).toBe(normaliseRef('inv 2025 001'));
  });
});

describe('amountsEqual (decimal safe)', () => {
  it('does not suffer floating point error', () => {
    // 0.1 + 0.2 !== 0.3 in IEEE-754, but must be equal in decimal arithmetic
    expect(amountsEqual(D('0.1').plus(D('0.2')), D('0.3'), 0)).toBe(true);
  });
  it('honours tolerance', () => {
    expect(amountsEqual(D('100.00'), D('100.05'), 0.05)).toBe(true);
    expect(amountsEqual(D('100.00'), D('100.06'), 0.05)).toBe(false);
  });
});

describe('scoreCandidate', () => {
  it('flags a fully matching payment as exact with score 100', () => {
    const c = scoreCandidate(txn(), inv(), DEFAULT_CONFIG);
    expect(c.exact).toBe(true);
    expect(c.score).toBe(100);
  });

  it('is NOT exact when the amount differs; reports underpayment as partial', () => {
    const c = scoreCandidate(txn({ amount: D('60.00') }), inv(), DEFAULT_CONFIG);
    expect(c.exact).toBe(false);
    expect(c.partial).toBe(true);
    expect(c.amountDiff.toString()).toBe('-40');
  });

  it('reports overpayment', () => {
    const c = scoreCandidate(txn({ amount: D('120.00') }), inv(), DEFAULT_CONFIG);
    expect(c.exact).toBe(false);
    expect(c.overpayment).toBe(true);
  });

  it('is NOT exact on a currency mismatch even if the numbers agree', () => {
    const c = scoreCandidate(txn({ currency: 'USD' }), inv(), DEFAULT_CONFIG);
    expect(c.exact).toBe(false);
    expect(c.currencyMismatch).toBe(true);
  });

  it('is NOT exact when the customer conflicts', () => {
    const c = scoreCandidate(txn({ customerId: 'someone_else' }), inv(), DEFAULT_CONFIG);
    expect(c.exact).toBe(false);
  });

  it('allows an unknown customer on one side', () => {
    expect(scoreCandidate(txn({ customerId: null }), inv(), DEFAULT_CONFIG).exact).toBe(true);
  });

  it('treats a reference merely contained in free text as a suggestion, never exact', () => {
    const c = scoreCandidate(txn({ reference: 'Payment for INV-2025-001 thanks' }), inv(), DEFAULT_CONFIG);
    expect(c.exact).toBe(false);
    expect(c.score).toBeGreaterThan(50);
  });

  it('compares against the OUTSTANDING balance, not the invoice total', () => {
    const c = scoreCandidate(txn({ amount: D('40.00') }), inv({ amountPaid: D('60.00') }), DEFAULT_CONFIG);
    expect(c.exact).toBe(true);
  });

  it('respects configured tolerance', () => {
    const cfg = resolveConfig({ amountTolerance: 0.5 });
    expect(scoreCandidate(txn({ amount: D('100.40') }), inv(), cfg).exact).toBe(true);
    expect(scoreCandidate(txn({ amount: D('100.40') }), inv(), DEFAULT_CONFIG).exact).toBe(false);
  });

  it('exposes per-criterion reasons for reviewers', () => {
    const c = scoreCandidate(txn({ amount: D('1.00') }), inv(), DEFAULT_CONFIG);
    expect(c.reasons.find((r) => r.criterion === 'amount')?.matched).toBe(false);
    expect(c.reasons).toHaveLength(5);
  });
});

describe('rankCandidates', () => {
  it('prefers the exact match', () => {
    const invoices = [inv({ id: 'a', reference: 'INV-X', amount: D('100.00') }), inv({ id: 'b' })];
    const ranked = rankCandidates(txn(), invoices, DEFAULT_CONFIG);
    expect(ranked[0].invoiceId).toBe('b');
    expect(ranked[0].exact).toBe(true);
  });

  it('downgrades ambiguous exact matches so a human must choose', () => {
    const invoices = [inv({ id: 'a' }), inv({ id: 'b' })];
    const ranked = rankCandidates(txn(), invoices, DEFAULT_CONFIG);
    expect(ranked.every((c) => !c.exact)).toBe(true);
  });

  it('drops candidates below the suggestion threshold', () => {
    const far = inv({ id: 'z', reference: 'OTHER-999', customerId: 'zzz', currency: 'SEK', dueAt: day(400) });
    expect(rankCandidates(txn(), [far], DEFAULT_CONFIG)).toHaveLength(0);
  });
});

describe('findDuplicateGroups', () => {
  it('groups same customer/amount/currency/reference inside the window', () => {
    const a = txn({ id: 'a', providerRef: 'p1', occurredAt: day(1) });
    const b = txn({ id: 'b', providerRef: 'p2', occurredAt: new Date(day(1).getTime() + 3_600_000) });
    expect(findDuplicateGroups([a, b])).toHaveLength(1);
  });
  it('does not group outside the window', () => {
    const a = txn({ id: 'a', occurredAt: day(1) });
    const b = txn({ id: 'b', occurredAt: day(20) });
    expect(findDuplicateGroups([a, b])).toHaveLength(0);
  });
  it('does not group different amounts or currencies', () => {
    const a = txn({ id: 'a' });
    expect(findDuplicateGroups([a, txn({ id: 'b', amount: D('101') })])).toHaveLength(0);
    expect(findDuplicateGroups([a, txn({ id: 'c', currency: 'USD' })])).toHaveLength(0);
  });
});

describe('resolveConfig', () => {
  it('fills defaults', () => expect(resolveConfig({})).toEqual(DEFAULT_CONFIG));
  it('rejects negative tolerance', () => expect(() => resolveConfig({ amountTolerance: -1 })).toThrow());
  it('rejects all-zero weights', () =>
    expect(() => resolveConfig({ weights: { reference: 0, amount: 0, currency: 0, date: 0, customer: 0 } })).toThrow());
});
