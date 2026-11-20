// @polsia:user-owned — copertina remota con ripiego su una copertina GENERATA (gradiente + iniziali)
// se l'immagine manca o non si carica. Il ripiego è deterministico dal testo (stesso brano → stessa
// copertina), senza rete: è l'ultimo anello della catena delle copertine in evidenza.
'use client';

import Image from 'next/image';
import { useState } from 'react';
import { coverGradient, coverInitials } from '@/lib/music/generated-cover';

export function FallbackArt({
  src,
  label,
  size,
}: {
  src: string | null | undefined;
  label: string;
  size: number;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (!src || failedSrc === src) {
    return (
      <span
        aria-hidden="true"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '100%',
          height: '100%',
          minWidth: size,
          minHeight: size,
          background: coverGradient(label),
          color: 'rgba(255, 255, 255, 0.96)',
          fontWeight: 700,
          fontSize: Math.max(12, Math.round(size * 0.36)),
          lineHeight: 1,
          letterSpacing: '0.03em',
          textShadow: '0 1px 3px rgba(0, 0, 0, 0.3)',
          userSelect: 'none',
        }}
      >
        {coverInitials(label)}
      </span>
    );
  }
  return (
    <Image
      src={src}
      alt=""
      width={size}
      height={size}
      unoptimized
      onError={() => setFailedSrc(src)}
    />
  );
}
