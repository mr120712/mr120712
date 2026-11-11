// @polsia:user-owned
'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { buildSolcoListeningCardSvg } from '@/lib/business/solco-pro-card';
import { solcoProCardSchema } from '@/lib/contracts/solco-pro';

export function SolcoProCardDownload({ entryId }: { entryId: string }) {
  const [pending, setPending] = useState(false);

  async function downloadCard() {
    setPending(true);
    try {
      const query = new URLSearchParams({ entry_id: entryId });
      const card = await apiFetch(`/api/solco-pro/card?${query}`, { schema: solcoProCardSchema });
      const file = new Blob([buildSolcoListeningCardSvg(card)], {
        type: 'image/svg+xml;charset=utf-8',
      });
      const url = URL.createObjectURL(file);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `ascolto-${entryId.replace(/[^a-z0-9_-]/gi, '-')}.svg`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      toast.success('Card senza logo scaricata.');
    } catch {
      toast.error('Non è stato possibile creare la card. Verifica il tuo accesso Pro e riprova.');
    } finally {
      setPending(false);
    }
  }

  return (
    <Button type="button" size="sm" variant="outline" disabled={pending} onClick={downloadCard}>
      {pending ? 'Creo la card…' : 'Card senza logo'}
    </Button>
  );
}
