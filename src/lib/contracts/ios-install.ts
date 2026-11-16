// @polsia:user-owned — contratto condiviso (client + route) dell'installazione dell'app iOS dal sito:
// lo stato per l'utente (pagina /app), lo stato e le azioni dell'amministratore (/admin/app-ios).
import { z } from 'zod';
import { IOS_IPA_MAX_BYTES, IOS_IPA_METHODS } from '@/lib/ios-app';

export const IosIpaMethodSchema = z.enum(IOS_IPA_METHODS);

/** Risposta di GET /api/ios/install (solo con sessione). */
export const IosInstallStatusSchema = z.object({
  /** C'è un IPA attivo e installabile da link. */
  available: z.boolean(),
  bundleId: z.string().min(1),
  version: z.string().min(1).nullable(),
  method: IosIpaMethodSchema.nullable(),
  uploadedAt: z.string().nullable(),
  /** Link itms-services con il token dell'utente; null se non disponibile. */
  installUrl: z.string().nullable(),
  /** Scadenza del token (ISO), null se non disponibile. */
  expiresAt: z.string().nullable(),
  /** Spiegazione quando non è disponibile (nessun IPA, firma non adatta, storage spento). */
  reason: z.enum(['none', 'not_configured', 'method']).nullable(),
});
export type IosInstallStatus = z.infer<typeof IosInstallStatusSchema>;

/** L'IPA attivo come lo conserva il server (ios-app/current.json nello store). */
export const IosIpaRecordSchema = z.object({
  version: z.string().min(1).max(40),
  bundleId: z.string().min(1).max(200),
  pathname: z.string().min(1).max(300),
  url: z.string().url().max(2000),
  sizeBytes: z.number().int().nonnegative(),
  uploadedAt: z.string().datetime(),
  method: IosIpaMethodSchema,
  /** Dispositivi nel profilo Ad Hoc / sviluppo; null per Enterprise, App Store o sconosciuto. */
  devices: z.number().int().nonnegative().nullable(),
});
export type IosIpaRecord = z.infer<typeof IosIpaRecordSchema>;

/** Risposta di GET /api/admin/ios-app. */
export const IosAdminStatusSchema = z.object({
  /** Lo store Vercel Blob è configurato (senza, niente caricamenti né installazioni). */
  configured: z.boolean(),
  current: IosIpaRecordSchema.nullable(),
  expectedBundleId: z.string().min(1),
  expectedVersion: z.string().min(1),
});
export type IosAdminStatus = z.infer<typeof IosAdminStatusSchema>;

/** Corpo di POST /api/admin/ios-app: attiva l'IPA appena caricato nello store. */
export const IosIpaActivateRequestSchema = z.object({
  blobUrl: z.string().url().max(2000),
  size: z.number().int().positive().max(IOS_IPA_MAX_BYTES),
});
export type IosIpaActivateRequest = z.infer<typeof IosIpaActivateRequestSchema>;

export const IosIpaActivateResponseSchema = z.object({ current: IosIpaRecordSchema });

/** Messaggi mostrati nella pagina admin e in /app. */
export const IOS_INSTALL_MESSAGES = {
  notConfigured: 'Lo store dei file (Vercel Blob) non è configurato sul server.',
  none: 'Nessun IPA attivo: carica un IPA firmato Ad Hoc dalla pagina admin «App iOS».',
  method:
    "L'IPA attivo è firmato per l'App Store: si installa solo da TestFlight o dall'App Store, non da un link.",
} as const;
