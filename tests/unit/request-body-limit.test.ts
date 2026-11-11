// @polsia:user-owned
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readJsonLimited } from '@/lib/business/request-body.server';

describe('limite del corpo JSON', () => {
  it('distingue JSON valido, malformato e oltre la dimensione massima', async () => {
    const valid = await readJsonLimited(
      new Request('https://solco.test/api/items', { method: 'POST', body: '{"name":"Solco"}' }),
      128,
    );
    const invalid = await readJsonLimited(
      new Request('https://solco.test/api/items', { method: 'POST', body: '{broken' }),
      128,
    );
    const oversized = await readJsonLimited(
      new Request('https://solco.test/api/items', { method: 'POST', body: 'x'.repeat(129) }),
      128,
    );

    expect(valid).toEqual({ ok: true, value: { name: 'Solco' } });
    expect(invalid).toEqual({ ok: false, status: 400, error: 'invalid_json' });
    expect(oversized).toEqual({ ok: false, status: 413, error: 'payload_too_large' });
  });
});
