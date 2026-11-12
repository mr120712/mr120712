// @polsia:user-owned — copertina remota con ripiego sull'iniziale se l'immagine non si carica.
'use client';

import Image from 'next/image';
import { useState } from 'react';
import { artInitial } from '@/lib/music/art-initial';

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
    return <span aria-hidden="true">{artInitial(label)}</span>;
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
