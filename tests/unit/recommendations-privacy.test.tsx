// @polsia:user-owned — informativa privacy: i brani consigliati («Potrebbe piacerti») sono calcolati
// sui server di Solco dai tuoi dati, non vengono mostrati ad altri, si possono spegnere in
// Impostazioni; la community conta solo in forma aggregata; l'AI riceve solo nomi di artisti e generi.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  // biome-ignore lint/suspicious/noExplicitAny: test stub forwards whatever the page passes.
  default: ({ href, children, ...rest }: any) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import PrivacyPage from '@/app/(custom)/privacy/page';

const text = () => {
  const root = document.createElement('div');
  root.innerHTML = renderToStaticMarkup(<PrivacyPage />);
  return (root.textContent ?? '').replace(/\s+/g, ' ');
};

describe('/privacy: brani consigliati', () => {
  it('spiega dove sono calcolati, chi li vede e come spegnerli', () => {
    const content = text();
    expect(content).toContain('Brani consigliati («Potrebbe piacerti»)');
    expect(content).toContain('calcolati sui server di Solco dai tuoi ascolti su Solco');
    expect(content).toContain('non vengono mai mostrati ad altri');
    expect(content).toContain('Impostazioni («Consigli personalizzati»');
    expect(content).toContain('solo conteggi aggregati');
    expect(content).toContain('mai titoli o canali YouTube né dati di Spotify');
    expect(content).toContain('preparare i tuoi brani consigliati');
    // Le voci YouTube: solo per non riproporre un brano già ascoltato; cache cancellata con la cronologia.
    expect(content).toContain(
      'le voci YouTube servono solo a non riproporti un brano già ascoltato',
    );
    expect(content).toContain('vengono cancellati quando cancelli la cronologia');
  });
});
