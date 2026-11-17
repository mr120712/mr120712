// @polsia:user-owned
// @vitest-environment node
//
// «Skynet», il cacciatore (src/lib/skynet/hunter.ts): solo i recidivi (2 blocchi in 24 ore) di
// regole da hacker vanno alla verifica; le regole manuali non si toccano; le regole Skynet scadute
// si tolgono; tetti di sicurezza; indirizzi sempre mascherati nei testi.
import { describe, expect, it } from 'vitest';
import {
  type FirewallBlock,
  huntReport,
  type IpRule,
  isPublicIpLike,
  MAX_NEW_PER_RUN,
  MAX_SKYNET_IP_RULES,
  maskIp,
  noteExpiry,
  parseFirewallBlocks,
  parseIpRules,
  planHunt,
  skynetNote,
} from '@/lib/skynet/hunter';

const NOW = new Date('2026-11-17T22:00:00.000Z');
const SCANNER = 'Skynet · sonde e scanner';
const LOGIN = 'Accesso: limite tentativi';
const SMS = 'Skynet · SMS, registrazioni e recupero';

const block = (ip: string, ruleName = SCANNER, count = 1): FirewallBlock => ({
  ip,
  ruleName,
  count,
});

describe('lettura dei dati di Vercel', () => {
  it('blocchi persistenti: accetta public_ip (risposta vera) e publicIp (SDK)', () => {
    expect(
      parseFirewallBlocks({
        actions: [
          { public_ip: '203.0.113.7', ruleName: SCANNER, count: 2, action: 'deny' },
          { publicIp: '198.51.100.9', ruleName: LOGIN },
          { ruleName: SCANNER },
          'rumore',
        ],
      }),
    ).toEqual([block('203.0.113.7', SCANNER, 2), block('198.51.100.9', LOGIN, 1)]);
    expect(parseFirewallBlocks(null)).toEqual([]);
  });

  it('regole IP del firewall attivo', () => {
    expect(
      parseIpRules({
        ips: [
          {
            id: 'ip_1',
            ip: '203.0.113.7',
            action: 'challenge',
            notes: skynetNote(NOW),
            hostname: '*',
          },
          { id: 'ip_2', ip: '198.51.100.9', action: 'deny', hostname: '*' },
          { ip: 'senza-id' },
        ],
      }),
    ).toEqual([
      { id: 'ip_1', ip: '203.0.113.7', action: 'challenge', notes: skynetNote(NOW) },
      { id: 'ip_2', ip: '198.51.100.9', action: 'deny', notes: null },
    ]);
  });

  it('la nota Skynet porta la scadenza; le note manuali no', () => {
    expect(noteExpiry(skynetNote(NOW))?.toISOString()).toBe(NOW.toISOString());
    expect(noteExpiry('bloccato a mano')).toBeNull();
    expect(noteExpiry(null)).toBeNull();
  });
});

