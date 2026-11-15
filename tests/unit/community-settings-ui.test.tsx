// @polsia:user-owned — «Il tuo profilo Solco» con i controlli segmentati: quattro radiogroup con
// nome e suggerimento, ogni controllo aggiorna la sua scelta (clic e frecce), l'avviso «Modifiche non
// salvate» compare e sparisce, e «Salva impostazioni» invia ESATTAMENTE lo stesso PATCH di prima
// (stesso endpoint, stesse chiavi nello stesso ordine). Anteprima profilo, errori e «Riprova».
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ZodType } from 'zod';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('next/link', () => ({
  // biome-ignore lint/suspicious/noExplicitAny: lo stub inoltra ciò che il componente passa.
  default: ({ href, children, ...rest }: any) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { CommunitySettingsPanel } from '@/components/custom/community/community-settings';
import { CommunitySelfResponseSchema } from '@/lib/contracts/community';

type Init = RequestInit & { schema?: ZodType<unknown> };

const stored = {
  id: 'prof 1',
  name: 'Giulia Verdi',
  profileRole: 'fan',
  profileVisibility: 'private',
  followersVisibility: 'private',
  followingVisibility: 'public',
  followerCount: 3,
  followingCount: 5,
};

/** GET restituisce il profilo salvato; PATCH lo aggiorna con il corpo ricevuto (come il server). */
function serveProfile() {
  let profile = { ...stored };
  mocks.apiFetch.mockImplementation(async (url: string, init?: Init) => {
    expect(url).toBe('/api/community/me');
    if (init?.method === 'PATCH') profile = { ...profile, ...JSON.parse(String(init.body)) };
    const value = { profile };
    return init?.schema ? init.schema.parse(value) : value;
  });
}

const roots: Array<ReturnType<typeof createRoot>> = [];

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.apiFetch.mockReset();
  mocks.toast.success.mockReset();
  mocks.toast.error.mockReset();
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => {
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
  });
}

async function mount() {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<CommunitySettingsPanel />));
  await flush();
  return container;
}

function group(container: HTMLElement, name: string) {
  const found = [...container.querySelectorAll<HTMLElement>('[role="radiogroup"]')].find(
    (node) =>
      document.getElementById(node.getAttribute('aria-labelledby') ?? '')?.textContent === name,
  );
  if (!found) throw new Error(`gruppo ${name} mancante`);
  return found;
}

function radio(scope: HTMLElement, label: string) {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
    (node) => node.textContent === label,
  );
  if (!found) throw new Error(`opzione ${label} mancante`);
  return found;
}

function checked(scope: HTMLElement) {
  return scope.querySelector('[role="radio"][aria-checked="true"]')?.textContent;
}

function button(container: HTMLElement, label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (node) => node.textContent === label,
  );
}

function unsavedHint(container: HTMLElement) {
  return container.querySelector('output:last-of-type')?.textContent ?? '';
}

