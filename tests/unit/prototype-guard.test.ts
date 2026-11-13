// @polsia:user-owned
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readJsonLimited } from '@/lib/business/request-body.server';
import {
  hardenGlobalPrototypes,
  prototypesHardened,
  safeJsonParse,
  sanitizePrototypePollution,
} from '@/lib/security/prototype-guard';

// Fusione ricorsiva "ingenua" tipica, vulnerabile al prototype pollution se la sorgente ha __proto__.
function naiveMerge(target: Record<string, unknown>, source: Record<string, unknown>) {
  for (const key in source) {
    const value = source[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (typeof target[key] !== 'object' || target[key] === null) target[key] = {};
      naiveMerge(target[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      target[key] = value;
    }
  }
}

describe('sanitizePrototypePollution', () => {
  it('rimuove __proto__/constructor/prototype in profondità e tiene le chiavi legittime', () => {
    const dirty = JSON.parse(
      '{"a":1,"__proto__":{"polluted":true},"nested":{"b":2,"constructor":{"x":1}},"list":[{"prototype":9,"c":3}]}',
    );
    const clean = sanitizePrototypePollution(dirty) as Record<string, unknown>;
    expect(clean).toEqual({ a: 1, nested: { b: 2 }, list: [{ c: 3 }] });
    expect(Object.getOwnPropertyNames(clean)).not.toContain('__proto__');
  });

  it('una fusione ingenua del dato sanificato NON inquina Object.prototype', () => {
    const malicious = JSON.parse('{"__proto__":{"polluted":true}}');
    naiveMerge({}, sanitizePrototypePollution(malicious) as Record<string, unknown>);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('passa invariati array e primitivi', () => {
    expect(sanitizePrototypePollution([1, 2, 3])).toEqual([1, 2, 3]);
    expect(sanitizePrototypePollution('ciao')).toBe('ciao');
    expect(sanitizePrototypePollution(42)).toBe(42);
    expect(sanitizePrototypePollution(null)).toBeNull();
  });
});

describe('safeJsonParse', () => {
  it('scarta le chiavi pericolose durante il parsing', () => {
    const value = safeJsonParse('{"a":1,"__proto__":{"polluted":true},"constructor":5}') as Record<
      string,
      unknown
    >;
    expect(value).toEqual({ a: 1 });
  });

  it('parsa normalmente il JSON legittimo', () => {
    expect(safeJsonParse('{"title":"x","n":[1,2]}')).toEqual({ title: 'x', n: [1, 2] });
  });
});

describe('hardenGlobalPrototypes', () => {
  it('congela i target indicati (senza toccare i globali reali nel test)', () => {
    const dummy = { a: 1 };
    hardenGlobalPrototypes([dummy]);
    expect(Object.isFrozen(dummy)).toBe(true);
    expect(() => {
      (dummy as Record<string, unknown>).b = 2;
    }).toThrow();
    expect(prototypesHardened()).toBe(true);
  });

  it('è idempotente e non lancia su target già congelati', () => {
    const dummy = Object.freeze({});
    expect(() => hardenGlobalPrototypes([dummy])).not.toThrow();
  });
});

describe('readJsonLimited (integrazione)', () => {
  function jsonRequest(body: string) {
    return new Request('https://solco.example/api/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
  }

  it('restituisce il corpo SENZA le chiavi pericolose', async () => {
    const result = await readJsonLimited(
      jsonRequest('{"a":1,"__proto__":{"polluted":true}}'),
      10_000,
    );
    expect(result).toEqual({ ok: true, value: { a: 1 } });
  });

  it('corpo JSON non valido → errore 400', async () => {
    const result = await readJsonLimited(jsonRequest('{non valido'), 10_000);
    expect(result).toMatchObject({ ok: false, status: 400 });
  });
});
