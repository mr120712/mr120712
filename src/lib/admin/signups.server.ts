// @polsia:user-owned — numeri aggregati della scheda Iscritti, letti dalla tabella "user" di
// better-auth con due query SQL parametrizzate (nessun dato inserito dall'utente, nessuna stringa
// concatenata). Escono solo conteggi: mai nomi, email, telefoni, id o righe per singolo utente.
//
// Le colonne DateTime di Prisma su Postgres sono `timestamp(3)` SENZA fuso e contengono l'ora UTC:
// `"createdAt" AT TIME ZONE 'UTC'` le rende istanti, `AT TIME ZONE 'Europe/Rome'` le porta all'ora
// italiana (ora legale compresa) prima di troncarle al giorno. I limiti delle finestre arrivano
// come istanti ISO e vengono convertiti allo stesso formato, quindi il risultato non dipende dal
// fuso della sessione del database.
//
// La tabella non ha un indice su "createdAt" (schema di better-auth, framework_owned): ogni query
// è una scansione sequenziale, adatta a una pagina admin aperta ogni tanto.
import 'server-only';
import type { PrismaClient } from '@prisma/client';
import {
  buildSignupStats,
  type RawSignupDay,
  type RawSignupTotals,
  romeDayKey,
  signupDayKeys,
  signupWindows,
} from '@/lib/admin/signups';
import type { AdminSignups } from '@/lib/contracts/admin-signups';
import { prisma } from '@/lib/db';

export type SignupsDb = Pick<PrismaClient, '$queryRaw'>;

export async function getSignupStats(
  now: Date = new Date(),
  db: SignupsDb = prisma,
): Promise<AdminSignups> {
  const { nowIso, since24h, since7d, since30d } = signupWindows(now);
  const keys = signupDayKeys(now);
  const firstDay = keys[0] ?? romeDayKey(now);

  const [totals, daily] = await Promise.all([
    db.$queryRaw<RawSignupTotals[]>`
      SELECT
        COUNT(*)::bigint AS "total",
        COUNT(*) FILTER (
          WHERE "createdAt" >= (${since24h}::timestamptz AT TIME ZONE 'UTC')
        )::bigint AS "last24h",
        COUNT(*) FILTER (
          WHERE "createdAt" >= (${since7d}::timestamptz AT TIME ZONE 'UTC')
        )::bigint AS "last7d",
        COUNT(*) FILTER (
          WHERE "createdAt" >= (${since30d}::timestamptz AT TIME ZONE 'UTC')
        )::bigint AS "last30d",
        COUNT(*) FILTER (
          WHERE "emailVerified" IS TRUE OR "phoneNumberVerified" IS TRUE
        )::bigint AS "verified",
        COUNT(*) FILTER (
          WHERE "banned" IS TRUE
            AND ("banExpires" IS NULL
              OR "banExpires" > (${nowIso}::timestamptz AT TIME ZONE 'UTC'))
        )::bigint AS "banned",
        COUNT(*) FILTER (
          WHERE 'admin' = ANY (string_to_array(replace(COALESCE("role", ''), ' ', ''), ','))
        )::bigint AS "admins"
      FROM "user"
    `,
    db.$queryRaw<RawSignupDay[]>`
      SELECT
        to_char(
          date_trunc('day', ("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Rome'),
          'YYYY-MM-DD'
        ) AS "day",
        COUNT(*)::bigint AS "count"
      FROM "user"
      WHERE "createdAt" >= (
        ((${firstDay}::date)::timestamp AT TIME ZONE 'Europe/Rome') AT TIME ZONE 'UTC'
      )
      GROUP BY 1
    `,
  ]);

  return buildSignupStats(now, keys, totals[0], daily);
}
