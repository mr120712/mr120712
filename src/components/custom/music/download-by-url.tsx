// @polsia:user-owned — "Scarica da URL": incolli un link e scarichi il file sul dispositivo. La rotta
// accetta SOLO i tuoi upload su Solco (verificati per proprietario) o brani Audius scaricabili; i link
// esterni sono rifiutati con un messaggio chiaro. Il download è binario, quindi NON passa da apiFetch.
'use client';

import { Download, Loader2 } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DownloadByUrlErrorSchema } from '@/lib/contracts/url-download';

const ENDPOINT = '/api/music/download/by-url';

/** Nome file dall'header Content-Disposition (filename*= UTF-8 se presente, altrimenti filename="..."). */
function filenameFromDisposition(header: string | null): string {
  if (!header) return 'brano.mp3';
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (utf8?.[1]) {
    try {
      return decodeURIComponent(utf8[1]);
    } catch {
      // fallback sotto
    }
  }
  const ascii = /filename="?([^";]+)"?/i.exec(header);
  return ascii?.[1] ?? 'brano.mp3';
}

/** Avvia il salvataggio del Blob come file nel browser. */
function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // Dà al browser il tempo di avviare il download prima di revocare l'URL.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

export function DownloadByUrl() {
  const inputId = useId();
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = url.trim();
    if (!value || loading) return;
    setLoading(true);
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: value }),
      });
      if (!res.ok) {
        let message = 'Download non riuscito. Riprova.';
        try {
          const parsed = DownloadByUrlErrorSchema.safeParse(await res.json());
          if (parsed.success) message = parsed.data.message;
        } catch {
          // corpo non JSON: resta il messaggio generico
        }
        toast.error(message);
        return;
      }
      const blob = await res.blob();
      if (blob.size === 0) {
        toast.error('Il file scaricato è vuoto.');
        return;
      }
      saveBlob(blob, filenameFromDisposition(res.headers.get('content-disposition')));
      toast.success('Download avviato.');
    } catch {
      toast.error('Rete non disponibile: riprova.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <div className="flex-1">
        <label htmlFor={inputId} className="mb-1.5 block text-sm font-medium">
          Link del brano
        </label>
        <Input
          id={inputId}
          type="url"
          inputMode="url"
          autoComplete="off"
          placeholder="https://…"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          disabled={loading}
          aria-describedby={`${inputId}-hint`}
        />
      </div>
      <Button type="submit" disabled={loading || url.trim().length === 0}>
        {loading ? (
          <Loader2 aria-hidden="true" className="animate-spin" />
        ) : (
          <Download aria-hidden="true" />
        )}
        {loading ? 'Scarico…' : 'Scarica'}
      </Button>
    </form>
  );
}
