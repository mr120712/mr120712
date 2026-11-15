// @polsia:user-owned — DIAGNOSTICA TEMPORANEA (da togliere con la correzione): perché lo stream
// (`play.url`) di un brano di audio.com con una licenza riproducibile in Solco viene scartato da
// audioComStreamUrl. Solo il motivo, l'host e l'estensione: mai l'URL completo, il percorso o i
// parametri (una firma resterebbe privata). Al più 8 voci diverse per istanza del server; la
// ricerca unificata le mostra nell'intestazione `x-solco-audiocom-stream`.
const STREAM_DIAGNOSTICS_MAX = 8;
const streamDiagnostics = new Set<string>();

/** Motivo per cui `play.url` non è uno stream accettato: "vuoto", "relativo", o host + dettagli. */
export function describeRejectedAudioComStream(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) return 'vuoto';
  const value = raw.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value.startsWith('/') ? 'relativo' : 'non-url';
  }
  const ext = /\.([a-z0-9]{1,5})$/i.exec(url.pathname)?.[1]?.toLowerCase() ?? '-';
  const flags = [
    url.protocol === 'https:' ? '' : url.protocol.replace(/[^a-z]/g, ''),
    url.port ? 'porta' : '',
    url.username || url.password ? 'credenziali' : '',
    url.search ? 'query' : '',
    value.length > 2048 ? 'lungo' : '',
  ].filter(Boolean);
  return [url.hostname, ext, ...flags].join(' ');
}

/** Annota uno stream scartato (chiamata da toAudioComTrack solo per licenze riproducibili). */
export function noteRejectedAudioComStream(raw: unknown): void {
  if (streamDiagnostics.size >= STREAM_DIAGNOSTICS_MAX) return;
  streamDiagnostics.add(describeRejectedAudioComStream(raw));
}

/** Riepilogo per l'intestazione (vuoto se nessuno stream è stato scartato); solo ASCII stampabile. */
export function audioComStreamDiagnostics(): string {
  return [...streamDiagnostics]
    .join(', ')
    .replace(/[^ -~]/g, '?')
    .slice(0, 400);
}

/** Solo per i test. */
export function clearAudioComStreamDiagnostics(): void {
  streamDiagnostics.clear();
}
