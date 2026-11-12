// @polsia:user-owned
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  sameOrigin: vi.fn(),
  enforceRateLimit: vi.fn(),
  list: vi.fn(),
  register: vi.fn(),
  del: vi.fn(),
  get: vi.fn(),
  open: vi.fn(),
  chart: vi.fn(),
  publish: vi.fn(),
  report: vi.fn(),
  publicChart: vi.fn(),
  identity: vi.fn(),
}));

vi.mock('@/lib/require-auth', () => ({ requireAuth: mocks.requireAuth }));
vi.mock('@/lib/same-origin', () => ({ sameOrigin: mocks.sameOrigin }));
vi.mock('@/lib/business/rate-limit.server', () => ({
  enforceRateLimit: mocks.enforceRateLimit,
  getRateLimitIdentity: mocks.identity,
}));
vi.mock('@/lib/music/recordings.server', () => {
  class RecordingLimitReached extends Error {}
  class InvalidRecordingSource extends Error {}
  return {
    listRecordings: mocks.list,
    registerRecording: mocks.register,
    deleteRecording: mocks.del,
    getOwnedRecording: mocks.get,
    getStreamableRecording: mocks.get,
    openRecordingStream: mocks.open,
    listRecordingsChart: mocks.chart,
    setRecordingPublished: mocks.publish,
    reportRecording: mocks.report,
    listPublicRecordingsChart: mocks.publicChart,
    RecordingLimitReached,
    InvalidRecordingSource,
  };
});

import { POST as PUBLISH } from '@/app/api/music/recordings/[recordingId]/publish/route';
import { POST as REPORT } from '@/app/api/music/recordings/[recordingId]/report/route';
import { DELETE } from '@/app/api/music/recordings/[recordingId]/route';
import { GET as STREAM } from '@/app/api/music/recordings/[recordingId]/stream/route';
import { GET as PUBLIC_CHART } from '@/app/api/music/recordings/chart/public/route';
import { GET as CHART } from '@/app/api/music/recordings/chart/route';
import { GET as LIST, POST } from '@/app/api/music/recordings/route';
import { InvalidRecordingSource, RecordingLimitReached } from '@/lib/music/recordings.server';

const recId = 'c'.repeat(25);

