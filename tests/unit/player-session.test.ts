// @polsia:user-owned — "Esci": la musica si ferma e la coda salvata sparisce PRIMA del logout; se il
// logout non riesce, l'utente resta sulla pagina (e lo sa) invece di credersi uscito.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ signOut: vi.fn() }));
vi.mock('@/lib/auth-client', () => ({ signOut: mocks.signOut }));

import {
  PLAYER_STORAGE_KEY,
  STOP_PLAYER_EVENT,
  signOutAndStopMusic,
  stopPlayerAndForget,
} from '@/lib/music/player-session';

const order: string[] = [];
const onStop = () => order.push('stop');

beforeEach(() => {
  order.length = 0;
  mocks.signOut.mockReset();
  window.localStorage.setItem(PLAYER_STORAGE_KEY, JSON.stringify({ owner: 'u1', queue: [] }));
  window.addEventListener(STOP_PLAYER_EVENT, onStop);
});

afterEach(() => {
  window.removeEventListener(STOP_PLAYER_EVENT, onStop);
  window.localStorage.clear();
});

describe('stopPlayerAndForget', () => {
  it('avvisa il player e cancella la coda salvata', () => {
    stopPlayerAndForget();
    expect(order).toEqual(['stop']);
    expect(window.localStorage.getItem(PLAYER_STORAGE_KEY)).toBeNull();
  });
});

describe('signOutAndStopMusic', () => {
  it('ferma la musica prima del logout, poi naviga', async () => {
    mocks.signOut.mockImplementation(async () => {
      order.push('signOut');
      // Al momento del logout la coda è già stata dimenticata.
      expect(window.localStorage.getItem(PLAYER_STORAGE_KEY)).toBeNull();
      return { data: { success: true }, error: null };
    });
    const navigate = vi.fn((url: string) => order.push(`go:${url}`));
    expect(await signOutAndStopMusic('/login', navigate)).toBe(true);
    expect(order).toEqual(['stop', 'signOut', 'go:/login']);
  });

  it('logout rifiutato dal server: niente navigazione, musica comunque ferma', async () => {
    mocks.signOut.mockResolvedValue({ data: null, error: { status: 500 } });
    const navigate = vi.fn();
    expect(await signOutAndStopMusic('/', navigate)).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
    expect(order).toEqual(['stop']);
    expect(window.localStorage.getItem(PLAYER_STORAGE_KEY)).toBeNull();
  });

  it('rete assente: niente navigazione', async () => {
    mocks.signOut.mockRejectedValue(new TypeError('Failed to fetch'));
    const navigate = vi.fn();
    expect(await signOutAndStopMusic('/', navigate)).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });
});
