// @polsia:user-owned — webhookUpdatesOk: il webhook registrato copre message + callback_query?
// Serve a far ri-registrare il webhook (auto-riparazione) quando i tap sui pulsanti non arrivano.
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/env', () => ({ env: { TELEGRAM_BOT_TOKEN: 'tok' } }));
vi.mock('@/lib/site', () => ({ siteUrl: 'https://solco.test' }));

import { WEBHOOK_ALLOWED_UPDATES, webhookUpdatesOk } from '@/lib/business/telegram-bot.server';

describe('webhookUpdatesOk', () => {
  it('assente/non-lista → true (default Telegram = tutti gli update)', () => {
    expect(webhookUpdatesOk(undefined)).toBe(true);
    expect(webhookUpdatesOk(null)).toBe(true);
    expect(webhookUpdatesOk('message')).toBe(true);
  });

  it('lista che contiene message + callback_query → true (anche con extra)', () => {
    expect(webhookUpdatesOk(['message', 'callback_query'])).toBe(true);
    expect(webhookUpdatesOk(['callback_query', 'message', 'edited_message'])).toBe(true);
  });

  it('lista a cui manca callback_query (o message) → false', () => {
    expect(webhookUpdatesOk(['message'])).toBe(false);
    expect(webhookUpdatesOk(['callback_query'])).toBe(false);
    expect(webhookUpdatesOk([])).toBe(false);
  });

  it('gli update attesi includono message e callback_query', () => {
    expect([...WEBHOOK_ALLOWED_UPDATES]).toEqual(['message', 'callback_query']);
  });
});
