// @polsia:user-owned
// @vitest-environment node
//
// «Skynet», il cacciatore potenziato (src/lib/skynet/hunter.ts): sonde da scanner al primo blocco,
// tentativi a raffica al secondo; chi attacca durante la verifica sale di livello (24 ore → 7 → 30
// giorni); IPv6 per rete /64; regole manuali (anche CIDR) mai toccate; tetti di sicurezza; istanti
// del registro di Vercel in UTC; indirizzi sempre mascherati nei testi.
import { describe, expect, it } from 'vitest';
import {
  apiTimestamp,
  type FirewallBlock,
  HUNT_WAVE,
  huntIsNotable,
  huntReport,
  huntSubject,
  huntTitle,
  type IpRule,
  isPublicIpLike,
  levelDurationMs,
  levelLabel,
  MAX_NEW_PER_RUN,
  MAX_SKYNET_IP_RULES,
  maskIp,
  noteExpiry,
  parseFirewallBlocks,
  parseIpRules,
  parseSkynetNote,
  planHunt,
  skynetNote,
} from '@/lib/skynet/hunter';

const NOW = new Date('2026-11-17T22:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SCANNER = 'Skynet · sonde e scanner';
const LOGIN = 'Accesso: limite tentativi';
const SMS = 'Skynet · SMS, registrazioni e recupero';

const block = (
  ip: string,
  ruleName = SCANNER,
  count = 1,
  startedAt: number | null = NOW.getTime() - 2 * HOUR,
): FirewallBlock => ({ ip, ruleName, count, startedAt });

const rule = (id: string, ip: string, notes: string | null, action = 'challenge'): IpRule => ({
  id,
  ip,
  hostname: '*',
  action,
  notes,
});

/** Regola Skynet cominciata `startedAgo` millisecondi fa, al livello dato. */
const skynetRule = (id: string, ip: string, startedAgo: number, level = 1) =>
  rule(id, ip, skynetNote(new Date(NOW.getTime() - startedAgo + levelDurationMs(level)), level));

describe('lettura dei dati di Vercel', () => {
  it('blocchi persistenti: public_ip o publicIp, istante UTC di Vercel', () => {
    expect(
      parseFirewallBlocks({
        actions: [
          {
            public_ip: '203.0.113.7',
            ruleName: SCANNER,
            count: 2,
            action: 'deny',
            startTime: '2026-11-17 21:14:06.152',
          },
          { publicIp: '198.51.100.9', ruleName: LOGIN },
          { ruleName: SCANNER },
          'rumore',
        ],
      }),
    ).toEqual([
      {
        ip: '203.0.113.7',
        ruleName: SCANNER,
        count: 2,
        startedAt: Date.parse('2026-11-17T21:14:06.152Z'),
      },
      { ip: '198.51.100.9', ruleName: LOGIN, count: 1, startedAt: null },
    ]);
    expect(parseFirewallBlocks(null)).toEqual([]);
    expect(apiTimestamp(1794954486157)).toBe(1794954486157);
    expect(apiTimestamp('1794954486157')).toBe(1794954486157);
    expect(apiTimestamp('2026-11-17T21:14:06+01:00')).toBe(Date.parse('2026-11-17T20:14:06Z'));
    expect(apiTimestamp('ieri')).toBeNull();
  });

  it('regole IP del firewall attivo, con l’host', () => {
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
          { id: 'ip_2', ip: '198.51.100.0/24', action: 'deny', hostname: 'solcomusic.online' },
          { ip: 'senza-id' },
        ],
      }),
    ).toEqual([
      { id: 'ip_1', ip: '203.0.113.7', hostname: '*', action: 'challenge', notes: skynetNote(NOW) },
      {
        id: 'ip_2',
        ip: '198.51.100.0/24',
        hostname: 'solcomusic.online',
        action: 'deny',
        notes: null,
      },
    ]);
  });

  it('la nota Skynet porta scadenza e livello; le note manuali no', () => {
    expect(skynetNote(NOW)).toBe('Skynet · verifica fino al 2026-11-17T22:00:00.000Z');
    expect(skynetNote(NOW, 2)).toBe(
      'Skynet · verifica fino al 2026-11-17T22:00:00.000Z · livello 2',
    );
    expect(parseSkynetNote(skynetNote(NOW, 3))).toEqual({ expiresAt: NOW, level: 3 });
    expect(parseSkynetNote(skynetNote(NOW))).toEqual({ expiresAt: NOW, level: 1 });
    expect(noteExpiry(skynetNote(NOW, 2))?.toISOString()).toBe(NOW.toISOString());
    expect(parseSkynetNote('bloccato a mano')).toBeNull();
    expect(parseSkynetNote(null)).toBeNull();
    expect(parseSkynetNote('Skynet · verifica fino al domani')).toBeNull();
    expect([1, 2, 3].map(levelLabel)).toEqual(['24 ore', '7 giorni', '30 giorni']);
    expect(levelDurationMs(9)).toBe(30 * DAY);
  });
});

