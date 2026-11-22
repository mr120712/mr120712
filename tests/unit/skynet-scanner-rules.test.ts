// @polsia:user-owned — le regole anti-scanner di GPT-6: il controllo del codice scarta ciò che il
// firewall non accetta, ciò che colpirebbe Solco e ciò che non serve; l'elenco dei percorsi di Solco
// copre davvero ogni pagina e ogni file pubblico.
// @vitest-environment node
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkRule,
  combinedPattern,
  isScannerRulesCommand,
  MAX_RULES,
  PROBE_SAMPLES,
  parseProposedRules,
  probeCoverage,
  SOLCO_PATHS,
  scannerRulesReply,
} from '@/lib/skynet/scanner-rules';

const rule = (regex: string, nome = 'r') => checkRule({ nome, regex, perche: 'perché' });

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

describe('checkRule', () => {
  it('accetta regole sicure che riconoscono sonde vere', () => {
    const dotfiles = rule('^/(?:api/)?\\.(?:env|git|svn|hg|aws|vscode|ds_store)');
    expect(dotfiles.ok).toBe(true);
    expect(dotfiles.sonde).toBeGreaterThanOrEqual(10);
    expect(rule('\\.php').ok).toBe(true);
    expect(rule('^/wp-(?:admin|login|content|includes)').ok).toBe(true);
  });

  it('scarta ciò che bloccherebbe Solco: /.well-known, json, le API', () => {
    expect(rule('^/\\.').problema).toContain('/.well-known');
    expect(rule('json').problema).toContain('pagina di Solco');
    expect(rule('^/api/').ok).toBe(false);
    expect(rule('admin').problema).toContain('/admin');
  });

  it('scarta la sintassi che il firewall non accetta o che rallenta', () => {
    expect(rule('(?=env)').problema).toContain('lookaround');
    expect(rule('(?<!x)\\.env').problema).toContain('lookaround');
    expect(rule('(env)\\1').problema).toContain('riferimenti');
    expect(rule('(a+)+$').problema).toContain('annidati');
    expect(rule('(\\w*)*').problema).toContain('annidati');
    expect(rule('[').problema).toContain('non valida');
    expect(rule('').ok).toBe(false);
    expect(rule('x'.repeat(201)).ok).toBe(false);
  });

  it('scarta le regole inutili (nessuna sonda)', () => {
    expect(rule('^/qualcosa-che-nessuno-chiede$').problema).toContain('nessuna sonda');
  });
});

describe('risposta di GPT-6 e messaggio per il proprietario', () => {
  it('legge il JSON anche con testo intorno, e al massimo MAX_RULES regole', () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      nome: `n${i}`,
      regex: `^/x${i}`,
      perche: 'p',
    }));
    expect(parseProposedRules(`Ecco: ${JSON.stringify({ regole: many })} fine`)).toHaveLength(
      MAX_RULES,
    );
    expect(parseProposedRules('nessun json')).toEqual([]);
    expect(parseProposedRules('{"regole": "no"}')).toEqual([]);
    expect(parseProposedRules('{"rules":[{"regex":"\\\\.php"}]}')[0]).toMatchObject({
      regex: '\\.php',
    });
  });

  it('unisce le valide, conta la copertura e spiega dove incollarle', () => {
    const checked = [
      rule('\\.php', 'PHP'),
      rule('^/\\.(?:env|git)', 'File nascosti'),
      rule('^/\\.', 'Troppo ampia'),
    ];
    const combined = combinedPattern(checked);
    expect(combined).toBe('(?:\\.php|^/\\.(?:env|git))');
    expect(probeCoverage(checked)).toBeGreaterThan(10);
    const reply = scannerRulesReply(checked, 'gpt-6.2-sol');
    expect(reply).toContain('2 superano i controlli');
    expect(reply).toContain('Troppo ampia: colpirebbe una pagina di Solco (/.well-known');
    expect(reply).toContain('Matches regex');
    expect(reply).toContain(combined as string);
    expect(reply).toContain('non cambia il firewall da solo');
  });

  it('nessuna valida: lo dice e non propone nulla da incollare', () => {
    const reply = scannerRulesReply([rule('^/\\.', 'A')], 'gpt-6.2-sol');
    expect(reply).toContain('nessuna ha superato i controlli');
    expect(reply).not.toContain('Matches regex');
  });
});

describe('isScannerRulesCommand', () => {
  it.each([
    'genera regole scanner',
    'Genera le regole anti-scanner',
    'aggiorna regole antiscanner',
    'crea le regole contro gli scanner',
    'genera gli scanner',
  ])('«%s» è il comando', (text) => expect(isScannerRulesCommand(text)).toBe(true));

  it.each([
    'genera regole',
    'quanti scanner oggi?',
    'genera regole scanner per favore subito adesso',
  ])('«%s» non lo è', (text) => expect(isScannerRulesCommand(text)).toBe(false));
});

describe('SOLCO_PATHS copre il sito vero', () => {
  const root = join(process.cwd(), 'src/app');

  it('ogni pagina dell’app è nell’elenco (parametri come esempi)', () => {
    const pages = walk(root)
      .filter((file) => /\/page\.tsx$/.test(file))
      .map((file) =>
        `/${relative(root, file)}`
          .replace(/\/page\.tsx$/, '')
          .replace(/\/\([^/]+\)/g, '')
          .replace(/\[[^/]+\]/g, '*'),
      )
      .map((page) => page || '/');
    for (const page of pages) {
      const pattern = new RegExp(`^${page.replace(/\*/g, '[^/]+')}$`);
      expect(
        SOLCO_PATHS.some((path) => pattern.test(path)),
        page,
      ).toBe(true);
    }
  });

  it('ogni cartella e file di primo livello di public/ e ogni file di /.well-known è nell’elenco', () => {
    const publicDir = join(process.cwd(), 'public');
    for (const name of readdirSync(publicDir)) {
      if (name.startsWith('.')) continue; // /.well-known sotto; .gitkeep non è una risorsa del sito
      expect(
        SOLCO_PATHS.some((path) => path === `/${name}` || path.startsWith(`/${name}/`)),
        name,
      ).toBe(true);
    }
    for (const name of readdirSync(join(publicDir, '.well-known'))) {
      expect(SOLCO_PATHS, name).toContain(`/.well-known/${name}`);
    }
  });

  it('nessuna sonda nota è un percorso di Solco', () => {
    for (const probe of PROBE_SAMPLES) expect(SOLCO_PATHS).not.toContain(probe);
  });
});
