// @polsia:user-owned
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ useSession: vi.fn() }));
vi.mock('@/lib/auth-client', () => ({ useSession: mocks.useSession }));

import { RateLimitNotice } from '@/components/custom/admin/rate-limit-notice';
import { RATE_LIMIT_PROTECTION_NOTICE } from '@/lib/business/rate-limit-notice';

const roots: Array<ReturnType<typeof createRoot>> = [];

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

async function renderNotice() {
  const container = document.createElement('div');
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<RateLimitNotice />));
  return container;
}

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  mocks.useSession.mockReset();
  vi.unstubAllGlobals();
});

describe('nota amministrativa sui limiti', () => {
  it('mostra i limiti di rete solo a un amministratore verificato', async () => {
    mocks.useSession.mockReturnValue({
      data: { user: { role: 'admin', emailVerified: true } },
    });
    const admin = await renderNotice();
    expect(admin.textContent).toContain('Limiti e copertura della protezione');
    expect(admin.textContent).toContain('DDoS di rete');
    expect(admin.textContent).toContain('CDN o WAF');

    mocks.useSession.mockReturnValue({ data: { user: { role: 'user', emailVerified: true } } });
    const member = await renderNotice();
    expect(member.textContent).toBe('');

    mocks.useSession.mockReturnValue({ data: { user: { role: 'admin', emailVerified: false } } });
    const unverifiedAdmin = await renderNotice();
    expect(unverifiedAdmin.textContent).toBe('');
  });

  it('distingue la protezione applicativa dalla saturazione della rete', () => {
    expect(RATE_LIMIT_PROTECTION_NOTICE).toContain('solo quando una richiesta raggiunge l’applicazione');
    expect(RATE_LIMIT_PROTECTION_NOTICE).toContain('saturazione della banda o delle connessioni');
    expect(RATE_LIMIT_PROTECTION_NOTICE).toContain('IP condivisi');
    expect(RATE_LIMIT_PROTECTION_NOTICE).toContain('IP ruotati');
    expect(RATE_LIMIT_PROTECTION_NOTICE).toContain('provider, CDN o WAF');
  });
});
