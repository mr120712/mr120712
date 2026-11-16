// @polsia:user-owned — ispezione di un IPA (zip) senza strumenti Apple: trova Payload/<app>.app,
// legge Info.plist (binario o XML) per confermare identificativo e versione attesi, e dal profilo di
// provisioning incorporato capisce come è firmato: Ad Hoc o sviluppo (elenco di dispositivi),
// Enterprise (tutti i dispositivi) o App Store (nessun elenco: non si installa da un link). Serve
// all'attivazione dell'IPA nella pagina admin e al test tests/unit/ios-install.test.ts.
import { inflateRawSync } from 'node:zlib';
import type { IosIpaMethod } from '@/lib/ios-app';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const MAX_ENTRIES = 50_000;
/** Dimensione massima di una voce letta in memoria (Info.plist e profilo sono piccoli). */
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;

export type ZipEntry = {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
};

export type IpaInspection =
  | {
      ok: true;
      appName: string;
      bundleId: string;
      version: string;
      method: IosIpaMethod;
      devices: number | null;
    }
  | {
      ok: false;
      error:
        | 'not_zip'
        | 'no_app'
        | 'no_info_plist'
        | 'bundle_id'
        | 'version'
        | 'unsigned'
        | 'too_large_entry';
      message: string;
    };

function endOfCentralDirectory(zip: Buffer): number | null {
  if (zip.length < 22) return null;
  const lowest = Math.max(0, zip.length - 22 - 65_535);
  for (let offset = zip.length - 22; offset >= lowest; offset -= 1) {
    if (zip.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  return null;
}

/** Le voci della directory centrale; null se il file non è uno zip leggibile. */
export function listZipEntries(zip: Buffer): ZipEntry[] | null {
  const eocd = endOfCentralDirectory(zip);
  if (eocd === null) return null;
  const count = Math.min(zip.readUInt16LE(eocd + 10), MAX_ENTRIES);
  let offset = zip.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== CENTRAL_HEADER_SIGNATURE) {
      return null;
    }
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    entries.push({
      name: zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'),
      method: zip.readUInt16LE(offset + 10),
      compressedSize: zip.readUInt32LE(offset + 20),
      localOffset: zip.readUInt32LE(offset + 42),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Il contenuto di una voce (solo "stored" o "deflate"); null se corrotta o troppo grande. */
export function readZipEntry(zip: Buffer, entry: ZipEntry): Buffer | null {
  const local = entry.localOffset;
  if (local + 30 > zip.length || zip.readUInt32LE(local) !== LOCAL_HEADER_SIGNATURE) return null;
  if (entry.compressedSize > MAX_ENTRY_BYTES) return null;
  const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
  const data = zip.subarray(start, start + entry.compressedSize);
  if (data.length !== entry.compressedSize) return null;
  try {
    if (entry.method === 0) return Buffer.from(data);
    if (entry.method === 8) {
      const inflated = inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
      return inflated;
    }
  } catch {
    return null;
  }
  return null;
}

function includesText(binary: Buffer, text: string): boolean {
  return binary.includes(Buffer.from(text, 'utf8'));
}

/** Il valore XML di una chiave del plist, se il plist è in XML (il binario si cerca per byte). */
function xmlPlistString(plist: string, key: string): string | null {
  const match = plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`));
  return match?.[1] ?? null;
}

/** Quanti dispositivi elenca un profilo Ad Hoc o di sviluppo. */
function provisionedDeviceCount(profile: string): number | null {
  const start = profile.indexOf('<key>ProvisionedDevices</key>');
  if (start < 0) return null;
  const end = profile.indexOf('</array>', start);
  if (end < 0) return null;
  return (profile.slice(start, end).match(/<string>/g) ?? []).length;
}

/**
 * Ispeziona l'IPA e confronta identificativo e versione con quelli attesi dal sito: un IPA di
 * un'altra app o di un'altra versione non viene attivato.
 */
export function inspectIpa(
  zip: Buffer,
  expected: { bundleId: string; version: string },
): IpaInspection {
  const entries = listZipEntries(zip);
  if (!entries)
    return { ok: false, error: 'not_zip', message: 'Il file non è uno zip (IPA) leggibile.' };
  const appDir = entries
    .map((entry) => entry.name.match(/^Payload\/([^/]+\.app)\//)?.[1] ?? null)
    .find((name): name is string => name !== null);
  if (!appDir) {
    return { ok: false, error: 'no_app', message: "L'IPA non contiene Payload/<app>.app." };
  }
  const prefix = `Payload/${appDir}/`;
  const byName = new Map(entries.map((entry) => [entry.name, entry] as const));
  const infoEntry = byName.get(`${prefix}Info.plist`);
  const info = infoEntry ? readZipEntry(zip, infoEntry) : null;
  if (!infoEntry) {
    return { ok: false, error: 'no_info_plist', message: `Manca ${prefix}Info.plist.` };
  }
  if (!info) {
    return { ok: false, error: 'too_large_entry', message: 'Info.plist non leggibile.' };
  }
  const infoText = info.toString('latin1');
  const bundleId = xmlPlistString(infoText, 'CFBundleIdentifier');
  if ((bundleId ?? '') !== expected.bundleId && !includesText(info, expected.bundleId)) {
    return {
      ok: false,
      error: 'bundle_id',
      message: `L'IPA non è di ${expected.bundleId}${bundleId ? ` (trovato ${bundleId})` : ''}.`,
    };
  }
  const version = xmlPlistString(infoText, 'CFBundleShortVersionString');
  if ((version ?? '') !== expected.version && !includesText(info, expected.version)) {
    return {
      ok: false,
      error: 'version',
      message: `L'IPA non è la versione ${expected.version}${version ? ` (trovato ${version})` : ''} attesa dal sito.`,
    };
  }

  const profileEntry = byName.get(`${prefix}embedded.mobileprovision`);
  const signature = byName.get(`${prefix}_CodeSignature/CodeResources`);
  if (!profileEntry || !signature) {
    return {
      ok: false,
      error: 'unsigned',
      message:
        "L'IPA non è firmato (manca il profilo di provisioning o la firma): va firmato con un certificato Apple prima di pubblicarlo.",
    };
  }
  const profile = readZipEntry(zip, profileEntry)?.toString('latin1') ?? '';
  let method: IosIpaMethod = 'unknown';
  let devices: number | null = null;
  if (profile.includes('<key>ProvisionsAllDevices</key>')) {
    method = 'enterprise';
  } else if (profile.includes('<key>ProvisionedDevices</key>')) {
    devices = provisionedDeviceCount(profile);
    method = /<key>get-task-allow<\/key>\s*<true\/>/.test(profile) ? 'development' : 'ad-hoc';
  } else if (profile.includes('<key>Entitlements</key>')) {
    method = 'app-store';
  }
  return {
    ok: true,
    appName: appDir.replace(/\.app$/, ''),
    bundleId: expected.bundleId,
    version: expected.version,
    method,
    devices,
  };
}
