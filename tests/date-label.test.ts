import {execFileSync} from 'node:child_process';
import {describe, expect, it} from 'vitest';
import {dateLabel} from '../apps/web/src/date-label';

const helperUrl = new URL('../apps/web/src/date-label.ts', import.meta.url).href;

describe('calendar-date provenance', () => {
  it.each([
    {timezone: 'America/New_York', day: 7, hour: 19},
    {timezone: 'Asia/Tokyo', day: 8, hour: 9},
  ])('keeps date-only precision and existing timestamps in $timezone', ({timezone, day, hour}) => {
    // A separate process makes TZ effective even when Vitest uses worker threads.
    const script = `
      import {dateLabel} from ${JSON.stringify(helperUrl)};
      const instant = new Date('2026-11-08T00:00:00Z');
      console.log(JSON.stringify({
        calendar: dateLabel('2026-11-08'),
        leapDay: dateLabel('2024-02-29'),
        timestamp: dateLabel(instant.toISOString()),
        expectedTimestamp: instant.toLocaleString(),
        day: instant.getDate(), hour: instant.getHours()
      }));
    `;
    const result = JSON.parse(execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '--eval', script], {
      encoding: 'utf8', env: {...process.env, TZ: timezone},
    }));
    expect(result.calendar).toBe('2026-11-08');
    expect(result.leapDay).toBe('2024-02-29');
    expect(result.timestamp).toBe(result.expectedTimestamp);
    expect(result.timestamp).not.toBe(result.calendar);
    expect(result.day).toBe(day);
    expect(result.hour).toBe(hour);
  });

  it('retains the missing and invalid date fallback', () => {
    for (const value of [undefined, null, '', 'not a date', '2026-13-08']) {
      expect(dateLabel(value)).toBe('Not recorded');
    }
  });
});
