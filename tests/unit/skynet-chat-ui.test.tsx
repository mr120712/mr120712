// @polsia:user-owned — la chat di «Skynet» nel pannello in /admin/monitoraggio: domande d'esempio e
// domande scritte, la conversazione che accompagna ogni nuova domanda, chi ha risposto e con quali
// fonti, i comandi che aggiornano il pannello, gli errori in parole; nel pannello, la riga
// dell'autodifesa e la chat che resta anche se lo stato non si carica.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ apiFetch: mocks.apiFetch }));

import { chatErrorMessage, metaText, SkynetChat } from '@/components/custom/monitoring/skynet-chat';
import { autodefenseText, SkynetPanel } from '@/components/custom/monitoring/skynet-panel';
import type { SkynetOverview } from '@/lib/contracts/skynet';
import { SKYNET_CHAT_MAX_TURNS, SKYNET_CHAT_SUGGESTIONS } from '@/lib/contracts/skynet-chat';

const roots: Array<{ root: Root; container: HTMLElement }> = [];

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mount(node: React.ReactNode) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push({ root, container });
  await act(async () => root.render(node));
  await settle();
  return container;
}

async function ask(view: HTMLElement, question: string) {
  const textarea = view.querySelector('textarea') as HTMLTextAreaElement;
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  await act(async () => {
    setValue?.call(textarea, question);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    view
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await settle();
}

const answer = (reply: string, extra: Record<string, unknown> = {}) => ({
  reply,
  engine: 'claude',
  sources: ['stato e segnali', 'diario'],
  missing: [],
  ...extra,
});

/** Il corpo dell'ultima domanda mandata al server. */
function lastBody(): { messages: Array<{ role: string; content: string }> } {
  const call = mocks.apiFetch.mock.calls.at(-1) as [string, { body: string }];
  return JSON.parse(call[1].body);
}

beforeEach(() => {
  mocks.apiFetch.mockReset();
});

afterEach(() => {
  for (const { root, container } of roots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe('chat di Skynet, nel pannello', () => {
  it('parte vuota con le domande d’esempio; toccarne una la manda', async () => {
    mocks.apiFetch.mockResolvedValue(answer('Oggi tutto tranquillo.'));
    const view = await mount(<SkynetChat />);
    const chips = [...view.querySelectorAll('button')].filter((button) =>
      (SKYNET_CHAT_SUGGESTIONS as readonly string[]).includes(button.textContent ?? ''),
    );
    expect(chips).toHaveLength(SKYNET_CHAT_SUGGESTIONS.length);
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    await act(async () => chips[0]?.click());
    await settle();
    expect(mocks.apiFetch).toHaveBeenCalledWith(
      '/api/admin/skynet/chat',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(lastBody()).toEqual({ messages: [{ role: 'user', content: 'Cosa è successo oggi?' }] });
    const articles = [...view.querySelectorAll('article')];
    expect(articles.map((item) => item.dataset.role)).toEqual(['user', 'assistant']);
    expect(articles[0]?.textContent).toContain('Lei');
    expect(articles[1]?.textContent).toContain('Skynet');
    expect(articles[1]?.textContent).toContain('Oggi tutto tranquillo.');
    expect(articles[1]?.textContent).toContain(
      'Risposta di Claude · Fonti lette: stato e segnali, diario',
    );
  });

  it('una domanda scritta porta con sé la conversazione precedente', async () => {
    mocks.apiFetch
      .mockResolvedValueOnce(answer('Oggi tutto tranquillo.'))
      .mockResolvedValueOnce(answer('Ieri un incidente, chiuso in 10 minuti.'));
    const view = await mount(<SkynetChat />);
    await ask(view, '  Cosa è successo oggi?  ');
    await ask(view, 'E ieri?');
    expect(lastBody().messages).toEqual([
      { role: 'user', content: 'Cosa è successo oggi?' },
      { role: 'assistant', content: 'Oggi tutto tranquillo.' },
      { role: 'user', content: 'E ieri?' },
    ]);
    expect(view.querySelectorAll('article')).toHaveLength(4);
    expect((view.querySelector('textarea') as HTMLTextAreaElement).value).toBe('');
  });

  it('non manda mai più turni di quelli che il server accetta', async () => {
    mocks.apiFetch.mockImplementation(async () => answer('ok'));
    const view = await mount(<SkynetChat />);
    for (let turn = 0; turn < SKYNET_CHAT_MAX_TURNS; turn += 1) await ask(view, `domanda ${turn}`);
    expect(lastBody().messages).toHaveLength(SKYNET_CHAT_MAX_TURNS);
    expect(lastBody().messages.at(-1)).toEqual({
      role: 'user',
      content: `domanda ${SKYNET_CHAT_MAX_TURNS - 1}`,
    });
  });

  it('una domanda vuota non parte', async () => {
    const view = await mount(<SkynetChat />);
    await ask(view, '   ');
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(view.querySelectorAll('article')).toHaveLength(0);
  });

  it('un comando eseguito aggiorna il pannello; una risposta normale no', async () => {
    const onCommand = vi.fn();
    mocks.apiFetch
      .mockResolvedValueOnce(answer('Tutto bene.'))
      .mockResolvedValueOnce(
        answer('Fatto: autodifesa in pausa.', { engine: 'command', sources: [] }),
      );
    const view = await mount(<SkynetChat onCommand={onCommand} />);
    await ask(view, 'tutto bene?');
    expect(onCommand).not.toHaveBeenCalled();
    await ask(view, 'pausa autodifesa 2 ore');
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(view.textContent).toContain('Comando eseguito da Skynet, senza AI');
  });

  it('errore: lo dice in parole e la domanda resta visibile', async () => {
    mocks.apiFetch.mockRejectedValue(
      new Error('apiFetch failed (429)', {
        cause: {
          error: 'rate_limited',
          message: 'Hai raggiunto il limite per le domande a Skynet.',
        },
      }),
    );
    const view = await mount(<SkynetChat />);
    await ask(view, 'ci sei?');
    expect(view.querySelector('[role="alert"]')?.textContent).toBe(
      'Hai raggiunto il limite per le domande a Skynet.',
    );
    expect(view.querySelectorAll('article')).toHaveLength(1);
  });

  it('i messaggi di errore e la riga delle fonti', () => {
    const failure = (cause: unknown) => new Error('apiFetch failed', { cause });
    expect(chatErrorMessage(failure({ error: 'forbidden' }))).toContain('Acceda di nuovo');
    expect(chatErrorMessage(failure({ error: 'invalid_request' }))).toContain('troppo lunga');
    expect(chatErrorMessage(failure({ error: 'skynet_chat_unavailable' }))).toContain(
      'Non è stato cambiato nulla',
    );
    expect(chatErrorMessage(new TypeError('rete'))).toContain('non è riuscito a rispondere');
    expect(
      metaText({ engine: 'facts', sources: ['diario'], missing: ['firewall di Vercel', 'deploy'] }),
    ).toBe(
      'Solo fatti: nessuna AI raggiungibile in questo momento · Fonti lette: diario · Non lette: firewall di Vercel, deploy',
    );
    expect(metaText({ engine: 'reserve', sources: [], missing: [] })).toBe(
      'Risposta della riserva AI (Claude non era raggiungibile)',
    );
  });
});

function overview(overrides: Partial<SkynetOverview> = {}): SkynetOverview {
  return {
    status: 'calm',
    lastRunAt: new Date().toISOString(),
    incidentSince: null,
    incidentKeys: [],
    signals: null,
    configured: { vercel: true, telegramRecipients: 1, ai: true },
    events: [],
    autodefense: {
      mode: 'active',
      pausedUntil: null,
      watching: { firewall: true, aiBots: true, rules: 4 },
      standDown: [],
      failing: [],
      restoredLastHour: 0,
    },
    ...overrides,
  };
}

describe('pannello Skynet: autodifesa e chat', () => {
  it('la riga dell’autodifesa, in ogni stato', () => {
    const base = overview().autodefense;
    if (!base) throw new Error('manca');
    expect(autodefenseText(overview())).toBe(
      'Attiva · riaccende da sola firewall, blocco delle AI e 4 regole Skynet',
    );
    expect(
      autodefenseText(
        overview({
          autodefense: {
            ...base,
            watching: { firewall: false, aiBots: false, rules: 0 },
          },
        }),
      ),
    ).toBe('Attiva · sta imparando cosa è acceso');
    expect(
      autodefenseText(
        overview({
          autodefense: {
            ...base,
            restoredLastHour: 2,
            standDown: ['firewall'],
            failing: ['skynet-rules'],
          },
        }),
      ),
    ).toBe(
      "Attiva · riaccende da sola firewall, blocco delle AI e 4 regole Skynet · 2 ripristini nell'ultima ora · ferma su firewall: qualcuno continua a spegnere · non riesce a riaccendere regole Skynet: va fatto a mano",
    );
    expect(
      autodefenseText(
        overview({
          autodefense: { ...base, mode: 'paused', pausedUntil: '2026-11-20T14:30:00.000Z' },
        }),
      ),
    ).toMatch(
      /^In pausa fino al 20\/11\/(20)?26, 15:30: il proprietario la riprende scrivendo «riprendi autodifesa»/,
    );
    expect(autodefenseText(overview({ autodefense: { ...base, mode: 'disabled' } }))).toContain(
      'Spenta (SKYNET_AUTODEFENSE=off)',
    );
    // Risposte di prima dell'autodifesa: il campo manca.
    expect(autodefenseText(overview({ autodefense: undefined }))).toBe('—');
  });

  it('il pannello mostra autodifesa, chat e gli eventi «Autodifesa» del diario', async () => {
    mocks.apiFetch.mockResolvedValue(
      overview({
        events: [
          {
            id: 'e1',
            at: new Date().toISOString(),
            kind: 'defense',
            severity: 'warning',
            title: 'Autodifesa: ho riacceso il firewall di Vercel',
            report: 'Questa protezione era spenta.',
            keys: ['firewall-off'],
            notified: 1,
          },
        ],
      }),
    );
    const view = await mount(<SkynetPanel />);
    const text = view.textContent ?? '';
    expect(text).toContain('Chiedi a Skynet');
    expect(text).toContain(
      'Attiva · riaccende da sola firewall, blocco delle AI e 4 regole Skynet',
    );
    expect(text).toContain('Autodifesa · adesso · inviato su Telegram');
    expect(text).toContain('Autodifesa: ho riacceso il firewall di Vercel');
    // La chat sta subito sotto lo stato, prima dei dettagli.
    const status = view.querySelector('output');
    const chat = view.querySelector('section');
    const facts = view.querySelector('dl');
    expect(status && chat && facts).toBeTruthy();
    expect(
      (status as Element).compareDocumentPosition(chat as Element) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      (chat as Element).compareDocumentPosition(facts as Element) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('un comando dalla chat fa rileggere subito lo stato al pannello', async () => {
    mocks.apiFetch.mockImplementation(async (path: string) =>
      path === '/api/admin/skynet'
        ? overview()
        : answer('Fatto: autodifesa in pausa.', { engine: 'command', sources: [] }),
    );
    const view = await mount(<SkynetPanel />);
    const reads = () =>
      mocks.apiFetch.mock.calls.filter(([path]) => path === '/api/admin/skynet').length;
    expect(reads()).toBe(1);
    await ask(view, 'pausa autodifesa 2 ore');
    expect(reads()).toBe(2);
  });

  it('se lo stato non si carica la chat resta: si può chiedere lo stesso', async () => {
    mocks.apiFetch.mockImplementation(async (path: string) => {
      if (path === '/api/admin/skynet') throw new Error('rete');
      return answer('Non riesco a leggere lo stato, ma il diario dice…');
    });
    const view = await mount(<SkynetPanel />);
    expect(view.querySelector('[role="alert"]')?.textContent).toContain('non è disponibile');
    expect(view.querySelector('output')).toBeNull();
    await ask(view, 'cosa succede?');
    expect(view.textContent).toContain('Non riesco a leggere lo stato, ma il diario dice…');
  });
});
