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
   * Immagine della condivisione (percorso same-origin, es. la scheda JPEG del brano): allegata al
   * menu di condivisione del telefono quando il sistema accetta file (Instagram, WhatsApp…).
   */
  imageUrl?: string;
};

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** Scarica l'immagine (solo dal sito stesso) come file da allegare; altrimenti null. */
async function shareableImage(imageUrl: string): Promise<File | null> {
  try {
    const url = new URL(imageUrl, window.location.origin);
    if (url.origin !== window.location.origin) return null;
    const response = await fetch(url, { credentials: 'same-origin' });
    const type = response.headers.get('content-type') ?? '';
    if (!response.ok || !type.startsWith('image/')) return null;
    const blob = await response.blob();
    const fileType = blob.type || 'image/jpeg';
    // Nome coerente con il tipo: alcune app scelgono come aprire il file dall'estensione.
    const extension = IMAGE_EXTENSIONS[fileType] ?? 'jpg';
    return new File([blob], `solco.${extension}`, { type: fileType });
  } catch {
    return null;
  }
}

/**
 * Il contenuto da condividere: con l'immagine solo se il sistema accetta QUESTO contenuto intero
 * (titolo, testo, link e file insieme), altrimenti solo il link. Il controllo si fa prima di
 * chiamare navigator.share: la condivisione consuma il gesto dell'utente, quindi un secondo
 * tentativo senza immagine fallirebbe sempre.
 */
function sharePayload(data: ShareData, file: File | null): ShareData {
  if (!file || typeof navigator.canShare !== 'function') return data;
  const withFile: ShareData = { ...data, files: [file] };
  try {
    return navigator.canShare(withFile) ? withFile : data;
  } catch {
    return data;
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
    const file = imageRef.current?.url === imageUrl ? (imageRef.current?.file ?? null) : null;
    try {
      await navigator.share(sharePayload({ title, text, url }, file));
    } catch (error) {
      // Chiuso dall'utente: niente. Altrimenti nessun nuovo tentativo (il gesto è già consumato):
      // si suggerisce di copiare il link.
      if ((error as { name?: unknown } | null)?.name !== 'AbortError') {
        toast.error('Condivisione non riuscita. Usa «Copia link» e incolla il link nell’app.');
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
