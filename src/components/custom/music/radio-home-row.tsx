// @polsia:user-owned — riga "Radio consigliate" della Home.
'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useLibrary } from '@/components/custom/music/library-context';
import { StationTile } from '@/components/custom/music/radio-station-tile';
import { apiFetch } from '@/lib/api-client';
import { type RadioListResponse, RadioListResponseSchema } from '@/lib/contracts/library';
import styles from './discover.module.css';

export function RadioHomeRow() {
  const library = useLibrary();
  const [response, setResponse] = useState<RadioListResponse | null>(null);
  const [failed, setFailed] = useState(false);

  // Suggest stations matching the tags of radios the listener already saved.
  const favouriteTag = useMemo(() => {
    const counts = new Map<string, number>();
    for (const station of library.library.stations) {
      for (const tag of (station.tags ?? '').split(',').filter(Boolean)) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  }, [library.library.stations]);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ limit: '16' });
    if (favouriteTag) params.set('tag', favouriteTag);
    else params.set('country', 'IT');
    apiFetch(`/api/music/radio?${params.toString()}`, { schema: RadioListResponseSchema })
      .then((value) => {
        if (!cancelled) setResponse(value);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [favouriteTag]);

  const stations = (response?.stations ?? []).filter(
    (station) => !library.isHidden('station', station.id),
  );

  return (
    <section className={styles.section} id="radio" aria-labelledby="home-radio-heading">
      <header className={styles.sectionHeader}>
        <div>
          <p className={styles.eyebrow}>RADIO DAL VIVO</p>
          <h2 id="home-radio-heading">
            {favouriteTag ? `Radio ${favouriteTag} per te` : 'Radio consigliate'}
          </h2>
        </div>
        <Link href="/radio">Tutte le radio</Link>
      </header>
      {failed || response?.outcome === 'unavailable' ? (
        <p className={styles.state}>Le radio non sono raggiungibili in questo momento.</p>
      ) : !response ? (
        <p className={styles.state}>Caricamento delle radio…</p>
      ) : stations.length === 0 ? (
        <p className={styles.state}>Nessuna radio da consigliare per ora.</p>
      ) : (
        <div className={styles.rail}>
          {stations.map((station) => (
            <StationTile key={station.id} station={station} queue={stations} />
          ))}
        </div>
      )}
    </section>
  );
}
