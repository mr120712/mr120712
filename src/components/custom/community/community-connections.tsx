// @polsia:user-owned
'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import {
  CommunityConnectionsResponseSchema,
  type CommunityProfileRole,
} from '@/lib/contracts/community';
import { CommunityFollowButton } from './community-follow-button';
import styles from './community-ui.module.css';

type Connection = {
  id: string;
  name: string;
  role: CommunityProfileRole;
  isFollowing: boolean;
};
type ListKind = 'followers' | 'following';
type ViewState = 'loading' | 'ready' | 'private' | 'unavailable';

function roleLabel(role: CommunityProfileRole) {
  return role === 'artist' ? 'Artista' : 'Fan';
}

export function CommunityConnections({ profileId, list }: { profileId: string; list: ListKind }) {
  const [profiles, setProfiles] = useState<Connection[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [state, setState] = useState<ViewState>('loading');
  const [loadingMore, setLoadingMore] = useState(false);

  const load = useCallback(
    async (offset: number, append: boolean) => {
      setState((current) => (append ? current : 'loading'));
      if (append) setLoadingMore(true);
      try {
        const result = await apiFetch(
          '/api/community/profiles/' +
            encodeURIComponent(profileId) +
            '/connections?list=' +
            list +
            '&offset=' +
            offset,
          { schema: CommunityConnectionsResponseSchema },
        );
        setProfiles((current) => (append ? [...current, ...result.profiles] : result.profiles));
        setNextOffset(result.nextOffset);
        setState('ready');
      } catch (error) {
        const body =
          error instanceof Error && typeof error.cause === 'object' && error.cause !== null
            ? error.cause
            : null;
        const code =
          typeof body === 'object' && body !== null && 'error' in body ? body.error : null;
        setState(code === 'connection_list_private' ? 'private' : 'unavailable');
      } finally {
        setLoadingMore(false);
      }
    },
    [list, profileId],
  );

  useEffect(() => {
    setProfiles([]);
    setNextOffset(null);
    void load(0, false);
  }, [load]);

  function updateFollowing(targetId: string, following: boolean) {
    setProfiles((current) =>
      current.map((profile) =>
        profile.id === targetId ? { ...profile, isFollowing: following } : profile,
      ),
    );
  }

  const heading = list === 'followers' ? 'Follower' : 'Profili seguiti';

  if (state === 'loading') {
    return (
      <main className={styles.page}>
        <output className={styles.muted}>Caricamento {heading.toLocaleLowerCase('it-IT')}…</output>
      </main>
    );
  }

  if (state === 'private') {
    return (
      <main className={styles.page}>
        <section className={styles.statePanel}>
          <p className={styles.eyebrow}>RELAZIONI SOLCO</p>
          <h1>Questa lista è privata</h1>
          <p>La persona ha scelto di non mostrare questa lista.</p>
          <Button asChild variant="outline">
            <Link href={`/profiles/${encodeURIComponent(profileId)}`}>Torna al profilo</Link>
          </Button>
        </section>
      </main>
    );
  }

  if (state === 'unavailable') {
    return (
      <main className={styles.page}>
        <section className={styles.statePanel} aria-live="polite">
          <h1>Lista non disponibile</h1>
          <p>Non è stato possibile caricare le relazioni. Riprova.</p>
          <Button type="button" variant="outline" onClick={() => void load(0, false)}>
            Riprova
          </Button>
          <Button asChild variant="link">
            <Link href={`/profiles/${encodeURIComponent(profileId)}`}>Torna al profilo</Link>
          </Button>
        </section>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <p className={styles.eyebrow}>RELAZIONI SOLCO</p>
      <h1 className={styles.title}>{heading}</h1>
      <p className={styles.description}>
        Profili pubblici che questa persona ha scelto di condividere.
      </p>
      <div className={styles.connectionHeader}>
        <h2>
          {profiles.length === 0
            ? 'Nessun profilo visibile'
            : `${profiles.length} profili mostrati`}
        </h2>
      </div>
      {profiles.length === 0 ? (
        <section className={styles.statePanel}>
          <h2>Questa lista è vuota</h2>
          <p>Quando ci saranno profili pubblici in questa lista, li vedrai qui.</p>
          <Button asChild variant="outline">
            <Link href="/community">Esplora la community</Link>
          </Button>
          {nextOffset !== null ? (
            <Button
              type="button"
              variant="outline"
              disabled={loadingMore}
              onClick={() => void load(nextOffset, true)}
            >
              {loadingMore ? 'Caricamento…' : 'Carica altri profili'}
            </Button>
          ) : null}
        </section>
      ) : (
        <>
          <div className={styles.grid}>
            {profiles.map((profile) => (
              <article className={styles.profileCard} key={profile.id}>
                <span className={styles.avatar} aria-hidden="true">
                  {profile.name.trim().charAt(0).toLocaleUpperCase('it-IT') || 'S'}
                </span>
                <div className={styles.profileCopy}>
                  <Link
                    className={styles.profileLink}
                    href={`/profiles/${encodeURIComponent(profile.id)}`}
                  >
                    {profile.name}
                  </Link>
                  <div className={styles.profileMeta}>
                    <span className={styles.role}>{roleLabel(profile.role)}</span>
                  </div>
                </div>
                <CommunityFollowButton
                  profileId={profile.id}
                  name={profile.name}
                  initialFollowing={profile.isFollowing}
                  returnTo={`/profiles/${encodeURIComponent(profileId)}/${list}`}
                  onFollowingChange={(following) => updateFollowing(profile.id, following)}
                />
              </article>
            ))}
          </div>
          {nextOffset !== null ? (
            <div className="mt-6 flex justify-center">
              <Button
                type="button"
                variant="outline"
                disabled={loadingMore}
                onClick={() => void load(nextOffset, true)}
              >
                {loadingMore ? 'Caricamento…' : 'Carica altri profili'}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </main>
  );
}