describe('chi va in verifica', () => {
  it('una sonda da scanner basta al primo blocco; un tentativo d’accesso a raffica no, due sì', () => {
    const plan = planHunt(
      [
        block('203.0.113.7'),
        block('198.51.100.1', LOGIN),
        block('198.51.100.2', LOGIN),
        block('198.51.100.2', LOGIN),
      ],
      [],
      NOW,
    );
    expect(plan.challenge).toEqual([
      { ip: '198.51.100.2', offenses: 2, reasons: { 'tentativi di accesso a raffica': 2 } },
      { ip: '203.0.113.7', offenses: 1, reasons: { 'sonde da scanner': 1 } },
    ]);
    expect(plan.escalate).toEqual([]);
    expect(plan.release).toEqual([]);
  });

  it('regole diverse si sommano; i limiti di traffico generici non contano mai', () => {
    const plan = planHunt(
      [
        block('203.0.113.9', SMS),
        block('203.0.113.9', LOGIN),
        block('198.51.100.1', 'Limite richieste API per IP', 9),
      ],
      [],
      NOW,
    );
    expect(plan.challenge).toEqual([
      {
        ip: '203.0.113.9',
        offenses: 2,
        reasons: {
          'abuso di SMS, registrazioni o recupero password': 1,
          'tentativi di accesso a raffica': 1,
        },
      },
    ]);
  });

  it('IPv6: tutta la rete /64, sommando i blocchi dei suoi indirizzi', () => {
    const plan = planHunt(
      [
        block('2001:db8:85a3:7::1', LOGIN),
        block('2001:db8:85a3:7:ffff::2', LOGIN),
        block('2001:db8:85a3:8::1', LOGIN),
      ],
      [],
      NOW,
    );
    expect(plan.challenge).toEqual([
      {
        ip: '2001:db8:85a3:7::/64',
        offenses: 2,
        reasons: { 'tentativi di accesso a raffica': 2 },
      },
    ]);
    expect(huntSubject('2001:0db8:0000:0007:0000:0000:0000:0001')).toBe('2001:db8:0:7::/64');
    expect(huntSubject('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(huntSubject('fe80::1')).toBeNull();
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
        'fe80::1',
        '::ffff:10.0.0.1',
      ].map((ip) => block(ip)),
      [],
      NOW,
    );
    expect(plan.challenge).toEqual([]);
    expect(isPublicIpLike('2001:db8::7')).toBe(true);
    expect(isPublicIpLike('non-un-ip')).toBe(false);
    expect(isPublicIpLike('2001:db8::1::2')).toBe(false);
  });

  it('già coperti da una regola (Skynet o manuale, anche come rete CIDR): nessun doppione', () => {
    const plan = planHunt(
      [
        block('203.0.113.7', SCANNER, 1, NOW.getTime() - 2 * HOUR),
        block('198.51.100.9'),
        block('2001:db8:aaaa:1::5'),
      ],
      [
        skynetRule('ip_s', '203.0.113.7', 30 * MINUTE),
        rule('ip_m', '198.51.100.0/24', 'rete bloccata a mano', 'deny'),
        rule('ip_6', '2001:db8:aaaa::/48', null, 'deny'),
      ],
      NOW,
    );
    // Il blocco di 203.0.113.7 è di prima della verifica: niente prolungamento.
    expect(plan.challenge).toEqual([]);
    expect(plan.escalate).toEqual([]);
    expect(plan.active).toBe(1);
  });
});

