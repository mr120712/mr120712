// @polsia:user-owned — la carta del quiz musicale condiviso (/quiz): sul fronte la domanda, sul
// retro l'artista (la risposta), «Ascolta su Solco», «Sfida un amico» e «Crea la tua sfida».
// Si gira con <details>/<summary>: funziona anche senza JavaScript, da tastiera e con i lettori
// di schermo (pulsante espanso/compresso). Animazione di rotazione solo se il movimento è
// consentito; con prefers-reduced-motion la risposta compare e basta.
// «Sfida un amico» è un menu che vive di JavaScript: compare dopo il montaggio; senza JavaScript
// al suo posto ci sono i link diretti ai social (<noscript>), mai un pulsante che non fa nulla.
'use client';

import { Headphones, Layers, RotateCw } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ShareMenu } from '@/components/custom/share-menu';
import { Button } from '@/components/ui/button';
import { socialShareLinks, songShareUrl } from '@/lib/business/social-share';
import {
  QUIZ_CREATE_PATH,
  QUIZ_SHARE_TITLE,
  type SongQuiz,
  songQuizShare,
} from '@/lib/business/song-quiz';
import styles from './song-quiz-card.module.css';

/** Percorso con la query di un link pubblico, per aprirlo su questo stesso sito. */
function sitePath(absoluteUrl: string): string {
  const url = new URL(absoluteUrl);
  return `${url.pathname}${url.search}`;
}

export function SongQuizCard({ quiz }: { quiz: SongQuiz | null }) {
  // Il menu di condivisione solo con JavaScript attivo (vedi sopra).
  const [interactive, setInteractive] = useState(false);
  useEffect(() => {
    setInteractive(true);
  }, []);

  if (!quiz) {
    return (
      <section className={styles.invalid} aria-labelledby="quiz-non-valido">
        <h2 id="quiz-non-valido" className={styles.invalidTitle}>
          Questo quiz non si apre
        </h2>
        <p className={styles.invalidText}>
          Il link è incompleto o non è valido. Chiedi a chi te l’ha mandato di condividerlo di
          nuovo, oppure mettiti alla prova con le flashcard di Solco.
        </p>
        <div className={styles.actions}>
          <Button asChild>
            <Link href="/flashcards">
              <Layers aria-hidden="true" /> Gioca con le flashcard
            </Link>
          </Button>
        </div>
      </section>
    );
  }

  // «Ascolta su Solco»: la ricerca del brano (chi non ha un account passa dall'accesso e ritrova
  // la stessa ricerca). Sta sul retro, quindi può contenere l'artista.
  const listenHref = sitePath(songShareUrl(quiz.title, quiz.artist, undefined, quiz.audiusId));
  // «Sfida un amico»: lo stesso quiz, sempre sul sito pubblico, con la stessa scheda di anteprima.
  const challenge = songQuizShare(quiz);

  return (
    <details className={styles.card}>
      <summary className={styles.front}>
        <span className={styles.frontTopic}>Quiz musicale · Solco</span>
        <span className={styles.question}>
          Chi interpreta <span className={styles.songTitle}>«{quiz.title}»</span>?
        </span>
        <span className={styles.flip}>
          <RotateCw aria-hidden="true" />
          <span className={styles.whenClosed}>Gira la carta</span>
          <span className={styles.whenOpen}>Torna alla domanda</span>
        </span>
      </summary>
      <div className={styles.back}>
        <p className={styles.backTopic}>La risposta</p>
        <p className={styles.answer}>{quiz.artist}</p>
        <p className={styles.songLine}>
          È l’interprete di <span className={styles.songTitle}>«{quiz.title}»</span>.
        </p>
        <div className={styles.actions}>
          <Button asChild>
            <Link href={listenHref}>
              <Headphones aria-hidden="true" /> Ascolta su Solco
            </Link>
          </Button>
          {challenge && interactive ? (
            <ShareMenu
              label="Sfida un amico"
              ariaLabel="Sfida un amico con questo quiz"
              title={QUIZ_SHARE_TITLE}
              text={challenge.text}
              url={challenge.url}
              imageUrl={challenge.imageUrl}
            />
          ) : null}
          <Button asChild variant="outline">
            <Link href={QUIZ_CREATE_PATH}>
              <Layers aria-hidden="true" /> Crea la tua sfida
            </Link>
          </Button>
        </div>
        {challenge && !interactive ? (
          <noscript>
            <p className={styles.shareFallback}>
              Sfida un amico:{' '}
              {socialShareLinks({
                url: challenge.url,
                text: challenge.text,
                title: QUIZ_SHARE_TITLE,
              }).map((link, index) => (
                <span key={link.id}>
                  {index > 0 ? ' · ' : null}
                  {link.id === 'email' ? (
                    <a href={link.href}>{link.label}</a>
                  ) : (
                    <a href={link.href} target="_blank" rel="noopener noreferrer">
                      {link.label}
                    </a>
                  )}
                </span>
              ))}
            </p>
          </noscript>
        ) : null}
      </div>
    </details>
  );
}
