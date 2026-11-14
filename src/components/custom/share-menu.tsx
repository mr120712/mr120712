// @polsia:user-owned — menu "Condividi": WhatsApp, Telegram, X, Facebook, email, copia del link e,
// sul telefono, il menu di condivisione del sistema (Instagram, TikTok, Messaggi…). Solo link:
// nessuno script dei social nella pagina, nessun dato inviato da Solco.
'use client';

import { Copy, ExternalLink, Mail, Share2, Smartphone } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { socialShareLinks } from '@/lib/business/social-share';
import { cn } from '@/lib/utils';

export type ShareMenuProps = {
  /** Link completo da condividere (sito pubblico). */
  url: string;
  /** Testo che accompagna il link. */
  text: string;
  /** Titolo (oggetto dell'email, titolo nel menu del telefono). */
  title: string;
  /** Testo del pulsante. */
  label?: string;
  /** Nome accessibile del pulsante, se diverso dal testo (es. "Condividi la playlist X"). */
  ariaLabel?: string;
  variant?: 'default' | 'outline' | 'secondary' | 'ghost';
  size?: 'default' | 'sm';
  className?: string;
  /** Classi del menu aperto (es. uno z-index più alto dentro il player a schermo intero). */
  contentClassName?: string;
  /**
   * Immagine della condivisione (percorso same-origin, es. la scheda PNG del brano): allegata al
   * menu di condivisione del telefono quando il sistema accetta file (Instagram, WhatsApp…).
   */
  imageUrl?: string;
};

/** Scarica l'immagine come file da allegare, se il sistema lo consente; altrimenti null. */
async function shareableImage(imageUrl: string): Promise<File | null> {
  try {
    const url = new URL(imageUrl, window.location.origin);
    if (url.origin !== window.location.origin) return null;
    const response = await fetch(url, { credentials: 'same-origin' });
    const type = response.headers.get('content-type') ?? '';
    if (!response.ok || !type.startsWith('image/')) return null;
    const blob = await response.blob();
    const file = new File([blob], 'solco.png', { type: blob.type || 'image/png' });
    return typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })
      ? file
      : null;
  } catch {
    return null;
  }
}

export function ShareMenu({
  url,
  text,
  title,
  label = 'Condividi',
  ariaLabel,
  variant = 'outline',
  size = 'default',
  className,
  contentClassName,
  imageUrl,
}: ShareMenuProps) {
  // Il menu del sistema esiste solo in alcuni browser: lo si scopre dopo il montaggio, così il
  // markup del server e quello del client coincidono.
  const [canShareNatively, setCanShareNatively] = useState(false);
  useEffect(() => {
    setCanShareNatively(typeof navigator !== 'undefined' && typeof navigator.share === 'function');
  }, []);

  const links = socialShareLinks({ url, text, title });

  // L'immagine si prepara all'apertura del menu: al tocco su "Altre app" deve essere già pronta,
  // perché su iPhone navigator.share va chiamato subito, senza attese di rete in mezzo.
  const imageRef = useRef<{ url: string; file: File | null } | null>(null);
  const prepareImage = (open: boolean) => {
    if (!open || !canShareNatively || !imageUrl || imageRef.current?.url === imageUrl) return;
    const entry: { url: string; file: File | null } = { url: imageUrl, file: null };
    imageRef.current = entry;
    void shareableImage(imageUrl).then((file) => {
      entry.file = file;
    });
  };

  const shareNatively = async () => {
    const file = imageRef.current?.url === imageUrl ? imageRef.current?.file : null;
    try {
      await navigator.share(file ? { title, text, url, files: [file] } : { title, text, url });
    } catch (error) {
      // Chiuso dall'utente: niente. Rifiutato con l'immagine (alcune app): di nuovo senza.
      if (file && (error as { name?: unknown } | null)?.name !== 'AbortError') {
        await navigator.share({ title, text, url }).catch(() => undefined);
      }
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Link copiato.');
    } catch {
      toast.error('Non è stato possibile copiare il link.');
    }
  };

  return (
    <DropdownMenu onOpenChange={prepareImage}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant={variant}
          size={size}
          className={cn('gap-1.5', className)}
          aria-label={ariaLabel}
        >
          <Share2 aria-hidden="true" className="size-4" />
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className={cn('w-60', contentClassName)}>
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          Condividi con i tuoi amici
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {canShareNatively ? (
          <DropdownMenuItem onSelect={() => void shareNatively()}>
            <Smartphone aria-hidden="true" className="size-4" />
            <span className="flex-1">Altre app (Instagram, TikTok…)</span>
          </DropdownMenuItem>
        ) : null}
        {links.map((link) =>
          link.id === 'email' ? (
            <DropdownMenuItem key={link.id} asChild>
              <a href={link.href}>
                <Mail aria-hidden="true" className="size-4" />
                <span className="flex-1">{link.label}</span>
              </a>
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem key={link.id} asChild>
              <a href={link.href} target="_blank" rel="noopener noreferrer">
                <span className="flex-1">{link.label}</span>
                <ExternalLink aria-hidden="true" className="size-3.5 opacity-60" />
                <span className="sr-only"> (si apre in una nuova scheda)</span>
              </a>
            </DropdownMenuItem>
          ),
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void copyLink()}>
          <Copy aria-hidden="true" className="size-4" />
          <span className="flex-1">Copia link</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
