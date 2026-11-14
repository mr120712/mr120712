// @polsia:user-owned — invio e controllo dei codici SMS con Twilio Verify (API REST, niente SDK).
//
// Twilio genera il codice, lo invia, lo fa scadere (10 minuti) e limita i tentativi (5 per
// verifica): Solco non conserva mai il codice. Credenziali solo lato server, da variabili
// d'ambiente impostate su Vercel: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SERVICE_SID.
// Senza tutte e tre l'accesso col telefono è spento (l'interfaccia non lo mostra).
// Non lancia mai: ritorna l'esito, così un errore di rete non rompe il flusso di login.
import 'server-only';

type Fetcher = typeof fetch;

type TwilioConfig = { accountSid: string; authToken: string; serviceSid: string };

const TIMEOUT_MS = 10_000;

function readConfig(): TwilioConfig | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim() ?? '';
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim() ?? '';
  const serviceSid = process.env.TWILIO_VERIFY_SERVICE_SID?.trim() ?? '';
  // Forme attese degli id Twilio: AC… (account) e VA… (servizio Verify), 34 caratteri.
  if (!/^AC[0-9a-f]{32}$/i.test(accountSid)) return null;
  if (!/^VA[0-9a-f]{32}$/i.test(serviceSid)) return null;
  if (!authToken) return null;
  return { accountSid, authToken, serviceSid };
}

/** true se Twilio Verify è configurato (l'accesso col telefono è attivo). */
export function isPhoneLoginConfigured(): boolean {
  return readConfig() !== null;
}

async function twilioPost(
  config: TwilioConfig,
  path: string,
  form: Record<string, string>,
  fetcher: Fetcher,
): Promise<{ ok: boolean; body: Record<string, unknown> | null }> {
  const url = `https://verify.twilio.com/v2/Services/${config.serviceSid}/${path}`;
  const auth = Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64');
  try {
    const res = await fetcher(url, {
      method: 'POST',
      headers: {
        authorization: `Basic ${auth}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { ok: res.ok, body };
  } catch {
    return { ok: false, body: null };
  }
}

/** Avvia una verifica SMS (Twilio invia il codice). true se Twilio l'ha accettata. */
export async function startSmsVerification(
  phoneNumber: string,
  fetcher: Fetcher = fetch,
): Promise<boolean> {
  const config = readConfig();
  if (!config) return false;
  const { ok, body } = await twilioPost(
    config,
    'Verifications',
    { To: phoneNumber, Channel: 'sms', Locale: 'it' },
    fetcher,
  );
  if (!ok) {
    // Solo il codice d'errore Twilio (es. 60200 numero non valido, 60203 troppi invii): mai il numero.
    console.warn('[solco] Twilio Verify: invio non riuscito', body?.code ?? 'rete');
  }
  return ok;
}

/** Controlla il codice inserito. true solo se Twilio risponde "approved". */
export async function checkSmsVerification(
  phoneNumber: string,
  code: string,
  fetcher: Fetcher = fetch,
): Promise<boolean> {
  const config = readConfig();
  if (!config) return false;
  if (!/^\d{4,10}$/.test(code)) return false;
  const { ok, body } = await twilioPost(
    config,
    'VerificationCheck',
    { To: phoneNumber, Code: code },
    fetcher,
  );
  return ok && body?.status === 'approved';
}