function postReq(body: unknown) {
  return new Request('https://solco.example/api/music/recordings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
const validBody = {
  title: 'La mia canzone',
  fileKey: 'company_1/private/files/abc.webm',
  mimeType: 'audio/webm',
  byteLength: 1000,
  elapsedSeconds: 12,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.sameOrigin.mockReturnValue(true);
  mocks.identity.mockReturnValue(null);
  mocks.requireAuth.mockResolvedValue({ id: 'user-1' });
  mocks.enforceRateLimit.mockResolvedValue(null);
});

describe('POST /api/music/recordings', () => {
  it('403 se l’origine non combacia', async () => {
    mocks.sameOrigin.mockReturnValue(false);
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(403);
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it('401 se non autenticato', async () => {
    mocks.requireAuth.mockRejectedValue(new Response('no', { status: 401 }));
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(401);
  });

  it('400 con errori di campo su corpo non valido', async () => {
    const res = await POST(postReq({ fileKey: 'k', mimeType: 'audio/webm', byteLength: 1 }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors?: Record<string, string> };
    expect(body.errors?.title).toBeTruthy();
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it('201 con la registrazione salvata', async () => {
    mocks.register.mockResolvedValue({
      id: recId,
      title: 'La mia canzone',
      durationSeconds: 12,
      createdAt: '2026-01-01T00:00:00.000Z',
      published: false,
    });
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      recording: {
        id: recId,
        title: 'La mia canzone',
        durationSeconds: 12,
        createdAt: '2026-01-01T00:00:00.000Z',
        published: false,
      },
    });
    expect(mocks.register).toHaveBeenCalledWith('user-1', expect.objectContaining(validBody));
  });

  it('409 al raggiungimento del tetto', async () => {
    mocks.register.mockRejectedValue(new RecordingLimitReached());
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(409);
  });

  it('400 su audio non valido', async () => {
    mocks.register.mockRejectedValue(new InvalidRecordingSource());
    const res = await POST(postReq(validBody));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors?: Record<string, string> };
    expect(body.errors?.fileKey).toBeTruthy();
  });
});

describe('GET /api/music/recordings', () => {
  it('elenca le registrazioni dell’utente', async () => {
    mocks.list.mockResolvedValue([
      {
        id: recId,
        title: 'Uno',
        durationSeconds: 30,
        createdAt: '2026-02-02T10:00:00.000Z',
        published: false,
      },
    ]);
    const res = await LIST(new Request('https://solco.example/api/music/recordings'));
    expect(res.status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith('user-1');
  });
});

describe('GET /api/music/recordings/chart', () => {
  it('restituisce la classifica ascolti locali', async () => {
    mocks.chart.mockResolvedValue([{ id: recId, title: 'A', durationSeconds: 30, playCount: 7 }]);
    const res = await CHART(new Request('https://solco.example/api/music/recordings/chart'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      items: [{ id: recId, title: 'A', durationSeconds: 30, playCount: 7 }],
    });
    expect(mocks.chart).toHaveBeenCalledWith('user-1');
  });

  it('401 se non autenticato', async () => {
    mocks.requireAuth.mockRejectedValue(new Response('no', { status: 401 }));
    const res = await CHART(new Request('https://solco.example/api/music/recordings/chart'));
    expect(res.status).toBe(401);
  });
});

describe('GET …/[id]/stream', () => {
  const params = Promise.resolve({ recordingId: recId });
  function streamReq() {
    return new Request(`https://solco.example/api/music/recordings/${recId}/stream`);
  }

  it('404 quando la registrazione non è dell’utente', async () => {
    mocks.get.mockResolvedValue(null);
    const res = await STREAM(streamReq(), { params });
    expect(res.status).toBe(404);
    expect(mocks.get).toHaveBeenCalledWith('user-1', recId);
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it('404 su id malformato', async () => {
    const res = await STREAM(streamReq(), { params: Promise.resolve({ recordingId: 'BAD!' }) });
    expect(res.status).toBe(404);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('401 se non autenticato', async () => {
    mocks.requireAuth.mockRejectedValue(new Response('no', { status: 401 }));
    const res = await STREAM(streamReq(), { params });
    expect(res.status).toBe(401);
  });
});

describe('DELETE …/[id]', () => {
  const params = Promise.resolve({ recordingId: recId });
  function delReq() {
    return new Request(`https://solco.example/api/music/recordings/${recId}`, { method: 'DELETE' });
  }

  it('403 se l’origine non combacia', async () => {
    mocks.sameOrigin.mockReturnValue(false);
    const res = await DELETE(delReq(), { params });
    expect(res.status).toBe(403);
    expect(mocks.del).not.toHaveBeenCalled();
  });

  it('404 se niente è stato eliminato', async () => {
    mocks.del.mockResolvedValue(false);
    const res = await DELETE(delReq(), { params });
    expect(res.status).toBe(404);
  });

  it('200 all’eliminazione', async () => {
    mocks.del.mockResolvedValue(true);
    const res = await DELETE(delReq(), { params });
    expect(res.status).toBe(200);
    expect(mocks.del).toHaveBeenCalledWith('user-1', recId);
  });
});

describe('POST …/[id]/publish', () => {
  const params = Promise.resolve({ recordingId: recId });
  function pubReq(body: unknown) {
    return new Request(`https://solco.example/api/music/recordings/${recId}/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('403 se l’origine non combacia', async () => {
    mocks.sameOrigin.mockReturnValue(false);
    const res = await PUBLISH(pubReq({ published: true }), { params });
    expect(res.status).toBe(403);
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it('pubblica e ritorna la registrazione', async () => {
    mocks.publish.mockResolvedValue({
      id: recId,
      title: 'A',
      durationSeconds: 10,
      createdAt: '2026-01-01T00:00:00.000Z',
      published: true,
    });
    const res = await PUBLISH(pubReq({ published: true }), { params });
    expect(res.status).toBe(200);
    expect(mocks.publish).toHaveBeenCalledWith('user-1', recId, true);
  });

  it('404 se non è dell’utente', async () => {
    mocks.publish.mockResolvedValue(null);
    const res = await PUBLISH(pubReq({ published: true }), { params });
    expect(res.status).toBe(404);
  });

  it('400 su body non valido', async () => {
    const res = await PUBLISH(pubReq({ published: 'x' }), { params });
    expect(res.status).toBe(400);
    expect(mocks.publish).not.toHaveBeenCalled();
  });
});

describe('POST …/[id]/report', () => {
  const params = Promise.resolve({ recordingId: recId });
  function repReq() {
    return new Request(`https://solco.example/api/music/recordings/${recId}/report`, {
      method: 'POST',
    });
  }

  it('403 se l’origine non combacia', async () => {
    mocks.sameOrigin.mockReturnValue(false);
    const res = await REPORT(repReq(), { params });
    expect(res.status).toBe(403);
    expect(mocks.report).not.toHaveBeenCalled();
  });

  it('200 sulla segnalazione', async () => {
    mocks.report.mockResolvedValue(true);
    const res = await REPORT(repReq(), { params });
    expect(res.status).toBe(200);
    expect(mocks.report).toHaveBeenCalledWith(recId, 'user-1');
  });

  it('404 se il brano pubblicato non esiste', async () => {
    mocks.report.mockResolvedValue(false);
    const res = await REPORT(repReq(), { params });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/music/recordings/chart/public', () => {
  it('restituisce la classifica community (anonima)', async () => {
    mocks.publicChart.mockResolvedValue([
      { id: recId, title: 'A', durationSeconds: 10, playCount: 4 },
    ]);
    const res = await PUBLIC_CHART(
      new Request('https://solco.example/api/music/recordings/chart/public'),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      items: [{ id: recId, title: 'A', durationSeconds: 10, playCount: 4 }],
    });
  });
});
