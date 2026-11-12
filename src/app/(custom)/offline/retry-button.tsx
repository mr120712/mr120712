// @polsia:user-owned — "Riprova" della pagina /offline: ricarica l'indirizzo richiesto (il Service
// Worker può aver servito /offline al posto di un'altra pagina, che così si ritenta).

'use client';

import { RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function RetryButton() {
  return (
    <Button type="button" size="lg" onClick={() => window.location.reload()}>
      <RotateCw aria-hidden="true" />
      Riprova
    </Button>
  );
}
