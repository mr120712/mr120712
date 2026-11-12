// @polsia:user-owned
import { describe, expect, it } from 'vitest';
import { uploadFailureMessage } from '@/lib/music/upload-error';
import { FileUploadError } from '@/modules/file-upload/client';

describe('uploadFailureMessage', () => {
  it('traduce in italiano i codici noti del modulo upload', () => {
    expect(uploadFailureMessage(new FileUploadError('file_too_large'))).toContain('troppo grande');
    expect(uploadFailureMessage(new FileUploadError('unauthorized'))).toBe(
      'Devi accedere per caricare un brano.',
    );
    expect(uploadFailureMessage(new FileUploadError('network'))).toContain('connessione');
  });

  it("aggiunge il dettaglio del server per gli errori inattesi ('unknown')", () => {
    const err = new FileUploadError(
      'unknown',
      'File upload is not configured yet. Please try again later.',
    );
    const msg = uploadFailureMessage(err);
    expect(msg).toContain('Caricamento non riuscito');
    expect(msg).toContain('not configured');
  });

  it("non aggiunge dettaglio quando 'unknown' non ne ha", () => {
    expect(uploadFailureMessage(new FileUploadError('unknown'))).toBe(
      'Caricamento non riuscito. Riprova.',
    );
  });

  it('usa l’errore di campo fileKey dalla registrazione API', () => {
    const err = new Error('apiFetch /api/music/recordings failed (400)', {
      cause: { errors: { fileKey: 'Audio non valido.' } },
    });
    expect(uploadFailureMessage(err)).toBe('Audio non valido.');
  });

  it('usa il codice d’errore del server quando presente', () => {
    const err = new Error('apiFetch /api/music/recordings failed (503)', {
      cause: { error: 'recordings_unavailable' },
    });
    expect(uploadFailureMessage(err)).toBe('Caricamento non riuscito: recordings_unavailable.');
  });

  it('ripiega sullo stato HTTP per errori API generici', () => {
    const err = new Error('apiFetch /api/music/recordings failed (500)', { cause: {} });
    expect(uploadFailureMessage(err)).toContain('(apiFetch /api/music/recordings failed (500))');
  });

  it('messaggio di ripiego per valori non-Error', () => {
    expect(uploadFailureMessage('boom')).toBe('Caricamento non riuscito. Riprova.');
  });
});
