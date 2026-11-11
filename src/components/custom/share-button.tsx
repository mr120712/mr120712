// @polsia:user-owned — condivide una pagina di Solco (menu nativo del telefono o copia del link).
'use client';

import { Share2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

export function ShareButton({ title, text, path }: { title: string; text: string; path: string }) {
  const share = async () => {
    const url = new URL(path, window.location.origin).toString();
    if (navigator.share) {
      await navigator.share({ title, text, url }).catch(() => undefined);
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Link copiato.');
    } catch {
      toast.error('Non è stato possibile copiare il link.');
    }
  };
  return (
    <Button type="button" variant="outline" onClick={share}>
      <Share2 aria-hidden="true" /> Condividi
    </Button>
  );
}
