// @polsia:user-owned — «Installa l'app» della pagina /app (sezione iPhone e iPad): chiede al server
// se c'è un IPA installabile (GET /api/ios/install, solo con sessione) e mostra il link itms-services
// con il token dell'utente. Se non c'è, una riga rimanda al profilo (Web Clip) qui sotto. Il link
// funziona solo da Safari e solo sugli iPhone registrati nel profilo Ad Hoc dell'app.
'use client';

import { Download } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { type IosInstallStatus, IosInstallStatusSchema } from '@/lib/contracts/ios-install';
import { IOS_INSTALL_ENDPOINT } from '@/lib/ios-app';
import styles from './ios-app-install.module.css';

export const IOS_APP_UNAVAILABLE_TEXT =
  'L’app nativa per iPhone non è ancora disponibile da qui: intanto usa il profilo qui sotto, che apre Solco a schermo intero.';

const METHOD_LABEL: Record<NonNullable<IosInstallStatus['method']>, string> = {
  'ad-hoc': 'versione di prova per dispositivi registrati',
  development: 'versione di sviluppo per dispositivi registrati',
  enterprise: 'distribuzione interna',
  'app-store': 'versione App Store',
  unknown: 'firma non riconosciuta',
};

type State = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; status: IosInstallStatus };

export function IosAppInstall() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    apiFetch(IOS_INSTALL_ENDPOINT, { schema: IosInstallStatusSchema })
      .then((status) => {
        if (!cancelled) setState({ kind: 'ready', status });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === 'loading') {
    return <p className={styles.note}>Controllo se l’app per iPhone è disponibile…</p>;
  }
  const installUrl =
    state.kind === 'ready' && state.status.available ? state.status.installUrl : null;
  if (state.kind !== 'ready' || !installUrl) {
    return <p className={styles.note}>{IOS_APP_UNAVAILABLE_TEXT}</p>;
  }
  const { status } = state;
  return (
    <div className={styles.block}>
      <Button asChild size="lg">
        <a href={installUrl}>
          <Download aria-hidden="true" />
          Installa l’app{status.version ? ` ${status.version}` : ''}
        </a>
      </Button>
      <p className={styles.note}>
        {status.method ? `${METHOD_LABEL[status.method]}: ` : ''}funziona solo da Safari e solo
        sugli iPhone e iPad registrati per questa versione. Tocca «Installa» nella finestra di iOS:
        l’icona compare nella schermata Home. Il link vale 15 minuti; se scade, ricarica la pagina.
      </p>
    </div>
  );
}
