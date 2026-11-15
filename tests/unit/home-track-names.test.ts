// @polsia:user-owned — titoli.json (titoli e artisti personalizzati della Home): parser puro
// (versione 1, voci con "file" e almeno uno fra "titolo"/"artista", altri campi ignorati, prima voce
// per file, percorsi plausibili, limiti di lunghezza, BOM) e applicazione ai brani (id = pathname,
// forma NFC; "artista": "" o null = nessun artista; senza voce il brano resta com'è).
import { describe, expect, it } from 'vitest';
import {
  applyHomeTrackNames,
  homeTrackNameFor,
  isPlausibleStorePathname,
  parseHomeTrackNames,
} from '@/lib/music/home-track-names';

const MANIFEST = JSON.stringify({
  versione: 1,
  brani: [
    { file: 'spotifydown.com - Aura..mp3', titolo: 'Aura', artista: 'Nome artista' },
    { file: 'Strumentale - Pioggia.mp3', titolo: '  Pioggia  ' },
    { file: 'Demo 01.mp3', artista: '' },
    { file: 'Demo 02.mp3', artista: null, stato_diritti: 'da_verificare', tipo_licenza: 'x' },
    // Doppione: vale la prima voce.
    { file: 'spotifydown.com - Aura..mp3', titolo: 'Altro' },
    // Scartate: senza titolo né artista, titolo vuoto, troppo lungo, con a capo, percorso non ammesso.
    { file: 'Niente.mp3' },
    { file: 'Vuoto.mp3', titolo: '   ' },
    { file: 'Lungo.mp3', titolo: 'x'.repeat(201) },
    { file: 'Acapo.mp3', titolo: 'riga\nnuova' },
    { file: '../fuori.mp3', titolo: 'Fuori' },
    { file: 'public-uploads/u.mp3', titolo: 'Upload' },
    { titolo: 'Senza file' },
    'non una voce',
  ],
});

describe('parseHomeTrackNames', () => {
  it('legge le voci valide, ignora gli altri campi, tiene la prima per file', () => {
    const parsed = parseHomeTrackNames(MANIFEST);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('inatteso');
    expect(parsed.entries).toBe(4);
    expect(parsed.skipped).toBe(9);
    expect(parsed.names.get('spotifydown.com - Aura..mp3')).toEqual({
      title: 'Aura',
      artist: 'Nome artista',
    });
    expect(parsed.names.get('Strumentale - Pioggia.mp3')).toEqual({ title: 'Pioggia' });
    expect(parsed.names.get('Demo 01.mp3')).toEqual({ artist: null });
    expect(parsed.names.get('Demo 02.mp3')).toEqual({ artist: null });
  });

  it('accetta il BOM e rifiuta JSON rotto o forma sbagliata', () => {
    expect(parseHomeTrackNames(`﻿${MANIFEST}`).ok).toBe(true);
    expect(parseHomeTrackNames('{ "versione": 1, "brani": [ }')).toEqual({
      ok: false,
      reason: 'json',
    });
    expect(parseHomeTrackNames('{ "versione": 2, "brani": [] }')).toEqual({
      ok: false,
      reason: 'shape',
    });
    expect(parseHomeTrackNames('{ "versione": 1, "brani": {} }')).toEqual({
      ok: false,
      reason: 'shape',
    });
    expect(parseHomeTrackNames('[]')).toEqual({ ok: false, reason: 'shape' });
  });

  it('percorsi plausibili: relativi, senza "..", barre rovesciate, controllo o upload utenti', () => {
    expect(isPlausibleStorePathname('Rock/Artista - Titolo.mp3')).toBe(true);
    expect(isPlausibleStorePathname('/assoluto.mp3')).toBe(false);
    expect(isPlausibleStorePathname('a//b.mp3')).toBe(false);
    expect(isPlausibleStorePathname('a\\b.mp3')).toBe(false);
    expect(isPlausibleStorePathname('x/../y.mp3')).toBe(false);
    expect(isPlausibleStorePathname('controllo\u0007.mp3')).toBe(false);
    expect(isPlausibleStorePathname('public-uploads/x.mp3')).toBe(false);
  });
});

describe('applyHomeTrackNames', () => {
  const parsed = parseHomeTrackNames(MANIFEST);
  const names = parsed.ok ? parsed.names : new Map();
  const tracks = [
    { id: 'spotifydown.com - Aura..mp3', title: 'Aura.', artist: 'Spotifydown.com', extra: 1 },
    { id: 'Strumentale - Pioggia.mp3', title: 'Pioggia', artist: 'Strumentale', extra: 2 },
    { id: 'Demo 01.mp3', title: 'Demo 01', artist: 'Qualcuno', extra: 3 },
    { id: 'Altro.mp3', title: 'Altro', artist: null, extra: 4 },
  ];

  it('sostituisce titolo e artista dove c’è una voce, lascia il resto identico', () => {
    const applied = applyHomeTrackNames(tracks, names);
    expect(applied.map((track) => [track.title, track.artist, track.extra])).toEqual([
      ['Aura', 'Nome artista', 1],
      ['Pioggia', 'Strumentale', 2],
      ['Demo 01', null, 3],
      ['Altro', null, 4],
    ]);
    // Il brano senza voce è lo stesso oggetto; gli originali non cambiano.
    expect(applied[3]).toBe(tracks[3]);
    expect(tracks[0]?.title).toBe('Aura.');
  });

  it('senza nomi (null, undefined o vuoti) restituisce gli stessi brani', () => {
    expect(applyHomeTrackNames(tracks, null)).toEqual(tracks);
    expect(applyHomeTrackNames(tracks, undefined)).toEqual(tracks);
    expect(applyHomeTrackNames(tracks, new Map())).toEqual(tracks);
  });

  it('abbina i file in forma Unicode NFC (nomi con accenti caricati da un Mac)', () => {
    const decomposed = 'Caffé - Mattina.mp3';
    const composed = 'Caffé - Mattina.mp3';
    const parsedAccent = parseHomeTrackNames(
      JSON.stringify({ versione: 1, brani: [{ file: decomposed, titolo: 'Mattina presto' }] }),
    );
    if (!parsedAccent.ok) throw new Error('inatteso');
    expect(homeTrackNameFor(parsedAccent.names, composed)).toEqual({ title: 'Mattina presto' });
    expect(homeTrackNameFor(parsedAccent.names, 'altro.mp3')).toBeNull();
  });
});
