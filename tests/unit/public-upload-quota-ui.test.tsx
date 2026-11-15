// @polsia:user-owned — contatore «N / 3 brani pubblicati» del form della libreria pubblica: con 0, 2
// e 3 brani, e quando la lista dei propri brani non si è potuta leggere (mai un falso «0 / 3»).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/custom/music/library-context', () => ({
  useLibrary: () => ({ signedIn: true }),
}));

import { PublicUploadForm } from '@/components/custom/music/public-upload-form';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ configured: true }), { status: 200 })),
  );
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(count: number | null) {
  await act(async () => {
    root.render(<PublicUploadForm onUploaded={() => undefined} count={count} limit={3} />);
  });
}

function fileInput() {
  return container.querySelector<HTMLInputElement>('input[type="file"]');
}

describe('contatore dei brani pubblici (utente Free: massimo 3)', () => {
  it('0 brani: «0 / 3», caricamento possibile', async () => {
    await render(0);
    expect(container.textContent).toContain('0 / 3 brani pubblicati');
    expect(container.textContent).not.toContain('Hai raggiunto il massimo');
    expect(fileInput()?.disabled).toBe(false);
  });

  it('2 brani: «2 / 3», ancora un posto', async () => {
    await render(2);
    expect(container.textContent).toContain('2 / 3 brani pubblicati');
    expect(fileInput()?.disabled).toBe(false);
  });

  it('3 brani: «3 / 3», avviso del limite e caricamento disattivato', async () => {
    await render(3);
    expect(container.textContent).toContain('3 / 3 brani pubblicati');
    expect(container.textContent).toContain('Hai raggiunto il massimo di 3 brani pubblici');
    expect(fileInput()?.disabled).toBe(true);
  });

  it('lista non leggibile: niente «0 / 3», messaggio chiaro (il server applica comunque il tetto)', async () => {
    await render(null);
    expect(container.textContent).not.toContain('0 / 3');
    expect(container.textContent).toContain(
      'Non riesco a leggere quanti brani hai già pubblicato: il limite di 3 vale comunque.',
    );
    expect(container.textContent).not.toContain('Hai raggiunto il massimo');
  });
});
