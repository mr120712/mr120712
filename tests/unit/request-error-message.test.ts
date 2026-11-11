// @polsia:user-owned
import { describe, expect, it } from 'vitest';
import { requestErrorMessage } from '@/lib/business/request-error-message';

describe('messaggi per errori di richiesta', () => {
  it('mostra il tempo di attesa restituito dal server e il messaggio 413', () => {
    const limited = new Error('failed', {
      cause: {
        error: 'rate_limited',
        message: 'Hai raggiunto il limite. Riprova tra 30 secondi.',
        retryAfterSeconds: 30,
      },
    });
    const oversized = new Error('failed', {
      cause: { error: 'payload_too_large', message: 'La richiesta è troppo grande.' },
    });

    expect(requestErrorMessage(limited, 'errore')).toBe(
      'Hai raggiunto il limite. Riprova tra 30 secondi.',
    );
    expect(requestErrorMessage(oversized, 'errore')).toBe('La richiesta è troppo grande.');
    expect(requestErrorMessage(new Error('network'), 'errore di connessione')).toBe(
      'errore di connessione',
    );
  });
});
