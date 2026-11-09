import { describe, expect, it } from 'vitest';
import { atLeast, label, money, moneyList, parseCsv } from './format';

describe('money', () => {
  it('formats with the currency code and two decimals', () => {
    expect(money('1250.5', 'EUR')).toBe('EUR 1,250.50');
    expect(money('0', 'USD')).toBe('USD 0.00');
  });
  it('handles empty values and unknown currencies without throwing', () => {
    expect(money(null, 'EUR')).toBe('—');
    expect(money('', 'EUR')).toBe('—');
    expect(money('5', 'NOPE!')).toContain('5');
  });
  it('joins multiple currencies', () => {
    expect(moneyList([{ currency: 'EUR', amount: '10' }, { currency: 'USD', amount: '5' }])).toBe('EUR 10.00 · USD 5.00');
  });
});

describe('atLeast (role hint)', () => {
  it('orders ANALYST < MANAGER < ADMIN', () => {
    expect(atLeast('ADMIN', 'MANAGER')).toBe(true);
    expect(atLeast('MANAGER', 'MANAGER')).toBe(true);
    expect(atLeast('ANALYST', 'MANAGER')).toBe(false);
    expect(atLeast(undefined, 'ANALYST')).toBe(false);
  });
});

describe('label', () => {
  it('humanises enum values', () => expect(label('DUPLICATE_TRANSACTION')).toBe('Duplicate transaction'));
});

describe('parseCsv', () => {
  it('parses plain rows and skips blank lines', () => {
    expect(parseCsv('a,b\n1,2\n\n3,4\n')).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
  });
  it('handles quoted commas, escaped quotes, newlines inside quotes and CRLF', () => {
    expect(parseCsv('ref,note\r\n"INV-1","Hello, ""world"""\r\n"INV-2","line1\nline2"')).toEqual([
      ['ref', 'note'], ['INV-1', 'Hello, "world"'], ['INV-2', 'line1\nline2'],
    ]);
  });
  it('keeps empty trailing cells', () => expect(parseCsv('a,b,c\n1,,')).toEqual([['a', 'b', 'c'], ['1', '', '']]));
});
