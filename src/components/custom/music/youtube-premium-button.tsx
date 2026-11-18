// @polsia:user-owned — tasto «Apri in YouTube» per chi possiede YouTube Premium (interruttore in
// Impostazioni → «Ho YouTube Premium»). Compare SOLO quando la preferenza è accesa e il brano ha un
// video YouTube valido: apre il video esatto nell'app/sito di YouTube, dove l'abbonamento dell'utente
// vale davvero (niente pubblicità, ascolto in background). Solco non può usare il Premium dentro il
// proprio player incorporato: è un limite di YouTube. Nessuna API, nessun login: solo un link.
'use client';

import { Youtube } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { youtubeWatchUrl } from '@/lib/business/shared-song';
import { useYouTubePremium } from '@/lib/music/youtube-premium';
import { cn } from '@/lib/utils';

export function YouTubePremiumButton({
  videoId,
  className,
}: {
  videoId?: string | null;
  className?: string;
}) {
  const premium = useYouTubePremium();
  const href = youtubeWatchUrl(videoId);
  if (!premium || !href) return null;
  return (
    <Button
      asChild
      type="button"
      variant="outline"
      size="sm"
      className={cn('gap-1.5', className)}
      title="Col tuo Premium: senza pubblicità e in background"
    >
      <a href={href} target="_blank" rel="noopener noreferrer">
        <Youtube aria-hidden="true" className="size-4" />
        Apri in YouTube
        <span className="sr-only">
          {' '}
          (col tuo Premium: senza pubblicità e in background; si apre in una nuova scheda)
        </span>
      </a>
    </Button>
  );
}
