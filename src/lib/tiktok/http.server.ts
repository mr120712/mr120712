// @polsia:user-owned — mappa un TikTokError sulla risposta HTTP per le route admin (codice + messaggio
// in italiano, header privati). Mai token o client_secret nel corpo.
import 'server-only';
import { NextResponse } from 'next/server';
import { TikTokError } from '@/lib/tiktok/client.server';
import { tiktokPrivateHeaders } from '@/lib/tiktok/config.server';

type Mapped = { status: number; error: string; message: string };

function mapError(error: unknown): Mapped {
  if (!(error instanceof TikTokError)) {
    return { status: 502, error: 'failed', message: 'Operazione non riuscita. Riprova.' };
  }
  switch (error.reason) {
    case 'reauth':
      return { status: 401, error: 'reauth', message: 'Ricollega l’account TikTok e riprova.' };
    case 'scope_not_authorized':
      return {
        status: 401,
        error: 'scope',
        message:
          'Manca il permesso di pubblicazione: ricollega l’account concedendo «video.publish».',
      };
    case 'rate_limited':
      return {
        status: 429,
        error: 'rate_limited',
        message: 'Troppe richieste a TikTok. Riprova tra poco.',
      };
    case 'spam_risk':
      return {
        status: 429,
        error: 'spam_risk',
        message: 'TikTok ha bloccato la pubblicazione per sospetto spam. Riprova più tardi.',
      };
    case 'url_ownership_unverified':
      return {
        status: 400,
        error: 'url_ownership_unverified',
        message:
          'Il dominio del video non è verificato: aggiungi l’URL prefix del video nelle proprietà dell’app su TikTok for Developers.',
      };
    case 'privacy_level_mismatch':
      return {
        status: 400,
        error: 'privacy_level_mismatch',
        message:
          'Livello di privacy non consentito per questo account: scegline un altro tra quelli disponibili.',
      };
    case 'unaudited_public':
      return {
        status: 400,
        error: 'unaudited_public',
        message:
          'L’app TikTok non è ancora approvata: finché non passa l’audit puoi pubblicare solo in privato («Solo io»).',
      };
    case 'forbidden':
      return { status: 403, error: 'forbidden', message: 'TikTok ha rifiutato la richiesta.' };
    case 'unavailable':
    case 'network':
      return {
        status: 503,
        error: 'unavailable',
        message: 'TikTok non è raggiungibile in questo momento. Riprova.',
      };
    case 'invalid_response':
      return { status: 502, error: 'failed', message: 'Risposta inattesa da TikTok. Riprova.' };
    default:
      return { status: 400, error: 'bad_request', message: 'Richiesta a TikTok non valida.' };
  }
}

export function tiktokErrorResponse(error: unknown): NextResponse {
  const mapped = mapError(error);
  return NextResponse.json(
    { error: mapped.error, message: mapped.message },
    { status: mapped.status, headers: tiktokPrivateHeaders },
  );
}
