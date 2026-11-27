import { describe, expect, it } from 'vitest';
import { clockSpan, longDay, momoDay, numericDay, statementRange } from '../src/statement-dates';

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

describe('statementRange: last 90 days, ending today', () => {
  it('26 Nov 2026 -> 28 Aug 2026', () => {
    const r = statementRange(new Date(2026, 10, 26, 15, 30));
    expect(ymd(r.start)).toBe('2026-08-28');
    expect(ymd(r.end)).toBe('2026-11-26');
  });
  it('crosses a year and a leap day', () => {
    expect(ymd(statementRange(new Date(2028, 2, 1)).start)).toBe('2027-12-02'); // 2028 is a leap year
    expect(ymd(statementRange(new Date(2027, 0, 15)).start)).toBe('2026-10-17');
  });
  it('is calendar days at midnight, whatever the time of day', () => {
    const a = statementRange(new Date(2026, 10, 26, 0, 1));
    const b = statementRange(new Date(2026, 10, 26, 23, 59));
    expect(a.start.getTime()).toBe(b.start.getTime());
    expect(a.start.getHours()).toBe(0);
  });
  it('formats in the given locale', () => {
    const { start } = statementRange(new Date(2026, 10, 26));
    expect(longDay(start, 'en-GB')).toBe('28 Aug 2026');
    expect(numericDay(start, 'en-GB')).toBe('28/08/2026');
    expect(numericDay(start, 'en-US')).toBe('08/28/2026');
  });
  it('MTN MoMo format: DD MM YYYY with spaces, whatever the locale', () => {
    const { start, end } = statementRange(new Date(2026, 10, 27));
    expect(momoDay(start)).toBe('29 08 2026');
    expect(momoDay(end)).toBe('27 11 2026');
    expect(momoDay(new Date(2027, 0, 5))).toBe('05 01 2027');
  });
});

describe('clockSpan', () => {
  it('formats elapsed waiting time', () => {
    expect(clockSpan(0)).toBe('0:00');
    expect(clockSpan(102_400)).toBe('1:42');
    expect(clockSpan(3_725_000)).toBe('1:02:05');
    expect(clockSpan(-5)).toBe('0:00');
  });
});
