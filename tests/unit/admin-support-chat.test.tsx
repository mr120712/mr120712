// @polsia:user-owned
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ pathname: vi.fn() }));

vi.mock('next/navigation', () => ({ usePathname: mocks.pathname }));
vi.mock('@/lib/ai/use-chat', () => ({
  useChat: () => ({ messages: [], input: '', setInput: vi.fn(), pending: false, send: vi.fn() }),
}));

import { SolcoSupportChat } from '@/components/custom/solco-support-chat';

describe('launcher del supporto generale', () => {
  beforeEach(() => {
    mocks.pathname.mockReset();
  });

  it('nasconde il widget sulle route admin per lasciare spazio all’assistente privato', () => {
    mocks.pathname.mockReturnValue('/admin/assistente');

    const markup = renderToStaticMarkup(<SolcoSupportChat />);

    expect(markup).toBe('');
  });

  it('mantiene il widget sulle route non amministrative', () => {
    mocks.pathname.mockReturnValue('/dashboard');

    const markup = renderToStaticMarkup(<SolcoSupportChat />);

    expect(markup).toContain('Apri l’assistenza di Solco');
  });
});
