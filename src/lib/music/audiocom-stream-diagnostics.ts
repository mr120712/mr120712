// @polsia:user-owned — DIAGNOSTICA TEMPORANEA (da togliere con la correzione): perché lo stream
// (`play.url`) di un brano di audio.com con una licenza riproducibile in Solco viene scartato da
// audioComStreamUrl. Solo il motivo, l'host, l'estensione, i NOMI dei parametri e, per un link
// firmato, la sua durata e quanto gli resta: mai l'URL completo, il percorso o il valore di un
// parametro (firma e credenziali restano private). Per ogni host e estensione resta l'ultima voce,
// al più 8 per istanza del server; la ricerca unificata le mostra nell'intestazione
// `x-solco-audiocom-stream`.
const STREAM_DIAGNOSTICS_MAX = 8;
const streamDiagnostics = new Map<string, string>();

const PARAM_NAME = /^[A-Za-z0-9_.-]{1,40}$/;

/** Durata e tempo rimasto di un link firmato (AWS SigV4 o `Expires` in secondi), se riconoscibili. */
function signedLifetime(params: URLSearchParams, now: number): string {
  const amzDate = params.get('X-Amz-Date') ?? '';
  const amzExpires = params.get('X-Amz-Expires') ?? '';
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amzDate);
  if (match && /^\d{1,7}$/.test(amzExpires)) {
    const part = (index: number) => Number(match[index] ?? 0);
    const signedAt = Date.UTC(part(1), part(2) - 1, part(3), part(4), part(5), part(6));
    const remaining = Math.round((signedAt + Number(amzExpires) * 1000 - now) / 1000);
    return `durata=${amzExpires}s resta=${remaining}s`;
  }
  const expires = params.get('Expires') ?? params.get('expires') ?? '';
  if (/^\d{9,11}$/.test(expires)) {
    return `resta=${Math.round(Number(expires) - now / 1000)}s`;
  }
  return '';
}

/** Motivo per cui `play.url` non è uno stream accettato: "vuoto", "relativo", o host + dettagli. */
export function describeRejectedAudioComStream(raw: unknown, now = Date.now()): string {
  if (typeof raw !== 'string' || !raw.trim()) return 'vuoto';
  const value = raw.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value.startsWith('/') ? 'relativo' : 'non-url';
  }
  const ext = /\.([a-z0-9]{1,5})$/i.exec(url.pathname)?.[1]?.toLowerCase() ?? '-';
  const names = [...new Set(url.searchParams.keys())]
    .filter((name) => PARAM_NAME.test(name))
    .sort()
    .slice(0, 12);
  const flags = [
    url.protocol === 'https:' ? '' : url.protocol.replace(/[^a-z]/g, ''),
    url.port ? 'porta' : '',
    url.username || url.password ? 'credenziali' : '',
    url.search ? `query[${names.join('|')}]` : '',
    signedLifetime(url.searchParams, now),
    value.length > 2048 ? 'lungo' : '',
  ].filter(Boolean);
  return [url.hostname, ext, ...flags].join(' ');
}

/** Annota uno stream scartato (chiamata da toAudioComTrack solo per licenze riproducibili). */
export function noteRejectedAudioComStream(raw: unknown): void {
  const description = describeRejectedAudioComStream(raw);
  const key = description.split(' ').slice(0, 2).join(' ');
  if (!streamDiagnostics.has(key) && streamDiagnostics.size >= STREAM_DIAGNOSTICS_MAX) return;
  streamDiagnostics.set(key, description);
}

/** Riepilogo per l'intestazione (vuoto se nessuno stream è stato scartato); solo ASCII stampabile. */
export function audioComStreamDiagnostics(): string {
  return [...streamDiagnostics.values()]
    .join(', ')
    .replace(/[^ -~]/g, '?')
    .slice(0, 600);
}

/** Solo per i test. */
export function clearAudioComStreamDiagnostics(): void {
  streamDiagnostics.clear();
}
