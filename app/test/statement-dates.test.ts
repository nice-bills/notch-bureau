import { describe, expect, it } from 'vitest';
import { longDay, momoDay, numericDay, statementRange, waitStage } from '../src/statement-dates';

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

describe('statementRange: last 90 days, ending yesterday', () => {
  it('26 Nov 2026 -> 28 Aug 2026', () => {
    const r = statementRange(new Date(2026, 10, 26, 15, 30));
    expect(ymd(r.start)).toBe('2026-08-28');
    expect(ymd(r.end)).toBe('2026-11-25'); // MTN refuses today as the end date
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
    expect(momoDay(end)).toBe('26 11 2026');
    expect(momoDay(new Date(2027, 0, 5))).toBe('05 01 2027');
  });
});

describe('waitStage', () => {
  it('picks the waiting message from elapsed time', () => {
    expect(waitStage(0)).toBe('preparing');
    expect(waitStage(-5)).toBe('preparing');
    expect(waitStage(119_999)).toBe('preparing');
    expect(waitStage(120_000)).toBe('usually');
    expect(waitStage(599_999)).toBe('usually');
    expect(waitStage(600_000)).toBe('stuck');
    expect(waitStage(3 * 3_600_000)).toBe('stuck');
  });
});
