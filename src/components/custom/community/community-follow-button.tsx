// @polsia:user-owned
'use client';

import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { useSession } from '@/lib/auth-client';
import { requestErrorMessage } from '@/lib/business/request-error-message';
import {
  CommunityFollowRequestSchema,
  CommunityFollowResponseSchema,
} from '@/lib/contracts/community';
import styles from './community-ui.module.css';

type Props = {
  profileId: string;
  name: string;
  initialFollowing: boolean;
  returnTo: string;
  onFollowingChange?: (following: boolean) => void;
};

export function CommunityFollowButton({
  profileId,
  name,
  initialFollowing,
  returnTo,
  onFollowingChange,
}: Props) {
  const { data, isPending } = useSession();
  const [following, setFollowing] = useState(initialFollowing);
  const [busy, setBusy] = useState(false);

  async function toggleFollowing() {
    setBusy(true);
    try {
      const result = following
        ? await apiFetch(`/api/community/follows/${encodeURIComponent(profileId)}`, {
            method: 'DELETE',
            schema: CommunityFollowResponseSchema,
          })
        : await apiFetch('/api/community/follows', {
            method: 'POST',
            body: JSON.stringify(CommunityFollowRequestSchema.parse({ profileId })),
            schema: CommunityFollowResponseSchema,
          });
      setFollowing(result.following);
      onFollowingChange?.(result.following);
      toast.success(result.following ? `Ora segui ${name}.` : `Hai smesso di seguire ${name}.`);
    } catch (error) {
      toast.error(
        requestErrorMessage(error, 'Non è stato possibile aggiornare i profili seguiti. Riprova.'),
      );
    } finally {
      setBusy(false);
    }
  }

  if (isPending) {
    return (
      <Button type="button" className={styles.followButton} variant="outline" disabled>
        Caricamento…
      </Button>
    );
  }

  if (!data?.user) {
    const callback = encodeURIComponent(returnTo);
    return (
      <Button asChild className={styles.followButton} variant="outline">
        <Link href={`/login?callbackURL=${callback}`}>Accedi per seguire</Link>
      </Button>
    );
  }

  return (
    <Button
      type="button"
      className={styles.followButton}
      variant={following ? 'outline' : 'default'}
      disabled={busy}
      aria-label={following ? `Smetti di seguire ${name}` : `Segui ${name}`}
      onClick={toggleFollowing}
    >
      {busy ? 'Aggiornamento…' : following ? 'Seguito' : 'Segui'}
    </Button>
  );
}
