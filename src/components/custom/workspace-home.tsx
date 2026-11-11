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
  productResponseSchema,
  type ShopSummary,
  shopResponseSchema,
  shopsResponseSchema,
} from '@/lib/contracts/workspace';

function messageFor(error: unknown, fallback: string) {
  return requestErrorMessage(error, fallback);
}

function euro(cents: number) {
  return new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(cents / 100);
}

function statusLabel(status: string) {
  if (status === 'completed') return 'Controllo completato';
  if (status === 'in_progress') return 'Controllo da riprendere';
  if (status === 'failed') return 'Controllo interrotto';
  return 'Mai controllato';
}

export function WorkspaceHome() {
  const [shops, setShops] = useState<ShopSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [shopName, setShopName] = useState('');
  const [productName, setProductName] = useState('');
  const [productUrl, setProductUrl] = useState('');
  const [price, setPrice] = useState('');
  const [available, setAvailable] = useState('yes');
  const [selectedShopId, setSelectedShopId] = useState('');

  const loadShops = useCallback(async () => {
    try {
      const result = await apiFetch('/api/shops', { schema: shopsResponseSchema });
      setShops(result.shops);
      setSelectedShopId((current) =>
        result.shops.some((shop) => shop.id === current) ? current : (result.shops[0]?.id ?? ''),
      );
      setError('');
    } catch {
      setError('Non è stato possibile caricare i negozi. Riprova.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadShops();
  }, [loadShops]);

  async function createShop(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await apiFetch('/api/shops', {
        method: 'POST',
        body: JSON.stringify({ name: shopName }),
        schema: shopResponseSchema,
      });
      setShopName('');
      setShops((current) => [result.shop, ...current]);
      setSelectedShopId(result.shop.id);
      toast.success('Negozio creato. Aggiungi il primo prodotto.');
    } catch (caught) {
      toast.error(messageFor(caught, 'Non è stato possibile creare il negozio.'));
    } finally {
      setBusy(false);
    }
  }

  async function createProduct(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const amount = Number(price.replace(',', '.'));
    if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000) {
      setError('Inserisci un prezzo atteso valido in euro.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = await apiFetch(`/api/shops/${selectedShopId}/products`, {
        method: 'POST',
        body: JSON.stringify({
          name: productName,
          url: productUrl,
          expectedPriceCents: Math.round(amount * 100),
          expectedAvailability: available === 'yes',
          currency: 'EUR',
        }),
        schema: productResponseSchema,
      });
      window.location.assign(`/dashboard/products/${result.product.id}`);
    } catch (caught) {
      toast.error(messageFor(caught, 'Controlla il nome, l’URL e il prezzo inseriti.'));
    } finally {
      setBusy(false);
    }
  }

  const selectedShop = shops.find((shop) => shop.id === selectedShopId) ?? null;

  return (
    <div className="mx-auto grid max-w-5xl gap-8">
      <header className="flex flex-col gap-2 border-b border-border pb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
          Il tuo spazio
        </p>
        <h1 className="font-display text-4xl font-medium tracking-tight text-foreground">
          Negozi e prodotti
        </h1>
        <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
          Registra i valori attesi, poi avvia un controllo manuale dalla scheda prodotto.
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
      {loading ? (
        <output className="text-sm text-muted-foreground">Caricamento dei tuoi negozi…</output>
      ) : null}

      {!loading && shops.length === 0 ? (
        <section
          className="grid gap-5 rounded-xl border border-border bg-card p-5 sm:p-7"
          aria-labelledby="new-shop-title"
        >
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
              01 · Primo passaggio
            </p>
            <h2 id="new-shop-title" className="mt-2 font-display text-2xl">
              Crea il tuo spazio negozio
            </h2>
            <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
              Questo spazio conterrà solo le schede che aggiungi tu. Puoi partire anche senza dati
              preesistenti.
            </p>
          </div>
          <form
            className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
            onSubmit={createShop}
          >
            <div className="grid gap-2">
              <Label htmlFor="shop-name">Nome del negozio</Label>
              <Input
                id="shop-name"
                autoComplete="organization"
                value={shopName}
                onChange={(event) => setShopName(event.target.value)}
                minLength={2}
                maxLength={100}
                required
                placeholder="Es. Il mio negozio"
              />
            </div>
            <Button type="submit" disabled={busy}>
              {busy ? 'Creazione…' : 'Crea negozio'}
            </Button>
          </form>
        </section>
      ) : null}

      {!loading && shops.length > 0 ? (
        <>
          <section className="grid gap-4" aria-labelledby="shop-list-title">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  I tuoi spazi
                </p>
                <h2 id="shop-list-title" className="mt-1 font-display text-2xl">
                  Scegli un negozio
                </h2>
              </div>
              <form className="flex w-full gap-2 sm:w-auto" onSubmit={createShop}>
                <Label className="sr-only" htmlFor="another-shop">
                  Nome del nuovo negozio
                </Label>
                <Input
                  id="another-shop"
                  value={shopName}
                  onChange={(event) => setShopName(event.target.value)}
                  minLength={2}
                  maxLength={100}
                  required
                  placeholder="Nuovo negozio"
                />
                <Button type="submit" variant="outline" disabled={busy}>
                  Aggiungi
                </Button>
              </form>
            </div>
            <div className="flex flex-wrap gap-2" role="tablist" aria-label="I tuoi negozi">
              {shops.map((shop) => (
                <button
                  key={shop.id}
                  type="button"
                  role="tab"
                  aria-selected={selectedShopId === shop.id}
                  onClick={() => setSelectedShopId(shop.id)}
                  className={`rounded-full border px-4 py-2 text-sm transition-colors ${selectedShopId === shop.id ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card text-foreground hover:bg-muted'}`}
                >
                  {shop.name} <span className="ml-1 opacity-75">{shop.products.length}</span>
                </button>
              ))}
            </div>
          </section>

          {selectedShop ? (
            <section
              className="grid gap-5 rounded-xl border border-border bg-card p-5 sm:p-7"
              aria-labelledby="product-form-title"
            >
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  02 · {selectedShop.name}
                </p>
                <h2 id="product-form-title" className="mt-2 font-display text-2xl">
                  Aggiungi un prodotto
                </h2>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  Inserisci l’indirizzo pubblico e i valori con cui confrontare la pagina.
                </p>
              </div>
              <form className="grid gap-4 md:grid-cols-2" onSubmit={createProduct}>
                <div className="grid gap-2 md:col-span-2">
                  <Label htmlFor="product-name">Nome prodotto</Label>
                  <Input
                    id="product-name"
                    value={productName}
                    onChange={(event) => setProductName(event.target.value)}
                    maxLength={120}
                    required
                    placeholder="Es. Tazza in ceramica"
                  />
                </div>
                <div className="grid gap-2 md:col-span-2">
                  <Label htmlFor="product-url">URL della pagina prodotto</Label>
                  <Input
                    id="product-url"
                    type="url"
                    inputMode="url"
                    value={productUrl}
                    onChange={(event) => setProductUrl(event.target.value)}
                    required
                    placeholder="https://negozio.example/prodotto"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="expected-price">Prezzo atteso (EUR)</Label>
                  <Input
                    id="expected-price"
                    type="number"
                    inputMode="decimal"
                    min="0"
                    max="1000000"
                    step="0.01"
                    value={price}
                    onChange={(event) => setPrice(event.target.value)}
                    required
                    placeholder="29,90"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="expected-availability">Disponibilità attesa</Label>
                  <select
                    id="expected-availability"
                    value={available}
                    onChange={(event) => setAvailable(event.target.value)}
                    className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option value="yes">Disponibile</option>
                    <option value="no">Non disponibile</option>
                  </select>
                </div>
                <div className="flex flex-wrap items-center gap-3 pt-2 md:col-span-2">
                  <Button type="submit" disabled={busy}>
                    {busy ? 'Salvataggio…' : 'Salva e apri la scheda'}
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    Nessun pagamento · nessun controllo automatico
                  </span>
                </div>
              </form>
            </section>
          ) : null}

          {selectedShop ? (
            <section className="grid gap-4" aria-labelledby="products-title">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    Catalogo · {selectedShop.name}
                  </p>
                  <h2 id="products-title" className="mt-1 font-display text-2xl">
                    Schede prodotto
                  </h2>
                </div>
                {selectedShop.products.some(
                  (product) => (product.latestCheck?.issueCount ?? 0) > 0,
                ) ? (
                  <CsvExporter
                    sourceId="product-corrections"
                    filters={{ shopId: selectedShop.id }}
                    delimiter=";"
                  />
                ) : null}
              </div>
              {selectedShop.products.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
                  Nessun prodotto in questo spazio. Aggiungi la prima scheda qui sopra.
                </p>
              ) : (
                <ul className="grid gap-3">
                  {selectedShop.products.map((product) => (
                    <li
                      key={product.id}
                      className="grid gap-4 rounded-xl border border-border bg-card p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:p-5"
                    >
                      <div className="min-w-0">
                        <Link
                          href={`/dashboard/products/${product.id}`}
                          className="font-medium text-foreground underline-offset-4 hover:underline"
                        >
                          {product.name}
                        </Link>
                        <p className="mt-1 break-all text-xs text-muted-foreground">
                          {product.url}
                        </p>
                        <p className="mt-2 text-sm">
                          {euro(product.expectedPriceCents)} ·{' '}
                          {product.expectedAvailability ? 'Disponibile' : 'Non disponibile'}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-3 sm:justify-end">
                        <span className="text-xs text-muted-foreground">
                          {statusLabel(product.latestCheck?.status ?? '')}
                          {product.latestCheck?.issueCount
                            ? ` · ${product.latestCheck.issueCount} da rivedere`
                            : ''}
                        </span>
                        <Button asChild variant="outline" size="sm">
                          <Link href={`/dashboard/products/${product.id}`}>Apri scheda</Link>
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
