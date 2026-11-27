import { describe, expect, it } from 'vitest';
import { amountAtStamp, cellAt, centsText, fixSeparators, normalizeAmount, stampUnit } from '../src/amount-input';

const U = (n: number) => BigInt(Math.round(n * 1e6));

describe('fixSeparators', () => {
  it('reads a comma as the decimal mark', () => {
    expect(fixSeparators('4,5')).toBe('4.5');
    expect(fixSeparators('0,37')).toBe('0.37');
    expect(fixSeparators('4,')).toBe('4.');
  });
  it('drops thousands commas', () => {
    expect(fixSeparators('1,000')).toBe('1000');
    expect(fixSeparators('1,000.25')).toBe('1000.25');
    expect(fixSeparators('1,000,000')).toBe('1000000');
  });
});

describe('normalizeAmount', () => {
  const cap = U(11.1);
  it('leaves clean and half-typed input alone', () => {
    expect(normalizeAmount('4.25', cap)).toEqual({ text: '4.25', note: null });
    expect(normalizeAmount('4.', cap)).toEqual({ text: '4.', note: null });
    expect(normalizeAmount('', cap)).toEqual({ text: '', note: null });
    expect(normalizeAmount('.', cap)).toEqual({ text: '.', note: null });
  });
  it('rounds more than 2 decimals DOWN, with a note', () => {
    expect(normalizeAmount('4.257', cap)).toEqual({ text: '4.25', note: 'Rounded to 2 decimals' });
    expect(normalizeAmount('4.999', cap)).toEqual({ text: '4.99', note: 'Rounded to 2 decimals' });
  });
  it('accepts a comma decimal', () => {
    expect(normalizeAmount('4,5', cap)).toEqual({ text: '4.5', note: null });
    // "4,567" reads as four thousand (3 digits after the comma), then clamps.
    expect(normalizeAmount('4,567', U(50))).toEqual({ text: '50', note: 'Your limit is 50.00' });
  });
  it('clamps above the cap, with a note', () => {
    expect(normalizeAmount('12', cap)).toEqual({ text: '11.1', note: 'Your limit is 11.10' });
    expect(normalizeAmount('11.11', cap)).toEqual({ text: '11.1', note: 'Your limit is 11.10' });
    expect(normalizeAmount('11.10', cap)).toEqual({ text: '11.10', note: null });
    expect(normalizeAmount('2500', U(2000), (c) => `Max ${c}`).note).toBe('Max 2000000000');
  });
  it('clamps a sub-cent cap to the cent below', () => {
    expect(normalizeAmount('20', 11_104_999n)).toEqual({ text: '11.1', note: 'Your limit is 11.10' });
  });
  it('leaves junk for the field error', () => {
    expect(normalizeAmount('abc', cap)).toEqual({ text: 'abc', note: null });
    expect(normalizeAmount('1.2.3', cap)).toEqual({ text: '1.2.3', note: null });
  });
});

describe('centsText', () => {
  it('cuts to the cent', () => {
    expect(centsText(4_259_999n)).toBe('4.25');
    expect(centsText(U(2000))).toBe('2000');
    expect(centsText(0n)).toBe('0');
  });
});

describe('stamp sheet drag', () => {
  // [limit, unit, stamps, last stamp]
  const cases: [number, number, number, number][] = [[11.1, 1, 12, 0.1], [50, 5, 10, 5], [500, 50, 10, 50], [2000, 200, 10, 200]];
  const at = (limit: number, k: number, frac: number, cap = limit) => {
    const L = U(limit), unit = stampUnit(L), n = Number((L + unit - 1n) / unit);
    return amountAtStamp(k, frac, unit, n, L, U(cap));
  };

  it('picks the unit that fits the limit in 12 stamps', () => {
    for (const [limit, unit, n] of cases) {
      const u = stampUnit(U(limit));
      expect(u).toBe(U(unit));
      expect(Number((U(limit) + u - 1n) / u)).toBe(n);
    }
  });

  it('full stamps before the finger plus the share under it, to the cent', () => {
    expect(at(50, 0, 0.5)).toBe(U(2.5));
    expect(at(50, 3, 0.25)).toBe(U(16.25));
    expect(at(500, 2, 0.1234)).toBe(U(106.17));
    expect(at(2000, 4, 0.5)).toBe(U(900));
    expect(at(11.1, 4, 0.25)).toBe(U(4.25));
    // every cent is reachable: 0.07 of a 1 USDC stamp
    expect(at(11.1, 0, 0.07)).toBe(U(0.07));
  });

  it('stamp edges give whole values', () => {
    for (const [limit, unit] of cases) {
      expect(at(limit, 0, 0)).toBe(0n);
      expect(at(limit, 1, 0)).toBe(U(unit));
      expect(at(limit, 0, 1)).toBe(U(unit));
    }
  });

  it('snaps to the whole value within 3% of an edge, not beyond', () => {
    expect(at(500, 2, 0.02)).toBe(U(100));
    expect(at(500, 2, 0.98)).toBe(U(150));
    expect(at(500, 2, 0.04)).toBe(U(102));
    expect(at(500, 2, 0.96)).toBe(U(148));
    expect(at(11.1, 3, 0.029)).toBe(U(3));
    expect(at(11.1, 3, 0.031)).toBe(U(3.03));
  });

  it('the last stamp is worth only the remainder', () => {
    expect(at(11.1, 11, 0.5)).toBe(U(11.05));
    expect(at(11.1, 11, 1)).toBe(U(11.1));
    expect(at(11.1, 11, 0.99)).toBe(U(11.1));
    expect(at(2000, 9, 0.5)).toBe(U(1900));
    // already borrowed 3.40 of 11.10: 8 free stamps, the last worth 0.70
    expect(amountAtStamp(7, 0.5, U(1), 8, U(7.7), U(7.7))).toBe(U(7.35));
    expect(amountAtStamp(7, 1, U(1), 8, U(7.7), U(7.7))).toBe(U(7.7));
  });

  it('clamps to 0..cap', () => {
    expect(at(50, -1, 0.5)).toBe(0n);
    expect(at(50, 10, 0)).toBe(U(50));
    expect(at(500, 9, 0.9, 120)).toBe(U(120));
    expect(at(500, 2, 0.6, 120)).toBe(U(120));
    expect(at(500, 1, 0.5, 120)).toBe(U(75));
    // a cap that is not a whole cent is returned as is, never above
    expect(at(50, 9, 1, 49.123456)).toBe(U(49.123456));
  });

  it('maps a point on the grid to a stamp and how far across it', () => {
    // 4 columns of 80px, 3 rows of 100px, 10 stamps
    expect(cellAt(0, 0, 320, 300, 4, 10)).toEqual({ index: 0, frac: 0 });
    expect(cellAt(100, 50, 320, 300, 4, 10)).toEqual({ index: 1, frac: 0.25 });
    expect(cellAt(60, 150, 320, 300, 4, 10)).toEqual({ index: 4, frac: 0.75 });
    // outside the grid clamps
    expect(cellAt(-20, -20, 320, 300, 4, 10)).toEqual({ index: 0, frac: 0 });
    expect(cellAt(400, 50, 320, 300, 4, 10)).toEqual({ index: 3, frac: 1 });
    // empty cells after the last stamp are the end of the last stamp
    expect(cellAt(300, 250, 320, 300, 4, 10)).toEqual({ index: 9, frac: 1 });
    expect(cellAt(200, 900, 320, 300, 4, 10)).toEqual({ index: 9, frac: 1 });
  });
});
