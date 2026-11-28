// @polsia:user-owned — la guida completa per chi usa Solco per la prima volta (/guida). Markup
// statico: nessun dato dal server, nessun JavaScript necessario per leggerla.

import styles from './guide.module.css';
import { GuideAccount, GuideLockedScreen, GuidePlayer, GuideSearch } from './guide-basics';
import { GuideGlossary, GuideMoreHelp, GuideProblems } from './guide-help';
import { GuideLibrary, GuidePhoneApp, GuideRadioPodcast } from './guide-library';
import { GuideExtras, GuidePlans } from './guide-plans';
import { GuideBrief, GuideFirstSteps, GuideHeader, GuideToc } from './guide-start';

/** Data dell'ultima revisione dei contenuti (aggiornala quando cambi la guida). */
export const GUIDE_UPDATED_LABEL = '28 novembre 2026';

export function GuidePage() {
  return (
    <main className={styles.page}>
      <article className={styles.content}>
        <GuideHeader />
        <GuideBrief />
        <GuideToc />
        <GuideFirstSteps />
        <GuideAccount />
        <GuideSearch />
        <GuidePlayer />
        <GuideLockedScreen />
        <GuideLibrary />
        <GuideRadioPodcast />
        <GuidePhoneApp />
        <GuidePlans />
        <GuideExtras />
        <GuideProblems />
        <GuideGlossary />
        <GuideMoreHelp />
        <p className={styles.updated}>Guida aggiornata il {GUIDE_UPDATED_LABEL}.</p>
      </article>
    </main>
  );
}
