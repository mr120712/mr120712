// @polsia:user-owned
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { getDataSaver, setDataSaver } from '@/lib/music/data-saver';

afterEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    // ignora
  }
});

describe('data-saver', () => {
  it('è spento per default', () => {
    expect(getDataSaver()).toBe(false);
  });

  it('persiste on e off', () => {
    setDataSaver(true);
    expect(getDataSaver()).toBe(true);
    setDataSaver(false);
    expect(getDataSaver()).toBe(false);
  });

  it('emette un evento al cambio (per aggiornare i componenti)', () => {
    let fired = 0;
    const handler = () => {
      fired += 1;
    };
    window.addEventListener('solco:data-saver-changed', handler);
    setDataSaver(true);
    setDataSaver(false);
    window.removeEventListener('solco:data-saver-changed', handler);
    expect(fired).toBe(2);
  });
});
