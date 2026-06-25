import type { UserSettings } from "../types";

/** Parse "HH:MM" into minutes since midnight, or undefined if malformed. */
function toMinutes(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return undefined;
  return hours * 60 + minutes;
}

/** True if notifications should be suppressed right now. Handles overnight ranges. */
export function isWithinQuietHours(settings: UserSettings, now: Date = new Date()): boolean {
  if (!settings.quietHoursEnabled) return false;
  const start = toMinutes(settings.quietHoursStart);
  const end = toMinutes(settings.quietHoursEnd);
  if (start == null || end == null || start === end) return false;

  const current = now.getHours() * 60 + now.getMinutes();
  if (start < end) {
    return current >= start && current < end;
  }
  // Range spans midnight, e.g. 22:00 -> 08:00.
  return current >= start || current < end;
}
