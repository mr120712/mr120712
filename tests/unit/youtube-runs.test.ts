// @polsia:user-owned — sequenze di video YouTube consecutivi passate al player ufficiale come playlist.
import { describe, expect, it } from 'vitest';
import {
  continuesInRun,
  playerListsRun,
  predatesMove,
  type RunQueueItem,
  readPlayerReport,
  reportedRunPosition,
  runHoldsIndex,
  runMoveCommand,
  runVideoId,
  YOUTUBE_RUN_LIMIT,
  youtubeRunAt,
} from '@/lib/music/youtube-runs';

const id = (letter: string) => letter.repeat(11);
const yt = (letter: string): RunQueueItem => ({
  qualifiedId: `youtube:${id(letter)}`,
  playbackMode: 'youtube',
});
const audius: RunQueueItem = { qualifiedId: 'audius:track-a', playbackMode: 'audius' };
const podcast: RunQueueItem = { qualifiedId: 'podcast:1~ep', playbackMode: 'podcast' };
const radio: RunQueueItem = { qualifiedId: 'radio:station', playbackMode: 'radio' };
const song: RunQueueItem = { qualifiedId: `song:${'f'.repeat(32)}`, playbackMode: 'song' };

describe('runVideoId', () => {
  it('solo per i video YouTube con un id valido', () => {
    expect(runVideoId(yt('a'))).toBe(id('a'));
    expect(runVideoId(audius)).toBeNull();
    expect(runVideoId(song)).toBeNull();
    expect(runVideoId({ qualifiedId: 'youtube:short', playbackMode: 'youtube' })).toBeNull();
    // A video id under another mode is not a plain YouTube item.
    expect(runVideoId({ qualifiedId: `youtube:${id('a')}`, playbackMode: 'song' })).toBeNull();
    expect(runVideoId(undefined)).toBeNull();
  });
});

describe('youtubeRunAt', () => {
  // 0 a, 1 b, 2 Audius, 3 c, 4 song, 5 d, 6 e, 7 podcast, 8 f, 9 radio
  const mixed = [
    yt('a'),
    yt('b'),
    audius,
    yt('c'),
    song,
    yt('d'),
    yt('e'),
    podcast,
    yt('f'),
    radio,
  ];

  it('la sequenza massima di video consecutivi che contiene l’elemento corrente', () => {
    expect(youtubeRunAt(mixed, 0)).toEqual({ start: 0, videoIds: [id('a'), id('b')], offset: 0 });
    expect(youtubeRunAt(mixed, 1)).toEqual({ start: 0, videoIds: [id('a'), id('b')], offset: 1 });
    expect(youtubeRunAt(mixed, 6)).toEqual({ start: 5, videoIds: [id('d'), id('e')], offset: 1 });
  });

  it('Audius, podcast, radio e brani importati interrompono la sequenza', () => {
    expect(youtubeRunAt(mixed, 3)).toEqual({ start: 3, videoIds: [id('c')], offset: 0 });
    expect(youtubeRunAt(mixed, 8)).toEqual({ start: 8, videoIds: [id('f')], offset: 0 });
    expect(youtubeRunAt(mixed, 2)).toBeNull();
    expect(youtubeRunAt(mixed, 4)).toBeNull();
    expect(youtubeRunAt(mixed, 9)).toBeNull();
  });

  it('un brano importato già risolto in video fa parte della sequenza', () => {
    const resolved = [yt('a'), { ...yt('b'), importedFrom: song.qualifiedId }, yt('c')];
    expect(youtubeRunAt(resolved, 0)?.videoIds).toEqual([id('a'), id('b'), id('c')]);
  });

  it('indici fuori dalla coda', () => {
    expect(youtubeRunAt(mixed, -1)).toBeNull();
    expect(youtubeRunAt(mixed, 10)).toBeNull();
    expect(youtubeRunAt(mixed, 1.5)).toBeNull();
    expect(youtubeRunAt([], 0)).toBeNull();
  });

  it('al massimo 50 video, con l’elemento corrente dentro la finestra', () => {
    const letters = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const long = Array.from({ length: 120 }, (_, item) => ({
      qualifiedId: `youtube:${`${letters[item % letters.length]}${String(item).padStart(3, '0')}`.padEnd(11, '_')}`,
      playbackMode: 'youtube',
    }));
    expect(YOUTUBE_RUN_LIMIT).toBe(50);
    const fromStart = youtubeRunAt(long, 0);
    expect(fromStart?.start).toBe(0);
    expect(fromStart?.videoIds).toHaveLength(50);
    expect(fromStart?.offset).toBe(0);

    // Middle: the window starts at the current video (the following ones are prepared).
    const middle = youtubeRunAt(long, 30);
    expect(middle).toMatchObject({ start: 30, offset: 0 });
    expect(middle?.videoIds).toHaveLength(50);
    expect(middle?.videoIds[0]).toBe(runVideoId(long[30]));

    // Near the end: the last 50 videos, current one inside.
    const end = youtubeRunAt(long, 100);
    expect(end).toMatchObject({ start: 70, offset: 30 });
    expect(end?.videoIds).toHaveLength(50);
    expect(end?.videoIds[end.offset]).toBe(runVideoId(long[100]));

    expect(youtubeRunAt([yt('a'), yt('b'), yt('c'), yt('d')], 2, 2)).toEqual({
      start: 2,
      videoIds: [id('c'), id('d')],
      offset: 0,
    });
    expect(youtubeRunAt([yt('a'), yt('b'), yt('c')], 2, 0)).toEqual({
      start: 2,
      videoIds: [id('c')],
      offset: 0,
    });
  });
});

