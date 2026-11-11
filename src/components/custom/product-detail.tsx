// @polsia:user-owned
'use client';

import Link from 'next/link';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CsvExporter } from '@/components/custom/csv-exporter';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiFetch } from '@/lib/api-client';
import { requestErrorMessage } from '@/lib/business/request-error-message';
import {
  type ProductCheckRecord,
  type ProductDetail as ProductDetailType,
  productCheckResponseSchema,
  productDetailResponseSchema,
} from '@/lib/contracts/workspace';

function _euro(cents: number) {
  return new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(cents / 100);
}

function apiErrorMessage(error: unknown, fallback: string) {
  return requestErrorMessage(error, fallback);
}

function checkLabel(status: string) {
  if (status === 'match') return 'Corrisponde';
  if (status === 'anomaly') return 'Anomalia';
  return 'Da verificare';
}

function fieldLabel(field: string) {
  if (field === 'page') return 'Pagina';
  if (field === 'link') return 'Link';
  if (field === 'redirect') return 'Redirect';
  if (field === 'price') return 'Prezzo';
  if (field === 'availability') return 'Disponibilità';
  return field;
}

function factClass(status: string) {
  return status === 'match'
    ? 'border-status-positive/30 bg-status-positive/5'
    : status === 'anomaly'
      ? 'border-destructive/30 bg-destructive/5'
      : 'border-status-warning/30 bg-status-warning/5';
}

