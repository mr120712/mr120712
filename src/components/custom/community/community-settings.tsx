// @polsia:user-owned
'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { requestErrorMessage } from '@/lib/business/request-error-message';
import {
  CommunitySelfResponseSchema,
  type CommunitySettings,
  CommunitySettingsSchema,
} from '@/lib/contracts/community';
import styles from './community-ui.module.css';

export function CommunitySettingsPanel() {
  const [settings, setSettings] = useState<CommunitySettings | null>(null);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await apiFetch('/api/community/me', {
        schema: CommunitySelfResponseSchema,
      });
      setSettings(CommunitySettingsSchema.parse(result.profile));
      setProfileId(result.profile.id);
    } catch {
      toast.error('Non è stato possibile caricare le impostazioni community.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function update<K extends keyof CommunitySettings>(key: K, value: CommunitySettings[K]) {
    setSettings((current) => (current ? { ...current, [key]: value } : current));
  }

  async function save() {
    if (!settings) return;
    setSaving(true);
    try {
      const result = await apiFetch('/api/community/me', {
        method: 'PATCH',
        body: JSON.stringify(CommunitySettingsSchema.parse(settings)),
        schema: CommunitySelfResponseSchema,
      });
      setSettings(CommunitySettingsSchema.parse(result.profile));
      setProfileId(result.profile.id);
      toast.success('Impostazioni community salvate.');
    } catch (error) {
      toast.error(
        requestErrorMessage(error, 'Non è stato possibile salvare le impostazioni. Riprova.'),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="grid gap-4" aria-labelledby="community-settings-title">
      <div>
        <p className={styles.eyebrow}>COMMUNITY</p>
        <h2 id="community-settings-title" className="font-display text-2xl">
          Il tuo profilo Solco
        </h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          Scegli come apparire e quali liste rendere visibili. Il tuo nome dell’account diventa
          pubblico solo quando rendi pubblico il profilo.
        </p>
      </div>

      {loading ? (
        <output className="text-sm text-muted-foreground">Caricamento impostazioni…</output>
      ) : settings ? (
        <div className={styles.settingsPanel}>
          <label className={styles.settingRow}>
            <span className={styles.settingLabel}>
              Ruolo del profilo
              <span className={styles.settingHint}>
                “Artista” descrive il profilo, non è una verifica d’identità.
              </span>
            </span>
            <select
              className={styles.select}
              value={settings.profileRole}
              onChange={(event) => {
                if (event.target.value === 'fan' || event.target.value === 'artist') {
                  update('profileRole', event.target.value);
                }
              }}
            >
              <option value="fan">Fan</option>
              <option value="artist">Artista</option>
            </select>
          </label>
          <label className={styles.settingRow}>
            <span className={styles.settingLabel}>
              Visibilità del profilo
              <span className={styles.settingHint}>
                I profili privati non compaiono nella community e non possono essere seguiti.
              </span>
            </span>
            <select
              className={styles.select}
              value={settings.profileVisibility}
              onChange={(event) => {
                if (event.target.value === 'public' || event.target.value === 'private') {
                  update('profileVisibility', event.target.value);
                }
              }}
            >
              <option value="private">Privato</option>
              <option value="public">Pubblico</option>
            </select>
          </label>
          <label className={styles.settingRow}>
            <span className={styles.settingLabel}>
              Chi può vedere i tuoi follower
              <span className={styles.settingHint}>
                Nascondere la lista nasconde anche il conteggio agli altri utenti.
              </span>
            </span>
            <select
              className={styles.select}
              value={settings.followersVisibility}
              onChange={(event) => {
                if (event.target.value === 'public' || event.target.value === 'private') {
                  update('followersVisibility', event.target.value);
                }
              }}
            >
              <option value="private">Solo io</option>
              <option value="public">Tutti</option>
            </select>
          </label>
          <label className={styles.settingRow}>
            <span className={styles.settingLabel}>
              Chi può vedere i profili che segui
              <span className={styles.settingHint}>
                La visibilità è indipendente da quella dei follower.
              </span>
            </span>
            <select
              className={styles.select}
              value={settings.followingVisibility}
              onChange={(event) => {
                if (event.target.value === 'public' || event.target.value === 'private') {
                  update('followingVisibility', event.target.value);
                }
              }}
            >
              <option value="private">Solo io</option>
              <option value="public">Tutti</option>
            </select>
          </label>
          <div className={styles.settingsActions}>
            <Button type="button" onClick={save} disabled={saving}>
              {saving ? 'Salvataggio…' : 'Salva impostazioni'}
            </Button>
            {profileId ? (
              <Button asChild variant="outline">
                <Link href={`/profiles/${encodeURIComponent(profileId)}`}>Anteprima profilo</Link>
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <div className={styles.statePanel}>
          <p>Le impostazioni non sono disponibili.</p>
          <Button type="button" variant="outline" onClick={() => void load()}>
            Riprova
          </Button>
        </div>
      )}
    </section>
  );
}
