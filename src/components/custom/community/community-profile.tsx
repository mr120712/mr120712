// @polsia:user-owned
'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { useSession } from '@/lib/auth-client';
import {
  CommunityProfileResponseSchema,
  type CommunityProfileRole,
  type CommunityProfileSummary,
} from '@/lib/contracts/community';
import { CommunityFollowButton } from './community-follow-button';
import styles from './community-ui.module.css';

type PublicProfile = CommunityProfileSummary & { isSelf: boolean };

function roleLabel(role: CommunityProfileRole) {
  return role === 'artist' ? 'Artista' : 'Fan';
}

export function CommunityProfile({ profileId }: { profileId: string }) {
  const { data: session, isPending } = useSession();
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);

  const loadProfile = useCallback(async () => {
    setLoading(true);
    setUnavailable(false);
    try {
      const result = await apiFetch(`/api/community/profiles/${encodeURIComponent(profileId)}`, {
        schema: CommunityProfileResponseSchema,
      });
      setProfile(result.profile);
    } catch {
      setUnavailable(true);
    } finally {
      setLoading(false);
    }
  }, [profileId]);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  if (loading) {
    return (
      <main className={styles.page}>
        <output className={styles.muted}>Caricamento profilo…</output>
      </main>
    );
  }

  if (unavailable || !profile) {
    return (
      <main className={styles.page}>
        <section className={styles.statePanel}>
          <p className={styles.eyebrow}>PROFILO SOLCO</p>
          <h1>Questo profilo non è disponibile</h1>
          <p>Potrebbe essere privato o non esistere più.</p>
          <Button asChild variant="outline">
            <Link href="/community">Torna alla community</Link>
          </Button>
        </section>
      </main>
    );
  }

  function updateFollowing(following: boolean) {
    setProfile((current) =>
      current
        ? {
            ...current,
            isFollowing: following,
            followerCount:
              current.followerCount === null
                ? null
                : Math.max(0, current.followerCount + (following ? 1 : -1)),
          }
        : current,
    );
  }

  return (
    <main className={styles.page}>
      <header className={styles.profileHeader}>
        <div className={styles.identity}>
          <span className={styles.avatar} aria-hidden="true">
            {profile.name.trim().charAt(0).toLocaleUpperCase('it-IT') || 'S'}
          </span>
          <div className="min-w-0">
            <span className={styles.role}>{roleLabel(profile.role)}</span>
            <h1 className={styles.name}>{profile.name}</h1>
          </div>
        </div>

        <div className={styles.stats}>
          {profile.followersVisible ? (
            <Link
              className={styles.statLink}
              href={`/profiles/${encodeURIComponent(profile.id)}/followers`}
            >
              <strong>{profile.followerCount ?? 0}</strong>
              <span>Follower</span>
            </Link>
          ) : (
            <div className={styles.statPrivate}>
              <strong>—</strong>
              <span>Follower privati</span>
            </div>
          )}
          {profile.followingVisible ? (
            <Link
              className={styles.statLink}
              href={`/profiles/${encodeURIComponent(profile.id)}/following`}
            >
              <strong>{profile.followingCount ?? 0}</strong>
              <span>Profili seguiti</span>
            </Link>
          ) : (
            <div className={styles.statPrivate}>
              <strong>—</strong>
              <span>Seguiti privati</span>
            </div>
          )}
        </div>

        <div className={styles.profileActions}>
          <Button asChild variant="outline">
            <Link href="/community">Esplora profili</Link>
          </Button>
          {profile.isSelf ? (
            <Button asChild>
              <Link href="/profile">Impostazioni profilo</Link>
            </Button>
          ) : (
            <>
              <CommunityFollowButton
                profileId={profile.id}
                name={profile.name}
                initialFollowing={profile.isFollowing}
                returnTo={`/profiles/${encodeURIComponent(profile.id)}`}
                onFollowingChange={updateFollowing}
              />
              <Button asChild>
                <Link
                  href={
                    session?.user || isPending
                      ? `/messages/new?profile=${encodeURIComponent(profile.id)}`
                      : `/login?callbackURL=${encodeURIComponent(`/messages/new?profile=${profile.id}`)}`
                  }
                >
                  {isPending
                    ? 'Caricamento…'
                    : session?.user
                      ? 'Scrivi un messaggio'
                      : 'Accedi per messaggiare'}
                </Link>
              </Button>
            </>
          )}
        </div>
      </header>
    </main>
  );
}
