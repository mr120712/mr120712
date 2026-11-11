// @polsia:user-owned
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { useSession } from '@/lib/auth-client';
import { requestErrorMessage } from '@/lib/business/request-error-message';
import {
  CommunityProfileResponseSchema,
  type CommunityProfileSummary,
} from '@/lib/contracts/community';
import { MessageMutationResponseSchema } from '@/lib/contracts/messages';
import styles from './messages.module.css';

export function NewMessage({ profileId }: { profileId: string }) {
  const router = useRouter();
  const { data: session, isPending: sessionPending } = useSession();
  const [profile, setProfile] = useState<CommunityProfileSummary | null>(null);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(Boolean(profileId));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadProfile = useCallback(async () => {
    if (!profileId) return;
    setLoading(true);
    setError(null);
    try {
      const result = await apiFetch(`/api/community/profiles/${encodeURIComponent(profileId)}`, {
        schema: CommunityProfileResponseSchema,
      });
      if (result.profile.isSelf) {
        setError('Non puoi inviare un messaggio al tuo profilo.');
        return;
      }
      setProfile(result.profile);
    } catch {
      setError('Questo profilo non è disponibile.');
    } finally {
      setLoading(false);
    }
  }, [profileId]);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profile || sending) return;
    setSending(true);
    setError(null);
    try {
      const result = await apiFetch('/api/messages', {
        method: 'POST',
        body: JSON.stringify({ profileId: profile.id, content }),
        schema: MessageMutationResponseSchema,
      });
      router.replace(`/messages/${encodeURIComponent(result.conversationId)}`);
      router.refresh();
    } catch (caught) {
      setError(
        requestErrorMessage(
          caught,
          'Il messaggio non è stato inviato. Controlla la connessione e riprova.',
        ),
      );
    } finally {
      setSending(false);
    }
  }

  if (!profileId) {
    return (
      <main className={styles.page}>
        <section className={styles.emptyState}>
          <h1>Scegli un profilo</h1>
          <p>Apri un profilo pubblico della community per iniziare una conversazione.</p>
          <Button asChild>
            <Link href="/community">Esplora la community</Link>
          </Button>
        </section>
      </main>
    );
  }

  const draftUrl = `/messages/new?profile=${encodeURIComponent(profileId)}`;
  if (!session?.user) {
    if (sessionPending) {
      return (
        <main className={styles.page}>
          <output className={styles.state}>Verifica accesso…</output>
        </main>
      );
    }
    return (
      <main className={styles.page}>
        <section className={styles.emptyState}>
          <p className={styles.eyebrow}>ACCESSO RICHIESTO</p>
          <h1>Accedi per scrivere</h1>
          <p>La conversazione resta privata e accessibile solo ai partecipanti.</p>
          <Button asChild>
            <Link href={`/login?callbackURL=${encodeURIComponent(draftUrl)}`}>
              Accedi e continua
            </Link>
          </Button>
        </section>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <p className={styles.eyebrow}>NUOVA CONVERSAZIONE</p>
          <h1 className={styles.title}>
            {profile?.name ?? (loading ? 'Caricamento profilo…' : 'Profilo')}
          </h1>
          {profile ? (
            <span className={styles.role}>{profile.role === 'artist' ? 'Artista' : 'Fan'}</span>
          ) : null}
        </div>
        <Button asChild variant="outline">
          <Link href="/community">Torna alla community</Link>
        </Button>
      </header>
      {loading ? <output className={styles.state}>Caricamento profilo…</output> : null}
      {error && !loading ? (
        <section className={styles.emptyState} role="alert">
          <h2>Impossibile iniziare</h2>
          <p>{error}</p>
          <Button type="button" variant="outline" onClick={() => void loadProfile()}>
            Riprova
          </Button>
        </section>
      ) : profile ? (
        <form className={styles.composerCard} onSubmit={send}>
          <label className={styles.fieldLabel} htmlFor="first-message">
            Il tuo messaggio
          </label>
          <textarea
            id="first-message"
            className={styles.textarea}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            maxLength={5000}
            rows={6}
            placeholder="Da quale ascolto vuoi iniziare?"
            required
          />
          <div className={styles.composerFooter}>
            <span className={styles.hint}>
              Solo tu e {profile.name} potrete leggere questa chat.
            </span>
            <Button type="submit" disabled={sending || !content.trim()}>
              {sending ? 'Invio…' : 'Invia messaggio'}
            </Button>
          </div>
          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
        </form>
      ) : null}
    </main>
  );
}