describe('runHoldsIndex e continuesInRun', () => {
  const queue = [yt('a'), yt('b'), yt('c'), audius];
  const run = youtubeRunAt(queue, 0);

  it('vale solo dentro la sequenza e finché la coda non cambia', () => {
    expect(runHoldsIndex(run, queue, 0)).toBe(true);
    expect(runHoldsIndex(run, queue, 2)).toBe(true);
    expect(runHoldsIndex(run, queue, 3)).toBe(false);
    expect(runHoldsIndex(null, queue, 0)).toBe(false);
    expect(runHoldsIndex(run, [yt('a'), yt('x'), yt('c'), audius], 0)).toBe(false);
    expect(runHoldsIndex(run, [yt('a'), yt('b')], 0)).toBe(false);
  });

  it('YouTube prosegue da solo tranne che dopo l’ultimo video', () => {
    if (!run) throw new Error('sequenza mancante');
    expect(continuesInRun(run, 0)).toBe(true);
    expect(continuesInRun(run, 1)).toBe(true);
    expect(continuesInRun(run, 2)).toBe(false);
    expect(continuesInRun(run, 3)).toBe(false);
  });
});

describe('posizione riportata dal player ufficiale', () => {
  const run = { start: 4, videoIds: [id('a'), id('b'), id('a'), id('c')], offset: 0 };

  it('usa l’indice della playlist quando concorda con il video', () => {
    expect(reportedRunPosition(run, { playlistIndex: 1, videoId: id('b') })).toBe(1);
    expect(reportedRunPosition(run, { playlistIndex: 3 })).toBe(3);
  });

  it('altrimenti il video, il più vicino se ripetuto', () => {
    expect(reportedRunPosition(run, { playlistIndex: 1, videoId: id('c') })).toBe(3);
    expect(reportedRunPosition(run, { playlistIndex: -1, videoId: id('a') }, 3)).toBe(2);
    expect(reportedRunPosition(run, { videoId: id('a') }, 0)).toBe(0);
  });

  it('niente posizione per un video estraneo o senza dati', () => {
    expect(reportedRunPosition(run, { playlistIndex: 0, videoId: id('z') })).toBeNull();
    expect(reportedRunPosition(run, { playlistIndex: 9 })).toBeNull();
    expect(reportedRunPosition(run, {})).toBeNull();
  });

  it('legge indice e video senza fallire se il player non è pronto', () => {
    expect(
      readPlayerReport({ getPlaylistIndex: () => 2, getVideoData: () => ({ video_id: id('a') }) }),
    ).toEqual({ playlistIndex: 2, videoId: id('a') });
    expect(
      readPlayerReport({
        getPlaylistIndex: () => {
          throw new Error('not ready');
        },
        getVideoData: () => null,
      }),
    ).toEqual({ playlistIndex: undefined, videoId: undefined });
    expect(readPlayerReport({})).toEqual({ playlistIndex: undefined, videoId: undefined });
  });

  it('riconosce quando la playlist del player non è la sequenza', () => {
    const run = { start: 2, videoIds: [id('a'), id('b'), id('c')], offset: 0 };
    expect(playerListsRun({ getPlaylist: () => [id('a'), id('b'), id('c')] }, run)).toBe(true);
    expect(playerListsRun({ getPlaylist: () => [id('a'), id('b')] }, run)).toBe(false);
    expect(playerListsRun({ getPlaylist: () => [id('a'), id('c'), id('b')] }, run)).toBe(false);
    expect(playerListsRun({ getPlaylist: () => null }, run)).toBe(false);
    // No getter, or a player still starting: YouTube is trusted, as before.
    expect(playerListsRun({}, run)).toBe(true);
    expect(playerListsRun(null, run)).toBe(true);
    expect(
      playerListsRun(
        {
          getPlaylist: () => {
            throw new Error('not ready');
          },
        },
        run,
      ),
    ).toBe(true);
  });
});

describe('spostamenti chiesti dall’app', () => {
  it('ignora solo il video di partenza e l’avanzamento automatico da quello', () => {
    const pending = { index: 7, from: 3 };
    expect(predatesMove(pending, 3)).toBe(true);
    expect(predatesMove(pending, 4)).toBe(true);
    expect(predatesMove(pending, 7)).toBe(false);
    expect(predatesMove(pending, 5)).toBe(false);
    expect(predatesMove({ index: 4, from: 3 }, 4)).toBe(false);
    expect(predatesMove({ index: 3, from: null }, 4)).toBe(false);
    expect(predatesMove(null, 3)).toBe(false);
  });

  it('nextVideo / previousVideo per i vicini, playVideoAt altrimenti', () => {
    expect(runMoveCommand(2, 3)).toEqual({ kind: 'next' });
    expect(runMoveCommand(2, 1)).toEqual({ kind: 'previous' });
    expect(runMoveCommand(2, 2)).toEqual({ kind: 'at', position: 2 });
    expect(runMoveCommand(2, 5)).toEqual({ kind: 'at', position: 5 });
    expect(runMoveCommand(null, 1)).toEqual({ kind: 'at', position: 1 });
  });
});
