// @polsia:user-owned
'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import styles from '@/components/custom/music/music.module.css';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { applySolcoProTheme } from '@/lib/business/solco-pro-theme';
import {
  type SolcoProOverview,
  type SolcoProTheme,
  solcoProOverviewSchema,
  solcoProThemeResponseSchema,
} from '@/lib/contracts/solco-pro';

type Props = { onAccessChange: (active: boolean) => void };
type AccessState = 'loading' | 'active' | 'locked' | 'unavailable';

const themeOptions: { value: SolcoProTheme; label: string; description: string }[] = [
  { value: 'default', label: 'Solco', description: 'Palette originale' },
  { value: 'blue-hour', label: 'Ora blu', description: 'Blu profondo e accenti chiari' },
  { value: 'amber', label: 'Ambra', description: 'Prugna scuro e luce ambrata' },
];

function apiErrorCode(error: unknown) {
  if (error instanceof Error && error.cause && typeof error.cause === 'object') {
    const cause = error.cause as Record<string, unknown>;
    return typeof cause.error === 'string' ? cause.error : null;
  }
  return null;
}

function StatValue({ label, value }: { label: string; value: string | number }) {
  return (
    <div className={styles.proStat}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function SolcoProBenefits({ onAccessChange }: Props) {
  const [access, setAccess] = useState<AccessState>('loading');
  const [overview, setOverview] = useState<SolcoProOverview | null>(null);
  const [savingTheme, setSavingTheme] = useState(false);
  const [themeError, setThemeError] = useState('');

  const loadOverview = useCallback(async () => {
    setAccess('loading');
    try {
      const result = await apiFetch('/api/solco-pro/overview', { schema: solcoProOverviewSchema });
      setOverview(result);
      setAccess('active');
      onAccessChange(true);
    } catch (error) {
      const code = apiErrorCode(error);
      setOverview(null);
      setAccess(code === 'pro_required' ? 'locked' : 'unavailable');
      onAccessChange(false);
    }
  }, [onAccessChange]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    applySolcoProTheme(overview?.theme ?? 'default');
    return () => applySolcoProTheme('default');
  }, [overview?.theme]);

  async function saveTheme(theme: SolcoProTheme) {
    if (!overview || savingTheme) return;
    setSavingTheme(true);
    setThemeError('');
    try {
      const result = await apiFetch('/api/solco-pro/overview', {
        method: 'PATCH',
        body: JSON.stringify({ theme }),
        schema: solcoProThemeResponseSchema,
      });
      setOverview((current) => (current ? { ...current, theme: result.theme } : current));
      toast.success('Tema aggiornato.');
    } catch (error) {
      const code = apiErrorCode(error);
      const message =
        code === 'pro_required'
          ? 'Un accesso Pro attivo è necessario per applicare questo tema.'
          : 'Non è stato possibile aggiornare il tema. Riprova.';
      setThemeError(message);
      toast.error(message);
      if (code === 'pro_required') {
        setOverview(null);
        setAccess('locked');
        onAccessChange(false);
      }
    } finally {
      setSavingTheme(false);
    }
  }

  const statistics = overview?.statistics;
  const peak = Math.max(1, ...(statistics?.monthlyListens.map((item) => item.count) ?? []));

  return (
    <section className={styles.proPanel} aria-labelledby="pro-benefits-title">
      <div className={styles.proPanelHead}>
        <div>
          <p className={styles.eyebrow}>SOLCO PRO</p>
          <h2 id="pro-benefits-title">Il tuo diario, da vicino</h2>
        </div>
        <span className={styles.proPill}>Statistiche · temi · card</span>
      </div>

      {access === 'loading' ? (
        <output className={styles.proState}>Verifica dell’accesso…</output>
      ) : null}

      {access === 'locked' ? (
        <div className={styles.proState}>
          <p>
            Statistiche avanzate, temi extra e card senza logo sono riservati a un accesso Pro
            attivo e verificato.
          </p>
          <Link href="/#piani">Scopri i piani Solco</Link>
        </div>
      ) : null}

      {access === 'unavailable' ? (
        <div className={styles.proState}>
          <output className={styles.proState}>
            Non è stato possibile verificare l’accesso. Le funzioni Pro restano bloccate finché lo
            stato non è confermato.
          </output>
          <Button type="button" size="sm" variant="outline" onClick={() => void loadOverview()}>
            Riprova
          </Button>
        </div>
      ) : null}

      {access === 'active' && statistics ? (
        <>
          <div className={styles.proStats}>
            <StatValue label="Ascolti" value={statistics.totalListens} />
            <StatValue label="Album distinti" value={statistics.uniqueAlbums} />
            <StatValue label="Artisti" value={statistics.uniqueArtists} />
            <StatValue
              label="Voto medio"
              value={statistics.averageRating === null ? '—' : `${statistics.averageRating}/5`}
            />
            <StatValue label="Artista più ascoltato" value={statistics.topArtist ?? '—'} />
            <StatValue label="Contesto più usato" value={statistics.topContext ?? '—'} />
          </div>

          <fieldset className={styles.proMonthly}>
            <legend>Andamento degli ascolti</legend>
            <ul>
              {statistics.monthlyListens.map((month) => (
                <li key={month.month}>
                  <span>{month.month}</span>
                  <span className={styles.proBarTrack}>
                    <span
                      className={styles.proBar}
                      style={{ width: `${(month.count / peak) * 100}%` }}
                    />
                  </span>
                  <strong>{month.count}</strong>
                </li>
              ))}
            </ul>
          </fieldset>

          <fieldset className={styles.proThemePicker}>
            <legend>Personalizza il tema</legend>
            <div className={styles.proThemeOptions}>
              {themeOptions.map((option) => (
                <label key={option.value} className={styles.proThemeOption}>
                  <input
                    type="radio"
                    name="solco-pro-theme"
                    value={option.value}
                    checked={overview.theme === option.value}
                    disabled={savingTheme}
                    onChange={() => void saveTheme(option.value)}
                  />
                  <span>
                    <strong>{option.label}</strong>
                    <small>{option.description}</small>
                  </span>
                </label>
              ))}
            </div>
            {themeError ? (
              <p className={styles.proThemeError} role="alert">
                {themeError}
              </p>
            ) : null}
          </fieldset>
        </>
      ) : null}
    </section>
  );
}
