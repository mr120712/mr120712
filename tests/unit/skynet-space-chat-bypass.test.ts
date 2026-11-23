// @polsia:user-owned
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { bypassState, ensureSpaceChatBypass } from '@/lib/skynet/space-chat-bypass.server';

const access = { token: 't'.repeat(24), projectId: 'prj_abcdefgh12', teamId: 'team_abcdefgh12' };
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('bypass /api/space-chat', () => {
  it('riconosce la regola nostra, una altrui o nessuna', () => {
    const ours = {
      rules: [
        {
          domain: 'solcomusic.online',
          conditionGroup: [
            { conditions: [{ type: 'path', op: 'pre', value: '/api/space-chat/' }] },
          ],
        },
      ],
    };
    const other = {
      rules: [
        {
          domain: 'solcomusic.online',
          conditionGroup: [{ conditions: [{ type: 'user_agent', op: 'eq', value: 'x' }] }],
        },
      ],
    };
    expect(bypassState(ours, 'solcomusic.online')).toBe('ours');
    expect(bypassState(other, 'solcomusic.online')).toBe('other');
    expect(bypassState({ rules: [] }, 'solcomusic.online')).toBe('none');
    expect(bypassState(other, 'www.solcomusic.online')).toBe('none');
  });

  it('crea la regola se manca, con dominio, percorso e squadra giusti', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json(200, { rules: [] }))
      .mockResolvedValueOnce(json(200, { ok: true }));
    expect(await ensureSpaceChatBypass(access, fetchImpl)).toEqual({ outcome: 'created' });
    const [url, init] = fetchImpl.mock.calls[1] ?? [];
    expect(String(url)).toContain(
      '/v1/security/firewall/bypass/rules?projectId=prj_abcdefgh12&teamId=team_abcdefgh12',
    );
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      domain: 'solcomusic.online',
      conditionGroup: [{ conditions: [{ type: 'path', op: 'pre', value: '/api/space-chat/' }] }],
    });
  });

  it('non tocca nulla se c’è già (nostra o altrui) e segnala gli errori', async () => {
    const ours = vi.fn().mockResolvedValue(
      json(200, [
        {
          domain: 'solcomusic.online',
          conditionGroup: [{ conditions: [{ value: '/api/space-chat/' }] }],
        },
      ]),
    );
    expect(await ensureSpaceChatBypass(access, ours)).toEqual({ outcome: 'present' });
    expect(ours).toHaveBeenCalledTimes(1);
    const other = vi
      .fn()
      .mockResolvedValue(
        json(200, [
          { domain: 'solcomusic.online', conditionGroup: [{ conditions: [{ value: '/x' }] }] },
        ]),
      );
    expect(await ensureSpaceChatBypass(access, other)).toEqual({ outcome: 'conflict' });
    expect(other).toHaveBeenCalledTimes(1);
    expect(
      await ensureSpaceChatBypass(
        access,
        vi
          .fn()
          .mockResolvedValue(
            json(403, { error: { code: 'forbidden', message: `no ${'t'.repeat(24)}` } }),
          ),
      ),
    ).toEqual({ outcome: 'failed', detail: 'GET 403 forbidden: no ***' });
    expect(
      await ensureSpaceChatBypass(access, vi.fn().mockRejectedValue(new Error('net'))),
    ).toMatchObject({ outcome: 'failed' });
  });
});
