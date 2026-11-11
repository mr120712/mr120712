// @polsia:user-owned — scheda Radio: stazioni dal vivo per genere, paese o nome.
'use client';

import { type FormEvent, useEffect, useState } from 'react';
import { useLibrary } from '@/components/custom/music/library-context';
import { savedStationToStation } from '@/components/custom/music/live-tracks';
import { StationTile } from '@/components/custom/music/radio-station-tile';
import { apiFetch } from '@/lib/api-client';
import { type RadioListResponse, RadioListResponseSchema } from '@/lib/contracts/library';
import styles from './discover.module.css';

export const radioGenres = [
  { tag: 'pop', label: 'Pop' },
  { tag: 'rock', label: 'Rock' },
  { tag: 'dance', label: 'Dance' },
  { tag: 'jazz', label: 'Jazz' },
  { tag: 'classical', label: 'Classica' },
  { tag: 'hiphop', label: 'Hip-Hop' },
  { tag: 'electronic', label: 'Elettronica' },
  { tag: 'lounge', label: 'Lounge' },
  { tag: 'news', label: 'Notizie' },
  { tag: 'talk', label: 'Talk' },
] as const;

const countries = [
  { code: 'IT', label: 'Italia' },
  { code: '', label: 'Tutto il mondo' },
  { code: 'US', label: 'Stati Uniti' },
  { code: 'GB', label: 'Regno Unito' },
  { code: 'FR', label: 'Francia' },
  { code: 'DE', label: 'Germania' },
  { code: 'ES', label: 'Spagna' },
  { code: 'BR', label: 'Brasile' },
  { code: 'JP', label: 'Giappone' },
] as const;

type Filters = { q: string; tag: string; country: string };

export function RadioDirectory({ initialQuery = '' }: { initialQuery?: string }) {
  const library = useLibrary();
  const [filters, setFilters] = useState<Filters>({ q: initialQuery, tag: '', country: 'IT' });
  const [draft, setDraft] = useState(initialQuery);
  const [response, setResponse] = useState<RadioListResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setResponse(null);
    setFailed(false);
    const params = new URLSearchParams({ limit: '48' });
    if (filters.q) params.set('q', filters.q);
    if (filters.tag) params.set('tag', filters.tag);
    if (filters.country) params.set('country', filters.country);
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
  }, [filters]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFilters((current) => ({ ...current, q: draft.trim() }));
  };

  const stations = (response?.stations ?? []).filter(
    (station) => !library.isHidden('station', station.id),
  );
  const saved = library.library.stations.map(savedStationToStation);

  return (
    <div className={styles.page}>
      <header>
        <h1 className={styles.pageTitle}>Radio</h1>
        <p className={styles.lead}>Migliaia di stazioni in diretta da tutto il mondo.</p>
      </header>

      {saved.length > 0 ? (
        <section className={styles.section} aria-labelledby="saved-radio-heading">
          <header className={styles.sectionHeader}>
            <h2 id="saved-radio-heading">Le tue radio</h2>
          </header>
          <div className={styles.rail}>
            {saved.map((station) => (
              <StationTile key={station.id} station={station} queue={saved} allowHide={false} />
            ))}
          </div>
        </section>
      ) : null}

      <form className={styles.searchRow} onSubmit={submit}>
        <label className="sr-only" htmlFor="radio-query">
          Cerca una stazione radio
        </label>
        <input
          id="radio-query"
          type="search"
          value={draft}
          maxLength={80}
          placeholder="Cerca una stazione"
          onChange={(event) => setDraft(event.target.value)}
        />
        <label className="sr-only" htmlFor="radio-country">
          Paese
        </label>
        <select
          id="radio-country"
          value={filters.country}
          onChange={(event) =>
            setFilters((current) => ({ ...current, country: event.target.value }))
          }
        >
          {countries.map((country) => (
            <option key={country.code || 'all'} value={country.code}>
              {country.label}
            </option>
          ))}
        </select>
      </form>

      <fieldset className={styles.chips}>
        <legend className="sr-only">Generi radio</legend>
        <button
          type="button"
          aria-pressed={filters.tag === ''}
          onClick={() => setFilters((current) => ({ ...current, tag: '' }))}
        >
          Popolari
        </button>
        {radioGenres.map((genre) => (
          <button
            key={genre.tag}
            type="button"
            aria-pressed={filters.tag === genre.tag}
            onClick={() => setFilters((current) => ({ ...current, tag: genre.tag }))}
          >
            {genre.label}
          </button>
        ))}
      </fieldset>

      <section className={styles.section} aria-labelledby="radio-results-heading">
        <h2 id="radio-results-heading" className="sr-only">
          Stazioni
        </h2>
        {failed || response?.outcome === 'unavailable' ? (
          <p className={styles.state}>
            Le radio non sono raggiungibili in questo momento. Riprova.
          </p>
        ) : !response ? (
          <p className={styles.state}>Caricamento delle stazioni…</p>
        ) : stations.length === 0 ? (
          <p className={styles.state}>Nessuna stazione trovata con questi filtri.</p>
        ) : (
          <div className={styles.grid}>
            {stations.map((station) => (
              <StationTile key={station.id} station={station} queue={stations} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
