// @polsia:user-owned
'use client';

import { Menu } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { useSession } from '@/lib/auth-client';

export function HomeMobileNav({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const { data, isPending } = useSession();

  return (
    <div className={className}>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button type="button" variant="outline" size="icon" aria-label="Apri la navigazione">
            <Menu aria-hidden="true" />
          </Button>
        </SheetTrigger>
        <SheetContent
          side="right"
          className="w-[min(86vw,360px)] border-border bg-background text-foreground"
        >
          <SheetHeader className="text-left">
            <SheetTitle className="font-display text-2xl font-normal">Esplora Solco</SheetTitle>
            <SheetDescription>
              Cerca tra le fonti musicali disponibili e gestisci le tue raccolte.
            </SheetDescription>
          </SheetHeader>
          <nav className="mt-8 grid gap-1" aria-label="Navigazione principale">
            {[
              { href: '/#tendenze', label: 'Tendenze' },
              { href: '/#nuove-uscite', label: 'Nuove uscite' },
              { href: '/#playlist', label: 'Playlist' },
              { href: '/#artisti', label: 'Artisti' },
              { href: '/#generi', label: 'Generi' },
              { href: '/search', label: 'Cerca musica' },
            ].map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className="border-b border-border py-3 text-sm font-medium text-foreground underline-offset-4 hover:underline"
              >
                {item.label}
              </Link>
            ))}
            {!isPending && data?.user ? (
              <Link
                href="/messages"
                onClick={() => setOpen(false)}
                className="border-b border-border py-3 text-sm font-medium text-foreground underline-offset-4 hover:underline"
              >
                Messaggi
              </Link>
            ) : null}
            {!isPending && data?.user ? (
              <Link
                href="/dashboard"
                onClick={() => setOpen(false)}
                className="border-b border-border py-3 text-sm font-medium text-foreground underline-offset-4 hover:underline"
              >
                Preferiti e playlist
              </Link>
            ) : null}
            {!isPending && !data?.user ? (
              <Link
                href="/login"
                onClick={() => setOpen(false)}
                className="border-b border-border py-3 text-sm font-medium text-foreground underline-offset-4 hover:underline"
              >
                Accedi
              </Link>
            ) : null}
            {!isPending && !data?.user ? (
              <Link
                href="/signup"
                onClick={() => setOpen(false)}
                className="py-3 text-sm font-medium text-foreground underline-offset-4 hover:underline"
              >
                Crea un account
              </Link>
            ) : null}
          </nav>
        </SheetContent>
      </Sheet>
    </div>
  );
}
