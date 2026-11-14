// @polsia:user-owned — quiz musicale condiviso (/quiz?c=…&au=…), pubblico: chi riceve il link non
// ha per forza un account. La pagina è solo il guscio: legge i parametri (songQuizFromParams,
// nessun dato letto qui) e passa il quiz alla carta (song-quiz-card). Titolo, descrizione e scheda
// di anteprima non contengono mai l'artista (è la risposta); la pagina non viene indicizzata.
import type { Metadata } from 'next';
import { SongQuizCard } from '@/components/custom/music/song-quiz-card';
import styles from '@/components/custom/music/song-quiz-card.module.css';
import {
  QUIZ_DESCRIPTION,
  QUIZ_GENERIC_TITLE,
  quizPagePath,
  quizPageTitle,
  quizPreviewImagePath,
  songQuizFromParams,
} from '@/lib/business/song-quiz';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * `title` va nel <title> (il layout aggiunge « · Solco»), `socialTitle` nelle anteprime social, che
 * non hanno il suffisso: per il quiz generico «Quiz musicale su Solco» senza ripetere «Solco».
 * `url` (og:url) è il percorso canonico del quiz (metadataBase lo rende assoluto), lo stesso
 * dell'anteprima in modalità attacco (uam-preview.ts).
 */
function quizMetadata(title: string, image: string, url: string, socialTitle = title): Metadata {
  const ogImage = { url: image, type: 'image/jpeg', width: 1200, height: 630, alt: socialTitle };
  return {
    title,
    description: QUIZ_DESCRIPTION,
    // Un quiz condiviso resta fuori dai motori di ricerca; i link della pagina si possono seguire.
    robots: { index: false, follow: true },
    openGraph: {
      title: socialTitle,
      description: QUIZ_DESCRIPTION,
      type: 'website',
      url,
      images: [ogImage],
    },
    twitter: {
      card: 'summary_large_image',
      title: socialTitle,
      description: QUIZ_DESCRIPTION,
      images: [image],
    },
  };
}

/**
 * Titolo e scheda per l'anteprima del link su WhatsApp, Telegram, X, Facebook: la domanda, mai la
 * risposta. L'immagine è l'indirizzo canonico della scheda (quiz/anteprima.jpg), lo stesso che
 * allega il menu «Sfida un amico». Link senza un quiz valido: i metadati generici del quiz.
 */
export async function generateMetadata({
  searchParams,
}: {
  searchParams: SearchParams;
}): Promise<Metadata> {
  const quiz = songQuizFromParams(await searchParams);
  if (!quiz) {
    return quizMetadata(
      'Quiz musicale',
      quizPreviewImagePath(null),
      quizPagePath(null),
      QUIZ_GENERIC_TITLE,
    );
  }
  return quizMetadata(quizPageTitle(quiz.title), quizPreviewImagePath(quiz), quizPagePath(quiz));
}

export default async function QuizPage({ searchParams }: { searchParams: SearchParams }) {
  const quiz = songQuizFromParams(await searchParams);
  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>{quiz ? 'UN AMICO TI SFIDA' : 'QUIZ MUSICALE'}</p>
        <h1 className={styles.pageTitle}>Quiz musicale</h1>
        <p className={styles.lead}>
          {quiz
            ? 'Leggi la domanda, prova a indovinare e poi gira la carta.'
            : 'Indovina chi interpreta i brani e sfida i tuoi amici su Solco.'}
        </p>
      </header>
      <SongQuizCard quiz={quiz} />
    </main>
  );
}
