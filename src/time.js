// Local-time helpers. Servers usually run in UTC, so everything that depends on
// the clock (quiet hours, the daily summary, "today") uses the TIMEZONE setting.

const formatters = new Map();
function formatter(timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(
      timeZone,
      new Intl.DateTimeFormat("en-CA", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }),
    );
  }
  return formatters.get(timeZone);
}

/** @returns {{ date: string, year: number, minuteOfDay: number }}  date is YYYY-MM-DD in that timezone */
export function localParts(epochMs, timeZone) {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(epochMs)).map((p) => [p.type, p.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    year: Number(parts.year),
    minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** Throws a clear error for a bad TIMEZONE instead of failing later. */
export function checkTimeZone(timeZone) {
  try {
    formatter(timeZone);
  } catch {
    throw new Error(`Unknown TIMEZONE "${timeZone}". Use a name like Asia/Kolkata or Europe/London.`);
  }
}

/** "21:30" -> 1290. Throws on anything else. */
export function parseClock(text) {
  const match = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(text || "");
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error(`Invalid time "${text}" (use HH:MM)`);
  return Number(match[1]) * 60 + Number(match[2]);
}

/** "23:00-08:00" -> { start, end } in minutes; empty or "off" -> null. */
export function parseWindow(text) {
  if (!text || /^\s*off\s*$/i.test(text)) return null;
  const [start, end] = text.split("-");
  if (end === undefined) throw new Error(`Invalid QUIET_HOURS "${text}" (use HH:MM-HH:MM or off)`);
  const window = { start: parseClock(start), end: parseClock(end) };
  return window.start === window.end ? null : window;
}

export function isInWindow(minuteOfDay, window) {
  if (!window) return false;
  return window.start < window.end
    ? minuteOfDay >= window.start && minuteOfDay < window.end
    : minuteOfDay >= window.start || minuteOfDay < window.end; // crosses midnight
}

/**
 * The first moment at or after epochMs that is outside the quiet window.
 * Steps minute by minute (at most a day), which stays correct across DST changes.
 */
export function endOfQuiet(epochMs, window, timeZone) {
  let t = epochMs;
  for (let i = 0; i <= 24 * 60 && isInWindow(localParts(t, timeZone).minuteOfDay, window); i++) {
    t = (Math.floor(t / 60000) + 1) * 60000;
  }
  return t;
}
