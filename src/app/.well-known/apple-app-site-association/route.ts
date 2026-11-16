// @polsia:user-owned — il file con cui il sito riconosce l'app iOS (Associated Domains): Safari e
// l'app condividono le credenziali salvate (webcredentials) e i link universali potranno aprire
// l'app quando gestirà i percorsi del sito (applinks, per ora senza regole). L'App ID è
// <team>.<identificativo>: il team arriva da APPLE_TEAM_ID su Vercel; senza, la route risponde 404 e
// l'app resta scollegata dal dominio. Apple richiede JSON servito senza redirect: /.well-known è
// fuori dal cancello UAM e il dominio ufficiale non reindirizza.
import { NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { appleAppSiteAssociation } from '@/lib/ios-app';

export const dynamic = 'force-dynamic';

export function GET(): Response {
  const teamId = env.APPLE_TEAM_ID;
  if (!teamId) return new NextResponse(null, { status: 404 });
  return NextResponse.json(appleAppSiteAssociation(teamId), {
    headers: {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=3600',
    },
  });
}
