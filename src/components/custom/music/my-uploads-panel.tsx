// @polsia:user-owned — «I tuoi brani caricati»: con la libreria pubblica SPENTA (src/lib/features.ts)
// l'autore resta padrone dei propri file. Elenca SOLO i tuoi brani (GET /mine, privato), con
// Scarica (download del tuo file) e Rimuovi (riga + file su Blob, dopo conferma). Non mostra nulla
// a chi non è loggato o non ha mai caricato brani. Con la libreria accesa questo lo fa /pubblica.
'use client';

import { Download, Loader2, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useLibrary } from '@/components/custom/music/library-context';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-client';
import { type PublicUpload, PublicUploadMineResponseSchema } from '@/lib/contracts/public-uploads';

export function MyUploadsPanel() {
  const { signedIn } = useLibrary();
  // null = non ancora letto (o utente non loggato); array = i tuoi brani caricati.
  const [items, setItems] = useState<PublicUpload[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<PublicUpload | null>(null);

  useEffect(() => {
    if (!signedIn) {
      setItems(null);
      return;
    }
    let cancelled = false;
    apiFetch('/api/music/public-uploads/mine', { schema: PublicUploadMineResponseSchema })
      .then((data) => {
        if (cancelled) return;
        setItems(data.items);
        setFailed(false);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [signedIn]);

  const remove = async (upload: PublicUpload) => {
    setRemovingId(upload.id);
    try {
      await apiFetch(`/api/music/public-uploads/${upload.id}`, { method: 'DELETE' });
      setItems((current) => current?.filter((item) => item.id !== upload.id) ?? null);
      toast.success('Brano rimosso.');
    } catch {
      toast.error('Non è stato possibile rimuovere il brano.');
    } finally {
      setRemovingId(null);
    }
  };

  if (!signedIn) return null;
  if (failed) {
    return (
      <output className="block text-sm text-muted-foreground">
        Non è stato possibile leggere i tuoi brani caricati. Riprova più tardi.
      </output>
    );
  }
  if (!items || items.length === 0) return null;

  return (
    <section
      aria-labelledby="my-uploads-heading"
      className="rounded-xl border border-border bg-card p-5 text-card-foreground"
    >
      <h2 id="my-uploads-heading" className="text-sm font-semibold">
        I tuoi brani caricati
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        La libreria pubblica non è attiva: qui trovi i brani che avevi caricato. Puoi scaricarli o
        rimuoverli definitivamente, file compreso.
      </p>
      <ul className="mt-3 flex flex-col gap-2">
        {items.map((upload) => (
          <li
            key={upload.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2"
          >
            <span className="min-w-0 truncate text-sm">
              <span className="font-medium">{upload.title}</span>
              {upload.artist ? (
                <span className="text-muted-foreground"> · {upload.artist}</span>
              ) : null}
            </span>
            <span className="flex flex-none items-center gap-1">
              <Button asChild variant="ghost" size="sm">
                <a
                  href={`/api/music/public-uploads/${upload.id}/download`}
                  download
                  aria-label={`Scarica ${upload.title}`}
                >
                  <Download aria-hidden="true" />
                  Scarica
                </a>
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setConfirming(upload)}
                disabled={removingId === upload.id}
                aria-label={`Rimuovi ${upload.title}`}
              >
                {removingId === upload.id ? (
                  <Loader2 aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
                ) : (
                  <Trash2 aria-hidden="true" />
                )}
                Rimuovi
              </Button>
            </span>
          </li>
        ))}
      </ul>

      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rimuovere «{confirming?.title}»?</AlertDialogTitle>
            <AlertDialogDescription>
              Il brano e il suo file vengono cancellati da Solco. Finché la libreria pubblica non è
              attiva non potrai caricarlo di nuovo.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annulla</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirming) void remove(confirming);
              }}
            >
              Rimuovi
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
