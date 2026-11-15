// @polsia:user-owned — «Il tuo profilo Solco» (pagina /profile): ruolo e visibilità di profilo e
// liste, ognuno su una riga con icona, etichetta, suggerimento e un controllo segmentato premium che
// cambia la scelta con un tocco. Il salvataggio resta esplicito sul pulsante «Salva impostazioni»
// (stesso PATCH di sempre su /api/community/me); un avviso discreto segnala le modifiche non salvate.
'use client';

import {
  ArrowUpRight,
  Eye,
  Globe,
  Headphones,
  Lock,
  Mic2,
  UserRound,
  UserRoundCheck,
  Users,
  UsersRound,
} from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useCallback, useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
import {
  SegmentedControl,
  type SegmentedOption,
} from '@/components/custom/ui-premium/segmented-control';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { requestErrorMessage } from '@/lib/business/request-error-message';
import {
  CommunitySelfResponseSchema,
  type CommunitySettings,
  CommunitySettingsSchema,
} from '@/lib/contracts/community';
import styles from './community-ui.module.css';

type ProfileRole = CommunitySettings['profileRole'];
type Visibility = CommunitySettings['profileVisibility'];

const ROLE_OPTIONS: readonly SegmentedOption<ProfileRole>[] = [
  { value: 'fan', label: 'Fan', icon: <Headphones /> },
  { value: 'artist', label: 'Artista', icon: <Mic2 /> },
];

const PROFILE_VISIBILITY_OPTIONS: readonly SegmentedOption<Visibility>[] = [
  { value: 'private', label: 'Privato', icon: <Lock /> },
  { value: 'public', label: 'Pubblico', icon: <Globe /> },
];

const LIST_VISIBILITY_OPTIONS: readonly SegmentedOption<Visibility>[] = [
  { value: 'private', label: 'Solo io', icon: <Lock /> },
  { value: 'public', label: 'Tutti', icon: <Users /> },
];

const SETTING_KEYS = [
  'profileRole',
  'profileVisibility',
  'followersVisibility',
  'followingVisibility',
] as const satisfies readonly (keyof CommunitySettings)[];

function sameSettings(a: CommunitySettings, b: CommunitySettings) {
  return SETTING_KEYS.every((key) => a[key] === b[key]);
}

/** Una impostazione: icona, etichetta, suggerimento e il controllo segmentato che li cita. */
function SettingRow<V extends string>({
  icon,
  title,
  hint,
  value,
  options,
  onValueChange,
}: {
  icon: ReactNode;
  title: string;
  hint: string;
  value: V;
  options: readonly SegmentedOption<V>[];
  onValueChange: (value: V) => void;
}) {
  const id = useId();
  const labelId = `${id}-label`;
  const hintId = `${id}-hint`;
  return (
    <div className={styles.settingRow}>
      <span className={styles.settingIcon} aria-hidden="true">
        {icon}
      </span>
      <div className={styles.settingText}>
        <span id={labelId} className={styles.settingLabel}>
          {title}
        </span>
        <span id={hintId} className={styles.settingHint}>
          {hint}
        </span>
      </div>
      <SegmentedControl
        className={styles.settingControl}
        aria-labelledby={labelId}
        aria-describedby={hintId}
        value={value}
        options={options}
        onValueChange={onValueChange}
      />
    </div>
  );
}

export function CommunitySettingsPanel() {
  const [settings, setSettings] = useState<CommunitySettings | null>(null);
  // Ultima versione caricata o salvata: serve solo all'avviso «Modifiche non salvate».
  const [savedSettings, setSavedSettings] = useState<CommunitySettings | null>(null);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await apiFetch('/api/community/me', {
        schema: CommunitySelfResponseSchema,
      });
      const loaded = CommunitySettingsSchema.parse(result.profile);
      setSettings(loaded);
      setSavedSettings(loaded);
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
      const stored = CommunitySettingsSchema.parse(result.profile);
      setSettings(stored);
      setSavedSettings(stored);
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

  const dirty =
    settings !== null && savedSettings !== null && !sameSettings(settings, savedSettings);

  return (
    <section className={styles.settingsCard} aria-labelledby="community-settings-title">
      <header className={styles.settingsHeader}>
        <p className={styles.eyebrow}>COMMUNITY</p>
        <h2 id="community-settings-title" className={styles.settingsTitle}>
          Il tuo profilo Solco
        </h2>
        <p className={styles.settingsIntro}>
          Scegli come apparire e quali liste rendere visibili. Il tuo nome dell’account diventa
          pubblico solo quando rendi pubblico il profilo.
        </p>
      </header>

      {loading ? (
        <output className={styles.settingsState}>Caricamento impostazioni…</output>
      ) : settings ? (
        <>
          <div className={styles.settingsList}>
            <SettingRow
              icon={<UserRound />}
              title="Ruolo del profilo"
              hint="“Artista” descrive il profilo, non è una verifica d’identità."
              value={settings.profileRole}
              options={ROLE_OPTIONS}
              onValueChange={(value) => update('profileRole', value)}
            />
            <SettingRow
              icon={<Eye />}
              title="Visibilità del profilo"
              hint="I profili privati non compaiono nella community e non possono essere seguiti."
              value={settings.profileVisibility}
              options={PROFILE_VISIBILITY_OPTIONS}
              onValueChange={(value) => update('profileVisibility', value)}
            />
            <SettingRow
              icon={<UsersRound />}
              title="Chi può vedere i tuoi follower"
              hint="Nascondere la lista nasconde anche il conteggio agli altri utenti."
              value={settings.followersVisibility}
              options={LIST_VISIBILITY_OPTIONS}
              onValueChange={(value) => update('followersVisibility', value)}
            />
            <SettingRow
              icon={<UserRoundCheck />}
              title="Chi può vedere i profili che segui"
              hint="La visibilità è indipendente da quella dei follower."
              value={settings.followingVisibility}
              options={LIST_VISIBILITY_OPTIONS}
              onValueChange={(value) => update('followingVisibility', value)}
            />
          </div>
          <div className={styles.settingsActions}>
            <div className={styles.settingsButtons}>
              <Button type="button" onClick={save} disabled={saving}>
                {saving ? 'Salvataggio…' : 'Salva impostazioni'}
              </Button>
              {profileId ? (
                <Button asChild variant="outline">
                  <Link href={`/profiles/${encodeURIComponent(profileId)}`}>
                    Anteprima profilo
                    <ArrowUpRight aria-hidden="true" />
                  </Link>
                </Button>
              ) : null}
            </div>
            {/* Sempre nel DOM: i lettori di schermo annunciano l'avviso quando compare. */}
            <output className={styles.unsaved}>
              {dirty ? (
                <>
                  <span className={styles.unsavedDot} aria-hidden="true" />
                  Modifiche non salvate
                </>
              ) : null}
            </output>
          </div>
        </>
      ) : (
        <div className={styles.settingsState}>
          <p>Le impostazioni non sono disponibili.</p>
          <Button type="button" variant="outline" onClick={() => void load()}>
            Riprova
          </Button>
        </div>
      )}
    </section>
  );
}