describe('CommunitySettingsPanel', () => {
  it('mostra quattro controlli segmentati con nome, suggerimento e la scelta salvata', async () => {
    serveProfile();
    const container = await mount();
    expect(container.querySelector('select')).toBeNull();
    const groups = [...container.querySelectorAll('[role="radiogroup"]')];
    expect(groups).toHaveLength(4);
    const role = group(container, 'Ruolo del profilo');
    expect(document.getElementById(role.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      '“Artista” descrive il profilo, non è una verifica d’identità.',
    );
    expect([...role.querySelectorAll('[role="radio"]')].map((node) => node.textContent)).toEqual([
      'Fan',
      'Artista',
    ]);
    expect(checked(role)).toBe('Fan');
    expect(checked(group(container, 'Visibilità del profilo'))).toBe('Privato');
    expect(checked(group(container, 'Chi può vedere i tuoi follower'))).toBe('Solo io');
    expect(checked(group(container, 'Chi può vedere i profili che segui'))).toBe('Tutti');
    expect(unsavedHint(container)).toBe('');
    const preview = container.querySelector('a');
    expect(preview?.getAttribute('href')).toBe('/profiles/prof%201');
    expect(preview?.textContent).toBe('Anteprima profilo');
  });

  it('ogni controllo aggiorna la sua scelta e «Salva» invia esattamente lo stesso PATCH', async () => {
    serveProfile();
    const container = await mount();
    const role = group(container, 'Ruolo del profilo');
    const visibility = group(container, 'Visibilità del profilo');
    const followers = group(container, 'Chi può vedere i tuoi follower');
    const following = group(container, 'Chi può vedere i profili che segui');

    await act(async () => radio(role, 'Artista').click());
    await act(async () => radio(visibility, 'Pubblico').click());
    await act(async () => radio(followers, 'Tutti').click());
    // Con la tastiera: freccia a sinistra da «Tutti» sceglie «Solo io».
    radio(following, 'Tutti').focus();
    await act(async () => {
      radio(following, 'Tutti').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }),
      );
    });

    expect(checked(role)).toBe('Artista');
    expect(checked(visibility)).toBe('Pubblico');
    expect(checked(followers)).toBe('Tutti');
    expect(checked(following)).toBe('Solo io');
    expect(unsavedHint(container)).toBe('Modifiche non salvate');
    // Il salvataggio parte solo dal pulsante: nessuna richiesta ai cambi di scelta.
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);

    await act(async () => button(container, 'Salva impostazioni')?.click());
    await flush();

    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
    const [url, init] = mocks.apiFetch.mock.calls[1] as [string, Init];
    expect(url).toBe('/api/community/me');
    expect(init.method).toBe('PATCH');
    expect(init.schema).toBe(CommunitySelfResponseSchema);
    expect(init.body).toBe(
      '{"profileRole":"artist","profileVisibility":"public","followersVisibility":"public","followingVisibility":"private"}',
    );
    expect(mocks.toast.success).toHaveBeenCalledWith('Impostazioni community salvate.');
    expect(unsavedHint(container)).toBe('');
    expect(checked(role)).toBe('Artista');
  });

  it('tornare alla scelta salvata toglie l’avviso; senza modifiche «Salva» invia i valori caricati', async () => {
    serveProfile();
    const container = await mount();
    const role = group(container, 'Ruolo del profilo');
    await act(async () => radio(role, 'Artista').click());
    expect(unsavedHint(container)).toBe('Modifiche non salvate');
    await act(async () => radio(role, 'Fan').click());
    expect(unsavedHint(container)).toBe('');

    await act(async () => button(container, 'Salva impostazioni')?.click());
    await flush();
    const [, init] = mocks.apiFetch.mock.calls[1] as [string, Init];
    expect(init.body).toBe(
      '{"profileRole":"fan","profileVisibility":"private","followersVisibility":"private","followingVisibility":"public"}',
    );
  });

  it('salvataggio non riuscito: messaggio d’errore, le scelte e l’avviso restano', async () => {
    serveProfile();
    const container = await mount();
    mocks.apiFetch.mockRejectedValueOnce(new Error('rete'));
    const visibility = group(container, 'Visibilità del profilo');
    await act(async () => radio(visibility, 'Pubblico').click());
    await act(async () => button(container, 'Salva impostazioni')?.click());
    await flush();
    expect(mocks.toast.error).toHaveBeenCalledTimes(1);
    expect(checked(visibility)).toBe('Pubblico');
    expect(unsavedHint(container)).toBe('Modifiche non salvate');
    expect(button(container, 'Salva impostazioni')?.disabled).toBe(false);
  });

  it('caricamento non riuscito: stato di errore e «Riprova» ricarica', async () => {
    mocks.apiFetch.mockRejectedValueOnce(new Error('rete'));
    const container = await mount();
    expect(container.textContent).toContain('Le impostazioni non sono disponibili.');
    expect(mocks.toast.error).toHaveBeenCalledWith(
      'Non è stato possibile caricare le impostazioni community.',
    );
    serveProfile();
    await act(async () => button(container, 'Riprova')?.click());
    await flush();
    expect(container.querySelectorAll('[role="radiogroup"]')).toHaveLength(4);
  });
});
