// @polsia:user-owned — impostazioni normali per TUTTI gli utenti (anche ospiti): interruttori salvati
// per dispositivo (localStorage). Non serve login: sono preferenze locali del browser. Ogni scheda si
// aggiorna da sola tramite gli store (useSyncExternalStore).
'use client';

import { Infinity as InfinityIcon, Wifi } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { Switch } from '@/components/ui/switch';
import { setAutoplay, useAutoplay } from '@/lib/music/autoplay';
import { setDataSaver, useDataSaver } from '@/lib/music/data-saver';

function ToggleRow({
  icon,
  title,
  description,
  checked,
  onChange,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  const id = useId();
  const descId = `${id}-desc`;
  return (
    <div className="flex items-start justify-between gap-4 py-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-muted-foreground">{icon}</span>
        <div>
          <label htmlFor={id} className="block text-sm font-medium">
            {title}
          </label>
          <p id={descId} className="mt-0.5 text-sm text-muted-foreground">
            {description}
          </p>
        </div>
      </div>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        aria-describedby={descId}
        className="mt-1"
      />
    </div>
  );
}

export function SettingsPanel() {
  const autoplay = useAutoplay();
  const dataSaver = useDataSaver();

  return (
    <div className="divide-y divide-border rounded-xl border border-border bg-card px-5 text-card-foreground">
      <ToggleRow
        icon={<InfinityIcon aria-hidden="true" className="size-5" />}
        title="Autoplay continuo"
        description="A coda finita, continua da solo con brani consigliati: la musica non si ferma, anche a schermo bloccato."
        checked={autoplay}
        onChange={setAutoplay}
      />
      <ToggleRow
        icon={<Wifi aria-hidden="true" className="size-5" />}
        title="Risparmio dati"
        description="Non precarica il brano successivo: consumi meno rete, con una pausa minima al cambio brano."
        checked={dataSaver}
        onChange={setDataSaver}
      />
    </div>
  );
}