export function ProductDetail({ productId }: { productId: string }) {
  const [product, setProduct] = useState<ProductDetailType | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [price, setPrice] = useState('');
  const [available, setAvailable] = useState('yes');

  const loadProduct = useCallback(async () => {
    try {
      const response = await apiFetch(`/api/products/${productId}`, {
        schema: productDetailResponseSchema,
      });
      setProduct(response.product);
      setName(response.product.name);
      setUrl(response.product.url);
      setPrice((response.product.expectedPriceCents / 100).toFixed(2));
      setAvailable(response.product.expectedAvailability ? 'yes' : 'no');
      setError('');
    } catch {
      setError('La scheda non è disponibile oppure non appartiene al tuo spazio.');
    } finally {
      setLoading(false);
    }
  }, [productId]);

  useEffect(() => {
    void loadProduct();
  }, [loadProduct]);

  function replaceCheck(check: ProductCheckRecord) {
    setProduct((current) => (current ? { ...current, latestCheck: check } : current));
  }

  async function continueLinks(checkId: string, remainingLinks: number) {
    let remaining = remainingLinks;
    while (remaining > 0) {
      const result = await apiFetch(`/api/checks/${checkId}/links/next`, {
        method: 'POST',
        body: JSON.stringify({}),
        schema: productCheckResponseSchema,
      });
      replaceCheck(result.check);
      remaining = result.remainingLinks;
    }
  }

  async function startCheck() {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('Lettura della pagina in corso…');
    try {
      const result = await apiFetch(`/api/products/${productId}/checks`, {
        method: 'POST',
        body: JSON.stringify({}),
        schema: productCheckResponseSchema,
      });
      replaceCheck(result.check);
      if (result.remainingLinks > 0) {
        setNotice(`Pagina letta. Verifica dei link: ${result.remainingLinks} ancora da leggere.`);
        await continueLinks(result.check.id, result.remainingLinks);
      }
      await loadProduct();
      setNotice('');
      toast.success('Controllo salvato nella scheda. Rivedi corrispondenze e correzioni.');
    } catch (caught) {
      await loadProduct();
      setNotice('');
      toast.error(
        apiErrorMessage(
          caught,
          'Il controllo si è interrotto. L’esito parziale resta salvato; puoi riprendere i link rimasti.',
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  async function resumeLinks() {
    const check = product?.latestCheck;
    if (!check || busy) return;
    const remaining = check.result.links.filter((link) => link.status === 'pending').length;
    if (remaining === 0) return;
    setBusy(true);
    setError('');
    setNotice(`Ripresa del controllo link: ${remaining} ancora da leggere.`);
    try {
      await continueLinks(check.id, remaining);
      await loadProduct();
      setNotice('');
      toast.success('Controllo dei link salvato nella scheda.');
    } catch (caught) {
      await loadProduct();
      setNotice('');
      toast.error(
        apiErrorMessage(
          caught,
          'La lettura si è fermata. L’esito parziale è salvato; puoi riprendere i link rimasti.',
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  async function saveProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const amount = Number(price.replace(',', '.'));
    if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000) {
      setError('Inserisci un prezzo atteso valido in euro.');
      return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const response = await apiFetch(`/api/products/${productId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name,
          url,
          expectedPriceCents: Math.round(amount * 100),
          expectedAvailability: available === 'yes',
        }),
        schema: productDetailResponseSchema,
      });
      setProduct(response.product);
      toast.success('Valori attesi aggiornati. Avvia un nuovo controllo per confrontarli.');
    } catch (caught) {
      toast.error(
        apiErrorMessage(
          caught,
          'Non è stato possibile salvare la scheda. Controlla i dati inseriti.',
        ),
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading)
    return <output className="text-sm text-muted-foreground">Caricamento della scheda…</output>;
  if (!product)
    return (
      <section className="grid gap-4">
        <p className="text-sm text-destructive" role="alert">
          {error || 'Scheda non disponibile.'}
        </p>
        <Button asChild variant="outline" className="w-fit">
          <Link href="/dashboard">Torna ai negozi</Link>
        </Button>
      </section>
    );

  const check = product.latestCheck;
  const result = check?.result;
  const pendingLinks = result?.links.filter((link) => link.status === 'pending').length ?? 0;

  return (
    <div className="mx-auto grid max-w-5xl gap-8">
      <header className="grid gap-3 border-b border-border pb-6">
        <Link
          className="w-fit text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          href="/dashboard"
        >
          ← Torna a {product.shopName}
        </Link>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
          Scheda prodotto · {product.shopName}
        </p>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-4xl font-medium tracking-tight">{product.name}</h1>
            <p className="mt-2 break-all text-sm text-muted-foreground">{product.url}</p>
          </div>
          <Button type="button" size="lg" onClick={startCheck} disabled={busy}>
            {busy ? 'Controllo in corso…' : 'Avvia controllo manuale'}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Il controllo parte solo quando premi il pulsante. Nessuna scansione pianificata.
        </p>
      </header>

      {error ? (
        <p
          className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
          role="alert"
        >
          {error}
        </p>
      ) : null}
      {notice ? (
        <output className="rounded-md border border-border bg-muted/40 p-3 text-sm">
          {notice}
        </output>
      ) : null}

      <section
        className="grid gap-4 rounded-xl border border-border bg-card p-5 sm:p-7"
        aria-labelledby="expected-title"
      >
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Dati inseriti
          </p>
          <h2 id="expected-title" className="mt-1 font-display text-2xl">
            Valori attesi
          </h2>
        </div>
        <form className="grid gap-4 md:grid-cols-2" onSubmit={saveProduct}>
          <div className="grid gap-2 md:col-span-2">
            <Label htmlFor="detail-name">Nome prodotto</Label>
            <Input
              id="detail-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              maxLength={120}
            />
          </div>
          <div className="grid gap-2 md:col-span-2">
            <Label htmlFor="detail-url">URL della pagina</Label>
            <Input
              id="detail-url"
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="detail-price">Prezzo atteso (EUR)</Label>
            <Input
              id="detail-price"
              type="number"
              min="0"
              max="1000000"
              step="0.01"
              value={price}
              onChange={(event) => setPrice(event.target.value)}
              required
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="detail-availability">Disponibilità attesa</Label>
            <select
              id="detail-availability"
              value={available}
              onChange={(event) => setAvailable(event.target.value)}
              className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="yes">Disponibile</option>
              <option value="no">Non disponibile</option>
            </select>
          </div>
          <div className="md:col-span-2">
            <Button type="submit" variant="outline" disabled={saving}>
              {saving ? 'Salvataggio…' : 'Salva valori attesi'}
            </Button>
          </div>
        </form>
      </section>

      <section className="grid gap-5" aria-labelledby="result-title">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              Esito persistito
            </p>
            <h2 id="result-title" className="mt-1 font-display text-2xl">
              Ultimo controllo
            </h2>
          </div>
          {result && result.issues.length > 0 && check?.checkedAt ? (
            <CsvExporter
              sourceId="product-corrections"
              filters={{ shopId: product.shopId, productId: product.id }}
              delimiter=";"
            />
          ) : null}
        </div>
        {!check ? (
          <div className="rounded-xl border border-dashed border-border px-5 py-7">
            <p className="font-medium">Nessun controllo eseguito</p>
            <p className="mt-2 text-sm text-muted-foreground">
              Quando vuoi, avvia il primo controllo manuale. Prima rimarrà solo questa scheda con i
              dati attesi.
            </p>
          </div>
        ) : (
          <div className="grid gap-4">
            {check.checkedAt && !check.isCurrent ? (
              <p className="rounded-md border border-status-warning/30 bg-status-warning/5 p-3 text-sm">
                I valori attesi sono cambiati dopo questo controllo: avviane uno nuovo per
                confrontarli.
              </p>
            ) : null}
            {check.status === 'in_progress' && pendingLinks > 0 ? (
              <Button
                type="button"
                variant="outline"
                className="w-fit"
                onClick={resumeLinks}
                disabled={busy}
              >
                {busy ? 'Lettura in corso…' : `Riprendi controllo link (${pendingLinks})`}
              </Button>
            ) : null}
            {result ? (
              <>
                <article
                  className={`grid gap-2 rounded-lg border p-4 ${result.page.status === 'readable' ? 'border-status-positive/30 bg-status-positive/5' : 'border-status-warning/30 bg-status-warning/5'}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="font-medium">Pagina</h3>
                    <span className="text-xs font-semibold uppercase tracking-wide">
                      {result.page.status === 'readable' ? 'Leggibile' : 'Non verificabile'}
                    </span>
                  </div>
                  <p className="text-sm">
                    {result.page.title ?? result.page.reason ?? 'La pagina non è leggibile.'}
                  </p>
                  {result.page.truncated ? (
                    <p className="text-xs text-muted-foreground">
                      Il contenuto restituito è parziale; i dati non espliciti restano da
                      verificare.
                    </p>
                  ) : null}
                </article>
                <div className="grid gap-3 sm:grid-cols-2">
                  <article
                    className={`grid gap-2 rounded-lg border p-4 ${factClass(result.price.status)}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="font-medium">Prezzo</h3>
                      <span className="text-xs font-semibold">
                        {checkLabel(result.price.status)}
                      </span>
                    </div>
                    <p className="text-sm">Atteso: {result.price.expected}</p>
                    <p className="text-sm">
                      Rilevato: {result.price.observed ?? 'Non verificabile'}
                    </p>
                    {result.price.reason ? (
                      <p className="text-xs text-muted-foreground">{result.price.reason}</p>
                    ) : null}
                    {result.price.evidence ? (
                      <p className="text-xs text-muted-foreground">
                        Testo letto: “{result.price.evidence}”
                      </p>
                    ) : null}
                  </article>
                  <article
                    className={`grid gap-2 rounded-lg border p-4 ${factClass(result.availability.status)}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="font-medium">Disponibilità</h3>
                      <span className="text-xs font-semibold">
                        {checkLabel(result.availability.status)}
                      </span>
                    </div>
                    <p className="text-sm">Attesa: {result.availability.expected}</p>
                    <p className="text-sm">
                      Rilevata: {result.availability.observed ?? 'Non verificabile'}
                    </p>
                    {result.availability.reason ? (
                      <p className="text-xs text-muted-foreground">{result.availability.reason}</p>
                    ) : null}
                    {result.availability.evidence ? (
                      <p className="text-xs text-muted-foreground">
                        Testo letto: “{result.availability.evidence}”
                      </p>
                    ) : null}
                  </article>
                </div>
                <article className="grid gap-3 rounded-lg border border-border bg-card p-4">
                  <div>
                    <h3 className="font-medium">Link rilevati</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      La lettura controlla se la destinazione restituisce una pagina. Il redirect e
                      la destinazione finale restano da confermare nel browser.
                    </p>
                  </div>
                  {result.links.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      Nessun link rilevato nel testo restituito.
                    </p>
                  ) : (
                    <ul className="grid gap-2">
                      {result.links.map((link) => (
                        <li
                          key={link.url}
                          className="grid gap-1 border-t border-border pt-2 text-sm"
                        >
                          <a
                            className="break-all underline underline-offset-4"
                            href={link.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {link.label || link.url}
                          </a>
                          <span className="text-xs text-muted-foreground">
                            {link.status === 'readable'
                              ? `Pagina leggibile${link.title ? ` · ${link.title}` : ''}`
                              : (link.reason ?? 'Da verificare')}
                          </span>
                          <span className="text-xs text-status-warning">
                            Redirect: non verificabile
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </article>
                <article className="grid gap-3 rounded-lg border border-border bg-card p-4">
                  <div>
                    <h3 className="font-medium">Correzioni da rivedere · {result.issues.length}</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Le corrispondenze non vengono incluse nel CSV; anomalie e incertezze sì.
                    </p>
                  </div>
                  {result.issues.length === 0 ? (
                    <p className="text-sm text-status-positive">
                      Nessuna correzione o verifica aggiuntiva da segnalare.
                    </p>
                  ) : (
                    <ul className="grid gap-3">
                      {result.issues.map((issue) => (
                        <li key={issue.id} className="grid gap-1 border-t border-border pt-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs font-semibold uppercase tracking-wide">
                              {fieldLabel(issue.field)}
                            </span>
                            <span
                              className={`rounded-full px-2 py-0.5 text-xs ${issue.kind === 'anomaly' ? 'bg-destructive/10 text-destructive' : 'bg-status-warning/10 text-status-warning'}`}
                            >
                              {issue.kind === 'anomaly' ? 'Anomalia' : 'Non verificabile'}
                            </span>
                          </div>
                          <p className="text-sm">Atteso: {issue.expected}</p>
                          <p className="text-sm">
                            Rilevato: {issue.observed ?? 'Nessun dato leggibile'}
                          </p>
                          <p className="text-sm text-muted-foreground">{issue.reason}</p>
                          <p className="text-sm">Intervento da rivedere: {issue.action}</p>
                          {issue.url ? (
                            <a
                              className="break-all text-xs underline underline-offset-4"
                              href={issue.url}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {issue.url}
                            </a>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </article>
                <p className="text-xs text-muted-foreground">
                  Controllato:{' '}
                  {check.checkedAt
                    ? new Date(check.checkedAt).toLocaleString('it-IT')
                    : 'Lettura in corso'}
                </p>
              </>
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}
