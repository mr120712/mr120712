// @polsia:user-owned — regole dei premi (pure: nessun accesso al database, testabili).

export const REWARDS = {
  /** Bonus di benvenuto all'amico invitato, una sola volta, dopo il suo primo pagamento. */
  inviteeWelcomeDays: 30,
  /** Premio TOTALE per chi invita, in base agli amici che hanno pagato Premium. */
  referralTiers: [
    { friends: 1, totalDays: 30 },
    { friends: 3, totalDays: 90 },
    { friends: 5, totalDays: 180 },
    { friends: 10, totalDays: 360 },
  ],
  /** Fondatori: i primi 100 iscritti. */
  founderLimit: 100,
  founderDays: 30,
  /** Ascolta e guadagna: ogni 10 giorni con almeno 10 minuti, 1 giorno Premium. */
  listeningDayMinSeconds: 10 * 60,
  listeningDaysPerReward: 10,
  /** Fedeltà: dopo 6 mesi di abbonamento, 1 mese gratis. */
  loyaltyMonths: 6,
  loyaltyDays: 30,
  /** Compleanno: 7 giorni. */
  birthdayDays: 7,
  /** Un "tick" di ascolto vale al massimo 60 s, e al massimo uno ogni 50 s. */
  maxTickSeconds: 60,
  minTickIntervalMs: 50_000,
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const TIME_ZONE = 'Europe/Rome';

/** Giorno di calendario in Italia (YYYY-MM-DD). */
export function romeDay(now: Date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** I premi si sommano: il nuovo periodo parte dopo l'ultimo ancora attivo (o da `startsAt`). */
export function grantWindow(input: {
  now: Date;
  days: number;
  latestEnd: Date | null;
  startsAt?: Date | null;
}) {
  const base = Math.max(
    input.now.getTime(),
    input.latestEnd?.getTime() ?? 0,
    input.startsAt?.getTime() ?? 0,
  );
  return { startsAt: new Date(base), endsAt: new Date(base + input.days * DAY_MS) };
}

export type ListeningDayRow = { day: string; seconds: number };

export function qualifyingListeningDays(days: ListeningDayRow[]) {
  return days.filter((row) => row.seconds >= REWARDS.listeningDayMinSeconds).length;
}

/** Numero totale di premi "ascolta e guadagna" maturati finora. */
export function listeningRewardsEarned(days: ListeningDayRow[]) {
  return Math.floor(qualifyingListeningDays(days) / REWARDS.listeningDaysPerReward);
}

/**
 * Premi progressivi per chi invita: per ogni soglia raggiunta, i giorni da aggiungere
 * (differenza rispetto alla soglia precedente). Sommati danno il premio totale della soglia.
 */
export function referralTierGrants(paidFriends: number) {
  let previous = 0;
  const grants: { friends: number; days: number; totalDays: number }[] = [];
  for (const tier of REWARDS.referralTiers) {
    if (paidFriends < tier.friends) break;
    grants.push({
      friends: tier.friends,
      days: tier.totalDays - previous,
      totalDays: tier.totalDays,
    });
    previous = tier.totalDays;
  }
  return grants;
}

/** Premio totale raggiunto e prossima soglia. */
export function referralProgress(paidFriends: number) {
  const reached = referralTierGrants(paidFriends);
  const next = REWARDS.referralTiers.find((tier) => paidFriends < tier.friends) ?? null;
  return { totalDays: reached.at(-1)?.totalDays ?? 0, next };
}

/** "MM-DD" valido (29 febbraio incluso). */
export function normalizeBirthday(value: string) {
  const match = /^(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const daysInMonth = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (!daysInMonth || day < 1 || day > daysInMonth) return null;
  return `${match[1]}-${match[2]}`;
}

export function isBirthdayToday(birthday: string | null, now: Date) {
  if (!birthday) return false;
  const today = romeDay(now).slice(5);
  // Born on 29 Feb: celebrate on 28 Feb in non-leap years.
  if (birthday === '02-29') {
    const year = Number(romeDay(now).slice(0, 4));
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return today === (leap ? '02-29' : '02-28');
  }
  return today === birthday;
}

export function monthsBetween(from: Date, to: Date) {
  let months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12;
  months += to.getUTCMonth() - from.getUTCMonth();
  if (to.getUTCDate() < from.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

export function makeReferralCode(random: () => number = Math.random) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let code = '';
  for (let i = 0; i < 8; i += 1) code += alphabet[Math.floor(random() * alphabet.length)];
  return code;
}
