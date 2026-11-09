import { csvCell, neutralise, toCsv } from './csv.util';

describe('CSV export', () => {
  it('quotes commas, quotes and newlines (RFC 4180)', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  it('neutralises spreadsheet formula injection', () => {
    expect(neutralise('=HYPERLINK("http://evil","x")')).toMatch(/^'=/);
    expect(neutralise('+1+1')).toBe("'+1+1");
    expect(neutralise('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(neutralise('-cmd|calc')).toBe("'-cmd|calc");
    expect(neutralise('\t=1')).toBe("'\t=1");
  });

  it('leaves ordinary values, including negative numbers, untouched', () => {
    expect(neutralise('-12.50')).toBe('-12.50');
    expect(neutralise('INV-2025-001')).toBe('INV-2025-001');
    expect(neutralise('100.00')).toBe('100.00');
  });

  it('serialises null, dates and objects', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(new Date('2025-01-02T03:04:05Z'))).toBe('2025-01-02T03:04:05.000Z');
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
  });

  it('builds a header + rows with CRLF line endings and respects column order', () => {
    const out = toCsv(['b', 'a'], [{ a: 1, b: '=evil' }, { a: 2, b: 'ok' }]);
    expect(out).toBe("b,a\r\n'=evil,1\r\nok,2\r\n");
  });
});
