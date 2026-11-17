// @polsia:user-owned
//
// «Skynet», livello legale: la riserva del text and data mining (art. 4 direttiva UE 2019/790,
// protocollo TDMRep) è dichiarata in tre modi leggibili dalle macchine: intestazione HTTP su ogni
// risposta (vercel.json), meta tag in ogni pagina (head-content.tsx) e /.well-known/tdmrep.json.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HeadContent } from '@/components/custom/head-content';
import { isGateablePath } from '@/lib/security/uam';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf-8');

describe('«Skynet»: riserva TDM contro l’addestramento delle AI', () => {
  it('ogni risposta porta tdm-reservation: 1 (vercel.json), senza toccare le altre intestazioni', () => {
    const vercel = JSON.parse(read('vercel.json')) as {
      headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
    };
    const all = vercel.headers.find((entry) => entry.source === '/(.*)');
    expect(all?.headers).toEqual([{ key: 'tdm-reservation', value: '1' }]);
    expect(vercel.headers.map((entry) => entry.source)).toEqual(
      expect.arrayContaining(['/sw.js', '/apple-music', '/(.*)']),
    );
  });

  it('ogni pagina dichiara la riserva nel <head>', () => {
    const html = renderToStaticMarkup(<HeadContent nonce="abc" />);
    expect(html).toContain('<meta name="tdm-reservation" content="1"/>');
  });

  it('/.well-known/tdmrep.json riserva tutto il sito ed è fuori dal cancello anti-bot', () => {
    expect(JSON.parse(read('public/.well-known/tdmrep.json'))).toEqual([
      { location: '/*', 'tdm-reservation': 1 },
    ]);
    expect(isGateablePath('/.well-known/tdmrep.json')).toBe(false);
  });
});
