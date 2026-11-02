// Times (Part 1 Sections 7.1 and 8.2). Inside the resolver every time is POSIX milliseconds. A block
// time is the system start plus the slot number in seconds. Output uses YYYY-MM-DDThh:mm:ssZ with
// milliseconds rounded down.

import type { NetworkParameters } from "./settings.js";

export function blockTimeMs(slot: number, network: NetworkParameters): number {
  return (network.systemStart + slot * network.slotLength) * 1000;
}

export function formatTime(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

const VERSION_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;

const isLeapYear = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** Days from 1970-01-01 to a proleptic Gregorian date (H. Hinnant, "days_from_civil"). */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

/**
 * A `versionTime` value (Part 1 Section 7.1): `YYYY-MM-DDThh:mm:ssZ`, a real calendar date, hours
 * 00-23, minutes and seconds 00-59. Returns POSIX milliseconds, or null for any other text.
 */
export function parseVersionTime(text: string): number | null {
  const m = VERSION_TIME.exec(text);
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  const monthDays = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]! || hour > 23 || minute > 59 || second > 59) return null;
  return ((daysFromCivil(year, month, day) * 24 + hour) * 60 + minute) * 60_000 + second * 1000;
}
