// @polsia:user-owned — stato condiviso della Libreria (radio salvate, podcast seguiti, cartelle,
// cronologia, elementi nascosti) per tutte le pagine. Senza sessione resta vuoto.
'use client';

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api-client';
import { useSession } from '@/lib/auth-client';
import {
  type HiddenItem,
  type LibraryMutation,
  LibraryMutationResponseSchema,
  type LibraryResponse,
  LibraryResponseSchema,
} from '@/lib/contracts/library';

const emptyLibrary: LibraryResponse = {
  stations: [],
  podcasts: [],
  folders: [],
  history: [],
  hidden: [],
};

type LibraryValue = {
  signedIn: boolean;
  loading: boolean;
  library: LibraryResponse;
  refresh: () => Promise<void>;
  mutate: (action: LibraryMutation, successMessage?: string) => Promise<boolean>;
  isHidden: (kind: HiddenItem['kind'], itemId: string) => boolean;
  isStationSaved: (stationId: string) => boolean;
  isPodcastFollowed: (podcastId: string) => boolean;
};

const fallback: LibraryValue = {
  signedIn: false,
  loading: false,
  library: emptyLibrary,
  refresh: async () => undefined,
  mutate: async () => false,
  isHidden: () => false,
  isStationSaved: () => false,
  isPodcastFollowed: () => false,
};

const LibraryContext = createContext<LibraryValue | null>(null);

function errorMessage(error: unknown) {
  const cause =
    error instanceof Error && typeof error.cause === 'object' && error.cause !== null
      ? (error.cause as { message?: unknown })
      : null;
  return typeof cause?.message === 'string'
    ? cause.message
    : 'La Libreria non è stata aggiornata. Riprova.';
}

export function LibraryProvider({ children }: { children: ReactNode }) {
  const { data: session } = useSession();
  const signedIn = Boolean(session?.user);
  const [library, setLibrary] = useState<LibraryResponse>(emptyLibrary);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!signedIn) {
      setLibrary(emptyLibrary);
      return;
    }
    setLoading(true);
    try {
      setLibrary(await apiFetch('/api/music/library', { schema: LibraryResponseSchema }));
    } catch {
      // Keep the previous state: the library is an enhancement, never a blocker.
    } finally {
      setLoading(false);
    }
  }, [signedIn]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Arrived through an invite link (/invito/<code>): link the new account to the inviter.
  useEffect(() => {
    if (!signedIn || !document.cookie.split('; ').some((part) => part.startsWith('solco_ref='))) {
      return;
    }
    fetch('/api/rewards', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'claim_referral' }),
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { result?: string } | null) => {
        if (body?.result === 'claimed') {
          toast.success('Invito registrato! Quando attivi Premium ricevi 30 giorni gratis in più.');
        }
      })
      .catch(() => undefined);
  }, [signedIn]);

  const mutate = useCallback(
    async (action: LibraryMutation, successMessage?: string) => {
      if (!signedIn) {
        toast('Accedi per salvare nella tua Libreria.');
        return false;
      }
      try {
        const response = await apiFetch('/api/music/library', {
          method: 'POST',
          body: JSON.stringify(action),
          schema: LibraryMutationResponseSchema,
        });
        if (response.library) setLibrary(response.library);
        if (successMessage) toast.success(successMessage);
        return true;
      } catch (error) {
        toast.error(errorMessage(error));
        return false;
      }
    },
    [signedIn],
  );

  const value = useMemo<LibraryValue>(
    () => ({
      signedIn,
      loading,
      library,
      refresh,
      mutate,
      isHidden: (kind, itemId) =>
        library.hidden.some((item) => item.kind === kind && item.itemId === itemId),
      isStationSaved: (stationId) =>
        library.stations.some((station) => station.stationId === stationId),
      isPodcastFollowed: (podcastId) =>
        library.podcasts.some((podcast) => podcast.podcastId === podcastId),
    }),
    [library, loading, mutate, refresh, signedIn],
  );

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

/** Stato della Libreria; fuori dal provider restituisce una Libreria vuota e non modificabile. */
export function useLibrary() {
  return useContext(LibraryContext) ?? fallback;
}
