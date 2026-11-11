// @polsia:user-owned — Home: classifica dei video musicali più popolari su YouTube per paese.
'use client';

import { useEffect, useState } from 'react';
import { YouTubeVideoList } from '@/components/custom/music/youtube-video-list';
import { apiFetch } from '@/lib/api-client';
import { type YouTubeChartResponse, YouTubeChartResponseSchema } from '@/lib/contracts/music';
import styles from './discover.module.css';

const regions = [
  { code: 'IT', label: 'Italia' },
  { code: 'US', label: 'USA' },
  { code: 'GB', label: 'UK' },
  { code: 'FR', label: 'Francia' },
  { code: 'ES', label: 'Spagna' },
  { code: 'DE', label: 'Germania' },
  { code: 'BR', label: 'Brasile' },
  { code: 'KR', label: 'Corea' },
  { code: 'NG', label: 'Nigeria' },
] as const;

export function YouTubeCharts() {
  const [region, setRegion] = useState('IT');
  const [response, setResponse] = useState<YouTubeChartResponse | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setResponse(null);
    apiFetch(`/api/music/youtube/charts?region=${region}`, { schema: YouTubeChartResponseSchema })
      .then((value) => !cancelled && setResponse(value))
      .catch(
        () => !cancelled && setResponse({ outcome: 'unavailable', regionCode: region, videos: [] }),
      );
    return () => {
      cancelled = true;
    };
  }, [region]);

  const videos = response?.videos ?? [];
  const shown = expanded ? videos : videos.slice(0, 10);

  return (
    <section className={styles.section} id="tendenze" aria-labelledby="charts-heading">
      <header className={styles.sectionHeader}>
        <div>
          <p className={styles.eyebrow}>CLASSIFICHE · YOUTUBE</p>
          <h2 id="charts-heading">Top in classifica</h2>
        </div>
      </header>
      <fieldset className={styles.chips}>
        <legend className="sr-only">Paese della classifica</legend>
        {regions.map((item) => (
          <button
            key={item.code}
            type="button"
            aria-pressed={region === item.code}
            onClick={() => {
              setRegion(item.code);
              setExpanded(false);
            }}
          >
            {item.label}
          </button>
        ))}
      </fieldset>
      {!response ? (
        <p className={styles.state}>Caricamento della classifica…</p>
      ) : videos.length === 0 ? (
        <p className={styles.state}>La classifica non è disponibile in questo momento.</p>
      ) : (
        <>
          <YouTubeVideoList videos={shown} ranked />
          {videos.length > 10 ? (
            <div className={styles.chips}>
              <button type="button" onClick={() => setExpanded((value) => !value)}>
                {expanded ? 'Mostra meno' : `Mostra tutti i ${videos.length}`}
              </button>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
