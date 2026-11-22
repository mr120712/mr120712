// @polsia:user-owned — contratto condiviso (route + pannello) della chat di «Skynet»: il
// proprietario fa una domanda, Skynet cerca in tutte le sue fonti e risponde
// (src/lib/skynet/chat.server.ts). Mai segreti né indirizzi IP interi, in nessuna direzione.
import { z } from 'zod';

/** Turni di conversazione mandati al server (i più vecchi il pannello li lascia cadere). */
export const SKYNET_CHAT_MAX_TURNS = 12;
/** Lunghezza massima di un turno della conversazione, e della domanda (l'ultimo). */
export const SKYNET_CHAT_MAX_MESSAGE = 4_000;
export const SKYNET_CHAT_MAX_QUESTION = 1_000;
/**
 * Chi ha scritto la risposta: GPT-6 (MagnetAPI, il primo motore), Claude, la riserva AI, il codice
 * (solo fatti) o un comando eseguito.
 */
export const SKYNET_CHAT_ENGINES = ['gpt6', 'claude', 'reserve', 'facts', 'command'] as const;

export const SkynetChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(SKYNET_CHAT_MAX_MESSAGE),
});

export const SkynetChatRequestSchema = z
  .object({
    messages: z.array(SkynetChatMessageSchema).min(1).max(SKYNET_CHAT_MAX_TURNS),
  })
  .superRefine((request, context) => {
    const last = request.messages.at(-1);
    if (last?.role !== 'user') {
      context.addIssue({ code: 'custom', message: 'L’ultimo messaggio deve essere una domanda.' });
    } else if (last.content.length > SKYNET_CHAT_MAX_QUESTION) {
      context.addIssue({ code: 'custom', message: 'La domanda è troppo lunga.' });
    }
  });

export const SkynetChatResponseSchema = z.object({
  reply: z.string().min(1),
  engine: z.enum(SKYNET_CHAT_ENGINES),
  /** Il modello preciso quando lo si sa (es. «gpt-6.2-sol»). */
  model: z.string().max(60).optional(),
  /** Le fonti che Skynet ha letto per rispondere, e quelle che non hanno risposto. */
  sources: z.array(z.string()),
  missing: z.array(z.string()),
});

export type SkynetChatMessage = z.infer<typeof SkynetChatMessageSchema>;
export type SkynetChatResponse = z.infer<typeof SkynetChatResponseSchema>;

/** Domande d'esempio: nel pannello e nella risposta a /skynet senza testo. */
export const SKYNET_CHAT_SUGGESTIONS = [
  'Cosa è successo oggi?',
  'Chi sta attaccando il sito?',
  'Il firewall è a posto?',
  'Come sta l’autodifesa?',
  'Ci sono stati problemi questa settimana?',
] as const;