describe('chi attacca durante la verifica', () => {
  const during = block('203.0.113.7', SCANNER, 1, NOW.getTime() - 10 * MINUTE);

  it('sale di livello: 24 ore → 7 giorni → 30 giorni, poi i 30 giorni si rinnovano', () => {
    for (const [level, next] of [
      [1, 2],
      [2, 3],
      [3, 3],
    ] as const) {
      const plan = planHunt([during], [skynetRule('ip_s', '203.0.113.7', HOUR, level)], NOW);
      expect(plan.escalate).toEqual([
        {
          rule: expect.objectContaining({ id: 'ip_s' }),
          level: next,
          offenses: 1,
          reasons: { 'sonde da scanner': 1 },
        },
      ]);
      expect(plan.challenge).toEqual([]);
      expect(plan.release).toEqual([]);
      expect(plan.long).toBe(1);
    }
  });

  it('scaduta ma ancora all’attacco: sale di livello invece di sparire', () => {
    const plan = planHunt(
      [block('203.0.113.1', SCANNER, 1, NOW.getTime() - 2 * HOUR)],
      [skynetRule('ip_old', '203.0.113.1', DAY + MINUTE)],
      NOW,
    );
    expect(plan.release).toEqual([]);
    expect(plan.escalate.map((step) => [step.rule.id, step.level])).toEqual([['ip_old', 2]]);
  });

  it('scaduta senza nuovi attacchi si toglie; le regole manuali mai, neanche se vecchie', () => {
    const plan = planHunt(
      [],
      [
        skynetRule('ip_old', '203.0.113.1', DAY + MINUTE),
        skynetRule('ip_new', '203.0.113.2', HOUR),
        rule('ip_man', '203.0.113.3', 'messa a mano nel 2025', 'deny'),
      ],
      NOW,
    );
    expect(plan.release.map((r) => r.id)).toEqual(['ip_old']);
    expect(plan.active).toBe(1);
    expect(plan.long).toBe(0);
  });

  it('rete IPv6 /64 in verifica: conta ogni suo indirizzo', () => {
    const plan = planHunt(
      [block('2001:db8:1:2::99', LOGIN, 1, NOW.getTime() - 10 * MINUTE)],
      [skynetRule('ip_n', '2001:db8:1:2::/64', HOUR)],
      NOW,
    );
    expect(plan.escalate.map((step) => step.level)).toEqual([2]);
  });

  it('una regola Skynet cambiata a mano (azione diversa da «challenge») diventa del proprietario', () => {
    const owned = rule('ip_o', '203.0.113.7', skynetNote(new Date(NOW.getTime() - HOUR)), 'deny');
    const plan = planHunt([during], [owned], NOW);
    expect(plan.escalate).toEqual([]);
    expect(plan.release).toEqual([]);
    expect(plan.challenge).toEqual([]);
    expect(plan.active).toBe(0);
  });

  it('le regole manuali non salgono mai di livello', () => {
    const plan = planHunt([during], [rule('ip_m', '203.0.113.7', 'bloccato a mano', 'deny')], NOW);
    expect(plan.escalate).toEqual([]);
    expect(plan.challenge).toEqual([]);
  });
});

