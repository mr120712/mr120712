// @polsia:user-owned — "Ascolta altrove": lo stesso brano su Spotify, YouTube Music, SoundCloud,
// Deezer e TIDAL. Sono semplici link alle pagine di ricerca dei servizi (nessuna API e nessun
// loro contenuto dentro Solco): chi ha un abbonamento continua lì, anche in background.
'use client';

import { ExternalLink, Share2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { listenElsewhereLinks } from '@/lib/business/shared-song';
import { cn } from '@/lib/utils';

export function ListenElsewhereMenu({
  title,
  artist,
  youtubeVideoId = null,
  className,
}: {
  title: string;
  artist: string | null;
  youtubeVideoId?: string | null;
  className?: string;
}) {
  const links = listenElsewhereLinks({ title, artist, youtubeVideoId });
  if (links.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" className={cn('gap-1.5', className)}>
          <Share2 aria-hidden="true" className="size-4" />
          Ascolta altrove
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          Si apre il servizio: l’ascolto lì dipende dal tuo account.
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {links.map((link) => (
          <DropdownMenuItem key={link.id} asChild>
            <a href={link.href} target="_blank" rel="noopener noreferrer">
              <span className="flex-1">{link.label}</span>
              <ExternalLink aria-hidden="true" className="size-3.5 opacity-60" />
              <span className="sr-only"> (si apre in una nuova scheda)</span>
            </a>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
