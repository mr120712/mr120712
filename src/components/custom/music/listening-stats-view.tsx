// @polsia:user-owned — "Statistiche di ascolto": riepilogo personale (ascolti, minuti, artisti e
// fonti top, ultimi brani) ricavato dallo storico di riproduzione. Richiede login.
'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { type ListeningStats, ListeningStatsResponseSchema } from '@/lib/contracts/listening-stats';
import styles from './listening-stats-view.module.css';

function formatMinutes(total: number): string {
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
}

function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'short' }).format(
      new Date(iso),
    );
  } catch {
    return '';
  }
}

export function ListeningStatsView() {
  const [stats, setStats] = useState<ListeningStats | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let alive = true;
    apiFetch('/api/music/stats', { schema: ListeningStatsResponseSchema })
      .then((data) => {
        if (!alive) return;
        setStats(data.stats);
        setState('ready');
      })
      .catch(() => {
        if (alive) setState('error');
      });
    return () => {
      alive = false;
    };
  }, []);

  if (state === 'loading') {
    return <p className={styles.state}>Carico le tue statistiche…</p>;
  }
  if (state === 'error' || !stats) {
    return <p className={styles.state}>Statistiche non disponibili in questo momento.</p>;
  }
  if (stats.totalListens === 0) {
    return (
      <p className={styles.state}>
        Ancora nessun ascolto registrato. Inizia ad ascoltare e qui vedrai i tuoi dati.
      </p>
    );
  }

  const maxArtist = stats.topArtists[0]?.plays ?? 1;
  const maxSource = stats.bySource[0]?.plays ?? 1;

  return (
    <div className={styles.wrap}>
      <div className={styles.metrics}>
        <div className={styles.metric}>
          <span className={styles.metricValue}>{stats.totalListens}</span>
          <span className={styles.metricLabel}>ascolti</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricValue}>{formatMinutes(stats.estimatedMinutes)}</span>
          <span className={styles.metricLabel}>tempo di ascolto (stima)</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricValue}>{stats.uniqueTracks}</span>
          <span className={styles.metricLabel}>brani diversi</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricValue}>{stats.uniqueArtists}</span>
          <span className={styles.metricLabel}>artisti diversi</span>
        </div>
      </div>

      {stats.topArtists.length ? (
        <section className={styles.section} aria-labelledby="stats-artists">
          <h2 id="stats-artists" className={styles.sectionTitle}>
            Artisti più ascoltati
          </h2>
          <ol className={styles.bars}>
            {stats.topArtists.map((artist) => (
              <li key={artist.name} className={styles.barRow}>
                <span className={styles.barName} title={artist.name}>
                  {artist.name}
                </span>
                <span className={styles.barTrack}>
                  <span
                    className={styles.barFill}
                    style={{ width: `${Math.round((artist.plays / maxArtist) * 100)}%` }}
                  />
                </span>
                <span className={styles.barCount}>{artist.plays}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {stats.bySource.length ? (
        <section className={styles.section} aria-labelledby="stats-sources">
          <h2 id="stats-sources" className={styles.sectionTitle}>
            Ascolti per fonte
          </h2>
          <ol className={styles.bars}>
            {stats.bySource.map((source) => (
              <li key={source.label} className={styles.barRow}>
                <span className={styles.barName} title={source.label}>
                  {source.label}
                </span>
                <span className={styles.barTrack}>
                  <span
                    className={styles.barFill}
                    style={{ width: `${Math.round((source.plays / maxSource) * 100)}%` }}
                  />
                </span>
                <span className={styles.barCount}>{source.plays}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {stats.recent.length ? (
        <section className={styles.section} aria-labelledby="stats-recent">
          <h2 id="stats-recent" className={styles.sectionTitle}>
            Ascoltati di recente
          </h2>
          <ul className={styles.recent}>
            {stats.recent.map((item, index) => (
              <li key={`${item.title}-${index}`} className={styles.recentRow}>
                <span className={styles.recentCopy}>
                  <strong className={styles.recentTitle} title={item.title}>
                    {item.title}
                  </strong>
                  <span className={styles.recentArtist}>{item.artistName}</span>
                </span>
                <span className={styles.recentDate}>{formatDate(item.lastPlayedAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