describe('planHunt', () => {
  it('due blocchi in 24 ore → verifica; uno solo → niente', () => {
    const plan = planHunt(
      [block('203.0.113.7'), block('203.0.113.7', LOGIN), block('203.0.113.8')],
      [],
      NOW,
    );
    expect(plan.challenge).toEqual([
      {
        ip: '203.0.113.7',
        offenses: 2,
        reasons: { 'sonde da scanner': 1, 'tentativi di accesso a raffica': 1 },
      },
    ]);
    expect(plan.release).toEqual([]);
  });

  it('un blocco con conteggio 3 basta; i limiti di traffico generici non contano', () => {
    const plan = planHunt(
      [block('203.0.113.9', SMS, 3), block('198.51.100.1', 'Limite richieste API per IP', 9)],
      [],
      NOW,
    );
    expect(plan.challenge.map((o) => o.ip)).toEqual(['203.0.113.9']);
  });

  it('mai una regola su reti private, loopback o CGNAT', () => {
    const plan = planHunt(
      [
        '10.0.0.1',
        '192.168.1.5',
        '172.20.0.1',
        '100.64.3.2',
        '127.0.0.1',
        '::1',
        'fd00::1',
      ].flatMap((ip) => [block(ip), block(ip)]),
      [],
      NOW,
    );
    expect(plan.challenge).toEqual([]);
    expect(isPublicIpLike('2001:db8::7')).toBe(true);
    expect(isPublicIpLike('non-un-ip')).toBe(false);
  });

  it('indirizzi già coperti da una regola (Skynet o manuale) non si duplicano', () => {
    const rules: IpRule[] = [
      {
        id: 'ip_s',
        ip: '203.0.113.7',
        action: 'challenge',
        notes: skynetNote(new Date(NOW.getTime() + 3_600_000)),
      },
      { id: 'ip_m', ip: '198.51.100.9', action: 'deny', notes: null },
    ];
    const plan = planHunt(
      [block('203.0.113.7'), block('203.0.113.7'), block('198.51.100.9'), block('198.51.100.9')],
      rules,
      NOW,
    );
    expect(plan.challenge).toEqual([]);
    expect(plan.active).toBe(1);
  });

  it('le regole Skynet scadute si tolgono, quelle manuali mai (anche se vecchie)', () => {
    const rules: IpRule[] = [
      {
        id: 'ip_old',
        ip: '203.0.113.1',
        action: 'challenge',
        notes: skynetNote(new Date(NOW.getTime() - 1)),
      },
      {
        id: 'ip_new',
        ip: '203.0.113.2',
        action: 'challenge',
        notes: skynetNote(new Date(NOW.getTime() + 1)),
      },
      { id: 'ip_man', ip: '203.0.113.3', action: 'deny', notes: 'messa a mano nel 2025' },
    ];
    const plan = planHunt([], rules, NOW);
    expect(plan.release.map((r) => r.id)).toEqual(['ip_old']);
    expect(plan.active).toBe(1);
  });

  it(`tetti di sicurezza: al massimo ${MAX_NEW_PER_RUN} nuove per giro e ${MAX_SKYNET_IP_RULES} attive`, () => {
    const many = Array.from({ length: MAX_NEW_PER_RUN + 5 }, (_, i) => `203.0.113.${i + 1}`);
    const plan = planHunt(
      many.flatMap((ip) => [block(ip), block(ip)]),
      [],
      NOW,
    );
    expect(plan.challenge).toHaveLength(MAX_NEW_PER_RUN);
    expect(plan.capped).toBe(5);

    const full: IpRule[] = Array.from({ length: MAX_SKYNET_IP_RULES }, (_, i) => ({
      id: `ip_${i}`,
      ip: `198.51.100.${i + 1}`,
      action: 'challenge',
      notes: skynetNote(new Date(NOW.getTime() + 3_600_000)),
    }));
    const blocked = planHunt([block('203.0.113.200'), block('203.0.113.200')], full, NOW);
    expect(blocked.challenge).toEqual([]);
    expect(blocked.capped).toBe(1);
  });
});

describe('testi', () => {
  it('indirizzi sempre mascherati', () => {
    expect(maskIp('203.0.113.77')).toBe('203.0.x.x');
    expect(maskIp('2001:db8:85a3::8a2e:370:7334')).toBe('2001:db8:…');
  });

  it('il rapporto dice chi, perché, per quanto e come togliere la regola prima', () => {
    const text = huntReport(
      [{ ip: '203.0.113.77', offenses: 3, reasons: { 'sonde da scanner': 3 } }],
      1,
      2,
    );
    expect(text).toContain('- 203.0.x.x: sonde da scanner ×3');
    expect(text).toContain('1 non applicato');
    expect(text).toContain('2 in attesa');
    expect(text).toContain('Per 24 ore');
    expect(text).toContain('Vercel → progetto → Firewall → IP Blocking');
    expect(text).not.toContain('203.0.113.77');
  });
});
