// @polsia:user-owned — amministrazione dei video TikTok mostrati in Solco: si incolla il link
// completo di un video pubblico, eventualmente il link del suono ufficiale e un genere.
'use client';

import { Trash2 } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { type TikTokClip, TikTokClipListSchema } from '@/lib/contracts/library';
import { genreCatalog } from '@/lib/music/genre-catalog';
import styles from './discover.module.css';
import { TikTokAnnounceGenerator } from './tiktok-announce-generator';

function errorText(error: unknown) {
  const cause =
    error instanceof Error && typeof error.cause === 'object' && error.cause !== null
      ? (error.cause as { errors?: Record<string, unknown>; error?: unknown })
      : null;
  const first = cause?.errors
    ? Object.values(cause.errors).find((v) => typeof v === 'string')
    : null;
  if (typeof first === 'string') return first;
  if (cause?.error === 'admin_required')
    return 'Serve un account amministratore con email verificata.';
  return 'Operazione non riuscita. Riprova.';
}

export function TikTokAdmin() {
  const [clips, setClips] = useState<TikTokClip[] | null>(null);
  const [url, setUrl] = useState('');
  const [soundUrl, setSoundUrl] = useState('');
  const [caption, setCaption] = useState('');
  const [genreSlug, setGenreSlug] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setClips((await apiFetch('/api/admin/tiktok', { schema: TikTokClipListSchema })).clips);
    } catch (error) {
      setMessage(errorText(error));
      setClips([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (!url.trim() || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await apiFetch('/api/admin/tiktok', {
        method: 'POST',
        body: JSON.stringify({
          url: url.trim(),
          soundUrl: soundUrl.trim() || undefined,
          caption: caption.trim() || undefined,
          genreSlug: genreSlug || undefined,
        }),
      });
      toast.success('Video TikTok aggiunto.');
      setUrl('');
      setSoundUrl('');
      setCaption('');
      await load();
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (clip: TikTokClip) => {
    try {
      await apiFetch(`/api/admin/tiktok?id=${encodeURIComponent(clip.id)}`, { method: 'DELETE' });
      toast.success('Video rimosso.');
      await load();
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  return (
    <div className={styles.page}>
      <header>
        <p className={styles.eyebrow}>AMMINISTRAZIONE</p>
        <h1 className={styles.pageTitle}>Video TikTok</h1>
        <p className={styles.lead}>
          Scegli video TikTok pubblici da mostrare nella Home o nelle pagine dei generi. Preferisci
          gli account ufficiali di artisti ed etichette; niente account di minori e niente video che
          ripubblicano un brano intero. I video si guardano solo nel player ufficiale TikTok e non
          contano negli ascolti né nel piano Premium.
        </p>
      </header>
      <TikTokAnnounceGenerator genreSlug={genreSlug} onUseCaption={setCaption} />
      <form className={styles.aiForm} onSubmit={(event) => void add(event)}>
        <label className={styles.state} htmlFor="tiktok-url">
          Link completo del video (TikTok → Condividi → Copia link, poi aprilo nel browser)
        </label>
        <input
          id="tiktok-url"
          value={url}
          maxLength={500}
          placeholder="https://www.tiktok.com/@autore/video/1234567890123456789"
          onChange={(event) => setUrl(event.target.value)}
          className="min-h-10 rounded-lg border border-input bg-background px-3 text-sm"
        />
        <label className={styles.state} htmlFor="tiktok-sound">
          Link del suono ufficiale (facoltativo)
        </label>
        <input
          id="tiktok-sound"
          value={soundUrl}
          maxLength={500}
          placeholder="https://www.tiktok.com/music/titolo-123456789"
          onChange={(event) => setSoundUrl(event.target.value)}
          className="min-h-10 rounded-lg border border-input bg-background px-3 text-sm"
        />
        <label className={styles.state} htmlFor="tiktok-caption">
          Didascalia scritta da te (facoltativa)
        </label>
        <input
          id="tiktok-caption"
          value={caption}
          maxLength={200}
          onChange={(event) => setCaption(event.target.value)}
          className="min-h-10 rounded-lg border border-input bg-background px-3 text-sm"
        />
        <label className={styles.state} htmlFor="tiktok-genre">
          Dove mostrarlo
        </label>
        <select
          id="tiktok-genre"
          value={genreSlug}
          onChange={(event) => setGenreSlug(event.target.value)}
          className="min-h-10 rounded-lg border border-input bg-background px-3 text-sm"
        >
          <option value="">Home</option>
          {genreCatalog.map((genre) => (
            <option key={genre.slug} value={genre.slug}>
              {genre.name}
            </option>
          ))}
        </select>
        <div className={styles.headerActions}>
          <Button type="submit" disabled={busy || !url.trim()}>
            {busy ? 'Salvataggio…' : 'Aggiungi video'}
          </Button>
        </div>
        {message ? (
          <p className={styles.state} role="alert">
            {message}
          </p>
        ) : null}
      </form>
      <section className={styles.section} aria-label="Video aggiunti">
        <h2>Video aggiunti</h2>
        {clips === null ? <p className={styles.state}>Caricamento…</p> : null}
        {clips?.length === 0 ? <p className={styles.state}>Nessun video ancora.</p> : null}
        <ul className={styles.list}>
          {clips?.map((clip) => (
            <li key={clip.id} className={styles.row}>
              <div className={styles.rowCopy}>
                <strong>@{clip.handle}</strong>
                <span>
                  {clip.genreSlug
                    ? (genreCatalog.find((genre) => genre.slug === clip.genreSlug)?.name ??
                      clip.genreSlug)
                    : 'Home'}
                  {clip.caption ? ` · ${clip.caption}` : ''}
                </span>
                <a href={clip.canonicalUrl} target="_blank" rel="noreferrer">
                  Apri su TikTok
                </a>
              </div>
              <div className={styles.rowActions}>
                <button
                  type="button"
                  className={styles.iconButton}
                  onClick={() => void remove(clip)}
                  aria-label={`Rimuovi il video di @${clip.handle}`}
                >
                  <Trash2 aria-hidden="true" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
