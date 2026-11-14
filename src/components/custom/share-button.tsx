// @polsia:user-owned — condivide una pagina di Solco: social (WhatsApp, Telegram, X, Facebook,
// email), menu del telefono o copia del link. Il link porta sempre al sito ufficiale.
'use client';

import { ShareMenu } from '@/components/custom/share-menu';
import { publicShareUrl } from '@/lib/business/social-share';

export function ShareButton({
  title,
  text,
  path,
  imageUrl,
}: {
  title: string;
  text: string;
  path: string;
  /** Scheda/immagine da allegare nel menu di condivisione del telefono (percorso same-origin). */
  imageUrl?: string;
}) {
  return <ShareMenu title={title} text={text} url={publicShareUrl(path)} imageUrl={imageUrl} />;
}
