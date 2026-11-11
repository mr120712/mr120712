// @polsia:user-owned — scorciatoia "Cerca con l'AI" in Home, mostrata solo quando la ricerca con
// l'AI è attiva (chiave Anthropic configurata sul server).
'use client';

import { Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { AiSearchStatusSchema } from '@/lib/contracts/ai-music-search';

export function AiSearchShortcut() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/music/ai-search', { schema: AiSearchStatusSchema })
      .then((value) => !cancelled && setEnabled(value.enabled))
      .catch(() => !cancelled && setEnabled(false));
    return () => {
      cancelled = true;
    };
  }, []);
  if (!enabled) return null;
  return (
    <Link href="/search?ai=1">
      <Sparkles aria-hidden="true" />
      Cerca con l’AI
    </Link>
  );
}
