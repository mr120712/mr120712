// @polsia:user-owned — chat Telegram dell'owner (SKYNET_TELEGRAM_CHAT_IDS): UN solo parser, tollerante,
// condiviso da chi decide «questa chat è dell'owner?» (comando /video, comandi riservati nel menu, /id).

type Env = Record<string, string | undefined>;

/**
 * Gli ID di chat dell'owner. Tollerante a come il valore viene incollato nelle variabili d'ambiente:
 * separatori virgola, punto e virgola, spazi o a capo, e virgolette attorno. Contano solo gli interi
 * (gli ID Telegram lo sono; negativi per i gruppi): un valore non numerico, es. `@username`, è ignorato.
 */
export function ownerTelegramChatIds(env: Env = process.env): string[] {
  return (env.SKYNET_TELEGRAM_CHAT_IDS ?? '')
    .split(/[\s,;]+/)
    .map((id) => id.replace(/^["'`]+|["'`]+$/g, ''))
    .filter((id) => /^-?\d+$/.test(id));
}
