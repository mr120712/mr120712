// @polsia:user-owned — cancello delle API della libreria pubblica (/api/music/public-uploads/**):
// da spenta (src/lib/features.ts) rispondono 404 { error: 'not_found' }, mai in cache. Va chiamato
// PER PRIMO nella route, prima di sessione, limiti e lettura del corpo: una funzione spenta non
// costa nulla. Non lo usano l'elenco, la rimozione e il download dei propri brani, che restano
// all'autore.
import 'server-only';
import { NextResponse } from 'next/server';
import { publicUploadsEnabled } from '@/lib/features';

/** La risposta 404 se la libreria pubblica è spenta; null se è attiva (la route prosegue). */
export function publicUploadsDisabledResponse(): NextResponse | null {
  if (publicUploadsEnabled()) return null;
  return NextResponse.json(
    { error: 'not_found' },
    { status: 404, headers: { 'Cache-Control': 'no-store' } },
  );
}
