// @polsia:user-owned
'use client';

import Image from 'next/image';
import Link from 'next/link';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api-client';
import {
  type AudiusAlbumDetail,
  AudiusAlbumDetailSchema,
  type AudiusAlbumSearchResult,
  MusicSearchResponseSchema,
} from '@/lib/contracts/music';
import {
  MusicRightsAdminListSchema,
  type MusicRightsAdminRecord,
  MusicRightsMutationSchema,
} from '@/lib/contracts/music-rights';
import { FileUploadError, uploadPrivateFile } from '@/modules/file-upload/client';
import styles from './music-rights-admin.module.css';

type PrivateUpload = {
  key: string;
  mimeType: string;
  byteLength: number;
  filename: string;
};

type UploadKind = 'audio' | 'evidence';

function statusLabel(record: MusicRightsAdminRecord) {
  if (!record.active) return 'Fonte disattivata';
  if (record.rightsState === 'current') return 'Diritti correnti';
  if (record.rightsState === 'scheduled') return 'Diritti con decorrenza futura';
  if (record.rightsState === 'expired') return 'Diritti scaduti';
  if (record.rightsState === 'revoked') return 'Prova revocata';
  return 'Prova assente';
}

export function MusicRightsAdmin() {
  const [records, setRecords] = useState<MusicRightsAdminRecord[]>([]);
  const [loadingRecords, setLoadingRecords] = useState(true);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [albums, setAlbums] = useState<AudiusAlbumSearchResult[]>([]);
  const [selectedAlbum, setSelectedAlbum] = useState<AudiusAlbumDetail | null>(null);
  const [selectedTrackId, setSelectedTrackId] = useState('');
  const [loadingAlbum, setLoadingAlbum] = useState(false);
  const [searching, setSearching] = useState(false);
  const [audioUpload, setAudioUpload] = useState<PrivateUpload | null>(null);
  const [evidenceUpload, setEvidenceUpload] = useState<PrivateUpload | null>(null);
  const [uploading, setUploading] = useState<UploadKind | null>(null);
  const [validFrom, setValidFrom] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);

  const loadRecords = useCallback(async () => {
    setLoadingRecords(true);
    try {
      const response = await apiFetch('/api/admin/music-rights', {
        schema: MusicRightsAdminListSchema,
      });
      setRecords(response.records);
      setRecordError(null);
    } catch {
      setRecordError('Le registrazioni non sono disponibili in questo momento.');
    } finally {
      setLoadingRecords(false);
    }
  }, []);

  useEffect(() => {
    void loadRecords();
  }, [loadRecords]);

  async function searchAlbums(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const term = query.trim();
    if (!term) return;
    setSearching(true);
    setAlbums([]);
    setSelectedAlbum(null);
    setSelectedTrackId('');
    try {
      const params = new URLSearchParams({ source: 'audius', q: term });
      const response = await apiFetch(`/api/music/search?${params.toString()}`, {
        schema: MusicSearchResponseSchema,
      });
      setAlbums(response.albums);
      if (response.albums.length === 0) {
        toast.message('Audius non ha restituito album per questa ricerca.');
      }
    } catch {
      toast.error('La ricerca degli album Audius non è disponibile.');
    } finally {
      setSearching(false);
    }
  }

  async function chooseAlbum(album: AudiusAlbumSearchResult) {
    setLoadingAlbum(true);
    setSelectedAlbum(null);
    setSelectedTrackId('');
    try {
      const result = await apiFetch(`/api/music/albums/${encodeURIComponent(album.id)}`, {
        schema: AudiusAlbumDetailSchema,
      });
      setSelectedAlbum(result);
    } catch {
      toast.error('La fonte non ha restituito i metadati o la tracklist aggiornati.');
    } finally {
      setLoadingAlbum(false);
    }
  }

  async function upload(kind: UploadKind, file: File | undefined) {
    if (!file) return;
    setUploading(kind);
    try {
      const uploaded = await uploadPrivateFile(file);
      const result = {
        key: uploaded.key,
        mimeType: uploaded.mime_type,
        byteLength: uploaded.size,
        filename: file.name,
      };
      if (kind === 'audio') setAudioUpload(result);
      else setEvidenceUpload(result);
      toast.success(
        kind === 'audio'
          ? 'Fonte audio caricata in archivio privato.'
          : 'Prova caricata in archivio privato.',
      );
    } catch (error) {
      toast.error(
        error instanceof FileUploadError ? error.message : 'Caricamento privato non riuscito.',
      );
    } finally {
      setUploading(null);
    }
  }

  async function registerRights(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const track = selectedAlbum?.tracks.find((item) => item.id === selectedTrackId);
    if (!selectedAlbum || !track || !audioUpload || !evidenceUpload || !confirmed) {
      toast.error('Seleziona un brano, carica entrambi i file privati e conferma la verifica.');
      return;
    }
    setSaving(true);
    try {
      await apiFetch('/api/admin/music-rights', {
        method: 'POST',
        body: JSON.stringify({
          albumId: selectedAlbum.album.id,
          trackId: track.id,
          audio: {
            key: audioUpload.key,
            mimeType: audioUpload.mimeType,
            byteLength: audioUpload.byteLength,
          },
          evidence: {
            key: evidenceUpload.key,
            mimeType: evidenceUpload.mimeType,
            byteLength: evidenceUpload.byteLength,
          },
          validFrom: new Date(`${validFrom}T00:00:00.000Z`).toISOString(),
          validUntil: new Date(`${validUntil}T23:59:59.999Z`).toISOString(),
          confirmFullTrackAndSolcoRights: true,
        }),
        schema: MusicRightsMutationSchema,
      });
      toast.success('Fonte e prova verificate e registrate per questo brano.');
      setAudioUpload(null);
      setEvidenceUpload(null);
      setConfirmed(false);
      setValidFrom('');
      setValidUntil('');
      await loadRecords();
    } catch (error) {
      const cause =
        error instanceof Error && typeof error.cause === 'object' && error.cause !== null
          ? (error.cause as { error?: unknown })
          : null;
      const errorCode = typeof cause?.error === 'string' ? cause.error : '';
      toast.error(
        errorCode === 'catalog_unavailable'
          ? 'Catalogo Audius non verificabile: nessuna registrazione è stata salvata.'
          : errorCode === 'catalog_track_not_found'
            ? 'Il brano non risulta nella tracklist corrente dell’album.'
            : errorCode === 'active_source_exists'
              ? 'Esiste già una fonte attiva per questo brano.'
              : 'La verifica di storage o prova è fallita. La registrazione resta bloccata.',
      );
    } finally {
      setSaving(false);
    }
  }

  async function updateRecord(sourceId: string, action: 'deactivate_source' | 'revoke_evidence') {
    try {
      await apiFetch(`/api/admin/music-rights/${encodeURIComponent(sourceId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ action }),
        schema: MusicRightsMutationSchema,
      });
      toast.success(
        action === 'deactivate_source' ? 'Fonte disattivata.' : 'Prova dei diritti revocata.',
      );
      await loadRecords();
    } catch {
      toast.error('La modifica non è stata salvata.');
    }
  }

  return (
    <div className={styles.page}>
      <header className={styles.heading}>
        <p className={styles.eyebrow}>CATALOGO · AUTORIZZAZIONI</p>
        <h1>Diritti di ascolto</h1>
        <p>
          Solo un amministratore verificato può associare una fonte privata e una prova corrente al
          brano Audius esatto. I metadati del catalogo non autorizzano lo streaming su Solco.
        </p>
      </header>

      <section className={styles.panel} aria-labelledby="register-heading">
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>NUOVA VERIFICA</p>
            <h2 id="register-heading">Registra una fonte integrale</h2>
          </div>
          <span className={styles.locked}>File privati · validazione server-side</span>
        </div>

        <form className={styles.catalogSearch} onSubmit={searchAlbums}>
          <label htmlFor="rights-album-search">Cerca l’album reale nel catalogo Audius</label>
          <div className={styles.searchRow}>
            <input
              id="rights-album-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              maxLength={80}
              placeholder="Titolo album o artista"
            />
            <button type="submit" disabled={searching || query.trim().length === 0}>
              {searching ? 'Ricerca…' : 'Cerca album'}
            </button>
          </div>
        </form>

        {albums.length ? (
          <fieldset className={styles.albumChoices}>
            <legend className={styles.visuallyHidden}>Album restituiti dal catalogo</legend>
            {albums.map((album) => (
              <button
                className={styles.albumChoice}
                type="button"
                key={album.id}
                onClick={() => void chooseAlbum(album)}
                aria-pressed={selectedAlbum?.album.id === album.id}
              >
                {album.artworkUrl ? (
                  <Image src={album.artworkUrl} alt="" width={52} height={52} unoptimized />
                ) : (
                  <span className={styles.coverFallback} aria-hidden="true">
                    S
                  </span>
                )}
                <span>
                  <strong>{album.title}</strong>
                  <small>{album.artistName ?? 'Artista non indicato da Audius'}</small>
                </span>
              </button>
            ))}
          </fieldset>
        ) : null}

        {loadingAlbum ? (
          <p className={styles.notice}>Verifica metadati e tracklist dal catalogo…</p>
        ) : null}
        {selectedAlbum ? (
          <form className={styles.registrationForm} onSubmit={registerRights}>
            <div className={styles.catalogIdentity}>
              <span>Album verificato</span>
              <strong>{selectedAlbum.album.title}</strong>
              <Link href={`/albums/${encodeURIComponent(selectedAlbum.album.id)}`} target="_blank">
                Apri scheda album
              </Link>
            </div>
            <label className={styles.field} htmlFor="rights-track">
              Brano esatto
              <select
                id="rights-track"
                value={selectedTrackId}
                onChange={(event) => setSelectedTrackId(event.target.value)}
                required
              >
                <option value="">Seleziona dalla tracklist verificata</option>
                {selectedAlbum.tracks.map((track) => (
                  <option key={track.id} value={track.id}>
                    {track.title} · {track.artistName ?? 'Artista non indicato'}
                  </option>
                ))}
              </select>
              {selectedAlbum.tracks.length === 0 ? (
                <small>Il catalogo non ha restituito brani per questa tracklist.</small>
              ) : null}
            </label>

            <div className={styles.uploadGrid}>
              <label className={styles.uploadField}>
                <span>File audio completo e privato</span>
                <input
                  type="file"
                  accept="audio/mpeg,audio/mp4,audio/wav,audio/ogg,audio/aac,audio/flac"
                  onChange={(event) => {
                    void upload('audio', event.currentTarget.files?.[0]);
                    event.currentTarget.value = '';
                  }}
                  disabled={uploading !== null}
                />
                <small>
                  {audioUpload
                    ? `${audioUpload.filename} · file privato pronto`
                    : 'Audio supportato fino a 500 MB.'}
                </small>
                {uploading === 'audio' ? <output>Caricamento audio privato…</output> : null}
              </label>
              <label className={styles.uploadField}>
                <span>Documento o immagine della prova</span>
                <input
                  type="file"
                  accept="application/pdf,image/jpeg,image/png"
                  onChange={(event) => {
                    void upload('evidence', event.currentTarget.files?.[0]);
                    event.currentTarget.value = '';
                  }}
                  disabled={uploading !== null}
                />
                <small>
                  {evidenceUpload
                    ? `${evidenceUpload.filename} · file privato pronto`
                    : 'PDF, JPEG o PNG fino a 50 MB.'}
                </small>
                {uploading === 'evidence' ? <output>Caricamento prova privata…</output> : null}
              </label>
            </div>

            <div className={styles.validityGrid}>
              <label className={styles.field} htmlFor="rights-valid-from">
                Valido dal
                <input
                  id="rights-valid-from"
                  type="date"
                  value={validFrom}
                  onChange={(event) => setValidFrom(event.target.value)}
                  required
                />
              </label>
              <label className={styles.field} htmlFor="rights-valid-until">
                Valido fino al
                <input
                  id="rights-valid-until"
                  type="date"
                  value={validUntil}
                  onChange={(event) => setValidUntil(event.target.value)}
                  required
                />
              </label>
            </div>

            <label className={styles.confirmation}>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              <span>
                Confermo che il file contiene il brano integrale selezionato e che la prova
                documentale autorizza lo streaming su Solco per questo album, brano e durata. La mia
                identità amministrativa verificata verrà registrata.
              </span>
            </label>
            <button
              className={styles.submit}
              type="submit"
              disabled={
                saving || uploading !== null || !confirmed || !audioUpload || !evidenceUpload
              }
            >
              {saving ? 'Verifica e registrazione…' : 'Verifica e registra la fonte'}
            </button>
          </form>
        ) : null}
      </section>

      <section className={styles.panel} aria-labelledby="records-heading">
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>REGISTRO PRIVATO</p>
            <h2 id="records-heading">Fonti e prove</h2>
          </div>
          <button
            className={styles.refresh}
            type="button"
            onClick={() => void loadRecords()}
            disabled={loadingRecords}
          >
            {loadingRecords ? 'Aggiorno…' : 'Aggiorna'}
          </button>
        </div>
        {recordError ? <output className={styles.notice}>{recordError}</output> : null}
        {!loadingRecords && !recordError && records.length === 0 ? (
          <p className={styles.notice}>Nessuna fonte integrale è stata registrata.</p>
        ) : null}
        <ul className={styles.recordList}>
          {records.map((record) => (
            <li className={styles.record} key={record.sourceId}>
              <div>
                <p className={styles.recordTitle}>
                  Album <code>{record.albumId}</code> · brano <code>{record.trackId}</code>
                </p>
                <p>
                  {statusLabel(record)} · {record.durationSeconds.toFixed(1)} secondi
                </p>
                <p>
                  Validità:{' '}
                  {record.validFrom
                    ? new Date(record.validFrom).toLocaleDateString('it-IT')
                    : 'non registrata'}{' '}
                  —{' '}
                  {record.validUntil
                    ? new Date(record.validUntil).toLocaleDateString('it-IT')
                    : 'non registrata'}
                </p>
                <p>
                  Verificatore: <code>{record.verifiedByUserId ?? 'non registrato'}</code>
                </p>
              </div>
              <div className={styles.recordActions}>
                {record.active ? (
                  <button
                    type="button"
                    onClick={() => void updateRecord(record.sourceId, 'deactivate_source')}
                  >
                    Disattiva fonte
                  </button>
                ) : null}
                {record.rightsState !== 'revoked' && record.verifiedAt ? (
                  <button
                    type="button"
                    onClick={() => void updateRecord(record.sourceId, 'revoke_evidence')}
                  >
                    Revoca prova
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
