import { describe, expect, it } from 'vitest';
import { centsText, fixSeparators, normalizeAmount } from '../src/amount-input';

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
