// @polsia:user-owned
const LISTENING_TIME_ZONE = 'Europe/Rome';

type ZonedDateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export const FREE_MONTHLY_LISTEN_LIMIT = 40;

function zonedDateParts(date: Date): ZonedDateParts {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: LISTENING_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => {
    const part = parts.find((item) => item.type === type);
    if (!part) throw new Error(`Missing date part: ${type}`);
    return Number(part.value);
  };

  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second'),
  };
}

function romeMidnightToUtc(year: number, month: number) {
  const localMidnightAsUtc = Date.UTC(year, month - 1, 1);
  const utcGuess = new Date(localMidnightAsUtc);
  const localAtGuess = zonedDateParts(utcGuess);
  const localTimestampAtGuess = Date.UTC(
    localAtGuess.year,
    localAtGuess.month - 1,
    localAtGuess.day,
    localAtGuess.hour,
    localAtGuess.minute,
    localAtGuess.second,
  );
  return new Date(localMidnightAsUtc - (localTimestampAtGuess - localMidnightAsUtc));
}

export function getListeningCalendarMonth(now: Date = new Date()) {
  const parts = zonedDateParts(now);
  const nextMonth =
    parts.month === 12
      ? { year: parts.year + 1, month: 1 }
      : { year: parts.year, month: parts.month + 1 };
  const monthLabel = new Intl.DateTimeFormat('it-IT', {
    timeZone: LISTENING_TIME_ZONE,
    month: 'long',
    year: 'numeric',
  }).format(now);

  return {
    start: romeMidnightToUtc(parts.year, parts.month),
    end: romeMidnightToUtc(nextMonth.year, nextMonth.month),
    monthLabel,
  };
}

export function createListeningUsage(used: number, now: Date = new Date()) {
  return {
    used,
    limit: FREE_MONTHLY_LISTEN_LIMIT,
    remaining: Math.max(0, FREE_MONTHLY_LISTEN_LIMIT - used),
    month: getListeningCalendarMonth(now).monthLabel,
  };
}
