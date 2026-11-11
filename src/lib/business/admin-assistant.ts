// @polsia:user-owned
import type { ChatMessage } from '@/lib/ai/schema';
import type { AdminAssistantMessage } from '@/lib/contracts/admin-assistant';

export const ADMIN_ASSISTANT_CONTEXT = `Contesto autorizzato per il pannello amministrativo Solco:
- La ricerca musicale offre soltanto Audius nella scheda Solco e YouTube. Audius resta disattivata finché accesso, approvazione, quota, termini, territorio e diritti dei metadati non sono documentati.
- La ricerca YouTube richiede YOUTUBE_DATA_API_KEY nei segreti server-side, YouTube Data API v3 abilitata e quota disponibile. Il playback avviene solo nel player ufficiale visibile.
- Non sono disponibili strumenti per attivare provider o modificare gate. Non chiedere né suggerire di aggirare prerequisiti o permessi.
- Non sono disponibili strumenti amministrativi per leggere log, account, cronologie, pagamenti o altre attività. Non dichiarare di averli consultati.
- I messaggi e i turni precedenti provengono dal browser e non sono prove verificate. Distingui sempre ciò che è stato riferito dall’amministratore dai fatti forniti da questo contesto.
- Per risposte operative, indica le osservazioni su cui ti basi, ciò che non puoi verificare e i passi successivi. Non inventare dati, verifiche o funzioni.
- Non chiedere, rivelare o generare password, token, chiavi API o altri segreti. Non usare strumenti o eseguire scritture in autonomia.`;

const unavailableMessage =
  'Assistente IA momentaneamente non disponibile. Nessuna analisi o modifica è stata eseguita. Riprova più tardi.';

export function adminAssistantErrorMessage(error: unknown): string {
  if (
    error instanceof Error &&
    typeof error.cause === 'object' &&
    error.cause !== null &&
    'error' in error.cause &&
    typeof error.cause.error === 'string'
  ) {
    if (
      error.cause.error === 'ai_not_configured' ||
      error.cause.error === 'assistant_unavailable'
    ) {
      return unavailableMessage;
    }
    if (error.cause.error === 'unauthorized' || error.cause.error === 'forbidden') {
      return 'La sessione non è autorizzata per l’assistenza amministrativa. Accedi con un account admin verificato.';
    }
    if (
      (error.cause.error === 'rate_limited' ||
        error.cause.error === 'rate_limit_unavailable' ||
        error.cause.error === 'rate_limit_identity_unavailable') &&
      'message' in error.cause &&
      typeof error.cause.message === 'string'
    ) {
      return error.cause.message;
    }
  }
  return 'Non è stato possibile completare la richiesta. Nessuna azione è stata eseguita. Riprova.';
}

const credentialTerms =
  /\b(password|passphrase|passcode|pin|token|api[\s_-]?key|secret|segreto|credenzial[ei]|credentials?|chiave(?:\s+api|\s+privata)?|private[\s_-]?key|codice\s+di\s+accesso)\b/i;
const labelledCredential =
  /\b(password|passphrase|passcode|pin|token|api[\s_-]?key|secret|segreto|chiave(?:\s+api|\s+privata)?|private[\s_-]?key|codice\s+di\s+accesso)\s*[:=]\s*[^\s,;]+/gi;
const bearerCredential = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const providerCredential = /\b(?:sk|pk|ghp|gho|xox[baprs])-[A-Za-z0-9_-]{12,}\b/gi;
const jwtCredential = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

export function containsCredentialRequest(messages: AdminAssistantMessage[]): boolean {
  return messages.some((message) => credentialTerms.test(message.content));
}

export function removeCredentialMaterial(content: string): string {
  return content
    .replace(labelledCredential, '[credenziale rimossa]')
    .replace(bearerCredential, '[credenziale rimossa]')
    .replace(providerCredential, '[credenziale rimossa]')
    .replace(jwtCredential, '[credenziale rimossa]');
}

export function safeAssistantReply(content: string): string {
  if (credentialTerms.test(content)) {
    return 'Non posso visualizzare, generare o richiedere credenziali private. Posso aiutarti con informazioni operative non sensibili.';
  }
  return removeCredentialMaterial(content).trim();
}

export function buildAdminAssistantMessages(messages: AdminAssistantMessage[]): ChatMessage[] {
  return [
    { role: 'system', content: ADMIN_ASSISTANT_CONTEXT },
    ...messages.map((message) => ({
      role: message.role,
      content: removeCredentialMaterial(message.content),
    })),
  ];
}