describe('tetti di sicurezza', () => {
  it(`al massimo ${MAX_NEW_PER_RUN} nuove per giro e ${MAX_SKYNET_IP_RULES} attive; i prolungamenti non occupano posti`, () => {
    const many = Array.from({ length: MAX_NEW_PER_RUN + 5 }, (_, i) => block(`203.0.113.${i + 1}`));
    const plan = planHunt(many, [], NOW);
    expect(plan.challenge).toHaveLength(MAX_NEW_PER_RUN);
    expect(plan.queued).toBe(5);
    expect(plan.capped).toBe(0);

    const full = Array.from({ length: MAX_SKYNET_IP_RULES }, (_, i) =>
      skynetRule(`ip_${i}`, `198.51.100.${i + 1}`, HOUR),
    );
    const blocked = planHunt([block('203.0.113.200')], full, NOW);
    expect(blocked.challenge).toEqual([]);
    expect(blocked.queued).toBe(0);
    expect(blocked.capped).toBe(1);

    const longer = planHunt(
      [block('198.51.100.1', SCANNER, 1, NOW.getTime() - 10 * MINUTE)],
      full,
      NOW,
    );
    expect(longer.escalate).toHaveLength(1);
    expect(longer.active).toBe(MAX_SKYNET_IP_RULES);
  });
});

describe('testi', () => {
  it('indirizzi e reti sempre mascherati', () => {
    expect(maskIp('203.0.113.77')).toBe('203.0.x.x');
    expect(maskIp('2001:db8:85a3::8a2e:370:7334')).toBe('2001:db8:…');
    expect(maskIp('2001:db8:85a3:7::/64')).toBe('2001:db8:…/64');
  });

  it('su Telegram solo prolungamenti, errori, ondate e tetto; la routine resta nel diario', () => {
    const quiet = { challenged: 1, escalated: 0, failed: 0, capped: 0 };
    expect(huntIsNotable(quiet)).toBe(false);
    expect(huntIsNotable({ ...quiet, challenged: HUNT_WAVE })).toBe(true);
    expect(huntIsNotable({ ...quiet, escalated: 1 })).toBe(true);
    expect(huntIsNotable({ ...quiet, failed: 1 })).toBe(true);
    expect(huntIsNotable({ ...quiet, capped: 1 })).toBe(true);
  });

  it('titoli dell’avviso', () => {
    expect(huntTitle(1, 0)).toBe('1 indirizzo rimandato alla verifica per 24 ore');
    expect(huntTitle(3, 0)).toBe('3 indirizzi rimandati alla verifica per 24 ore');
    expect(huntTitle(0, 1)).toBe('1 verifica prolungata: attaccavano anche durante la verifica');
    expect(huntTitle(2, 2)).toBe(
      '2 indirizzi rimandati alla verifica per 24 ore; 2 verifiche prolungate',
    );
    expect(huntTitle(0, 0, 1)).toBe('Il cacciatore non è riuscito ad applicare 1 regola');
  });

  it('il rapporto dice chi, perché, per quanto e come togliere una regola prima', () => {
    const text = huntReport({
      challenged: [
        { ip: '203.0.113.77', offenses: 1, reasons: { 'sonde da scanner': 1 } },
        {
          ip: '2001:db8:85a3:7::/64',
          offenses: 2,
          reasons: { 'tentativi di accesso a raffica': 2 },
        },
      ],
      escalated: [
        {
          rule: skynetRule('ip_s', '198.51.100.23', HOUR),
          level: 2,
          offenses: 3,
          reasons: { 'sonde da scanner': 3 },
        },
      ],
      failed: 1,
      queued: 4,
      capped: 2,
    });
    expect(text).toContain('- 203.0.x.x: sonde da scanner ×1 → verifica per 24 ore');
    expect(text).toContain(
      '- 2001:db8:…/64: tentativi di accesso a raffica ×2 → verifica per 24 ore (tutta la rete IPv6 /64)',
    );
    expect(text).toContain(
      '- 198.51.x.x: ancora all’attacco durante la verifica (sonde da scanner ×3) → prolungata a 7 giorni',
    );
    expect(text).toContain('1 non applicato');
    expect(text).toContain(
      '- 4 in coda: entrano nei prossimi minuti (al massimo 10 nuove regole al minuto).',
    );
    expect(text).toContain('- 2 in attesa: raggiunto il tetto di sicurezza delle regole Skynet.');
    expect(text).toContain('(7 giorni, poi 30 giorni)');
    expect(text).toContain('Vercel → progetto → Firewall → IP Blocking');
    expect(text).not.toContain('203.0.113.77');
    expect(text).not.toContain('198.51.100.23');
    expect(text).not.toContain('85a3:7::');
  });
});
