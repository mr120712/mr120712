// @polsia:user-owned
'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { useSession } from '@/lib/auth-client';
import {
  CommunityDirectoryResponseSchema,
  type CommunityProfileRole,
  type CommunityProfileSummary,
} from '@/lib/contracts/community';
import { CommunityFollowButton } from './community-follow-button';
import styles from './community-ui.module.css';

function roleLabel(role: CommunityProfileRole) {
  return role === 'artist' ? 'Artista' : 'Fan';
}

function ProfileCard({
  profile,
  onFollowingChange,
}: {
  profile: CommunityProfileSummary;
  onFollowingChange: (profileId: string, following: boolean) => void;
}) {
  return (
    <article className={styles.profileCard}>
      <span className={styles.avatar} aria-hidden="true">
        {profile.name.trim().charAt(0).toLocaleUpperCase('it-IT') || 'S'}
      </span>
      <div className={styles.profileCopy}>
        <Link className={styles.profileLink} href={`/profiles/${encodeURIComponent(profile.id)}`}>
          {profile.name}
        </Link>
        <div className={styles.profileMeta}>
          <span className={styles.role}>{roleLabel(profile.role)}</span>
          {profile.followerCount === null ? null : <span>{profile.followerCount} follower</span>}
        </div>
      </div>
      <CommunityFollowButton
        profileId={profile.id}
        name={profile.name}
        initialFollowing={profile.isFollowing}
        returnTo="/community"
        onFollowingChange={(following) => onFollowingChange(profile.id, following)}
      />
    </article>
  );
}

export function CommunityBrowser() {
  const { data: session } = useSession();
  const [role, setRole] = useState<CommunityProfileRole>('fan');
  const [profiles, setProfiles] = useState<CommunityProfileSummary[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);

  const loadPage = useCallback(
    async (offset: number, append: boolean) => {
      setError(false);
      if (append) setLoadingMore(true);
      else setLoading(true);

      try {
        const result = await apiFetch(
          '/api/community/profiles?role=' + role + '&offset=' + offset,
          { schema: CommunityDirectoryResponseSchema },
        );
        setProfiles((current) => (append ? [...current, ...result.profiles] : result.profiles));
        setNextOffset(result.nextOffset);
      } catch {
        setError(true);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [role],
  );

  useEffect(() => {
    setProfiles([]);
    setNextOffset(null);
    void loadPage(0, false);
  }, [loadPage]);

  function updateFollow(profileId: string, following: boolean) {
    setProfiles((current) =>
      current.map((profile) =>
        profile.id === profileId ? { ...profile, isFollowing: following } : profile,
      ),
    );
  }

  return (
    <main className={styles.page}>
      <header className={styles.intro}>
        <p className={styles.eyebrow}>SOLCO · COMMUNITY</p>
        <h1 className={styles.title}>Fan e artisti, da seguire.</h1>
        <p className={styles.description}>
          Scopri i profili pubblici di fan e artisti. Segui chi vuoi ritrovare e consulta le liste
          che ogni profilo ha scelto di condividere.
        </p>
      </header>

      <div className={styles.toolbar}>
        <fieldset className={styles.tabs}>
          <legend className="sr-only">Filtra i profili per ruolo</legend>
          {(['fan', 'artist'] as const).map((item) => (
            <button
              key={item}
              type="button"
              className={[styles.tab, role === item ? styles.tabActive : '']
                .filter(Boolean)
                .join(' ')}
              aria-pressed={role === item}
              onClick={() => setRole(item)}
            >
              {item === 'fan' ? 'Fan' : 'Artisti'}
            </button>
          ))}
        </fieldset>
        {session?.user ? (
          <Link className={styles.settingsLink} href="/profile">
            Gestisci il tuo profilo
          </Link>
        ) : (
          <Link className={styles.settingsLink} href="/login?callbackURL=%2Fprofile">
            Accedi per creare il tuo profilo
          </Link>
        )}
      </div>

      {error ? (
        <section className={styles.statePanel} aria-live="polite">
          <h2>Profili non disponibili</h2>
          <p>La community non ha risposto. Riprova tra poco.</p>
          <Button type="button" variant="outline" onClick={() => void loadPage(0, false)}>
            Riprova
          </Button>
        </section>
      ) : loading ? (
        <output className={styles.muted}>Caricamento profili…</output>
      ) : profiles.length === 0 ? (
        <section className={styles.statePanel}>
          <h2>Ancora nessun profilo {role === 'artist' ? 'artista' : 'fan'} pubblico</h2>
          <p>
            Quando qualcuno sceglierà di rendere visibile il proprio profilo, lo troverai qui. Puoi
            configurare il tuo dalla pagina Profilo.
          </p>
          <Button asChild>
            <Link href={session?.user ? '/profile' : '/signup'}>
              {session?.user ? 'Apri il tuo profilo' : 'Crea un account'}
            </Link>
          </Button>
        </section>
      ) : (
        <>
          <div className={styles.grid}>
            {profiles.map((profile) => (
              <ProfileCard key={profile.id} profile={profile} onFollowingChange={updateFollow} />
            ))}
          </div>
          {nextOffset !== null ? (
            <div className="mt-6 flex justify-center">
              <Button
                type="button"
                variant="outline"
                disabled={loadingMore}
                onClick={() => void loadPage(nextOffset, true)}
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
