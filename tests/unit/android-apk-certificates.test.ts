// @polsia:user-owned — l'APK distribuito da /app (public/solco.apk) deve essere firmato con un
// certificato pubblicato dal sito in public/.well-known/assetlinks.json (Digital Asset Links) e
// dichiarato nel progetto android/ (twa-manifest.json) e in src/lib/android-app.ts, da cui la pagina
// /app prende versione e impronta: è l'accordo che fa aprire la Trusted Web Activity a schermo intero.
// Il test legge il certificato dal blocco di firma dell'APK (schema v2/v3), senza strumenti Android,
// e controlla che il binario apra il dominio ufficiale con la versione dichiarata.
// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  ANDROID_APP_CERT_SHA256,
  ANDROID_APP_HOST,
  ANDROID_APP_PACKAGE,
  ANDROID_APP_VERSION,
  ANDROID_APP_VERSION_CODE,
  ANDROID_LEGACY_CERT_SHA256,
  SHA256_FINGERPRINT_PATTERN,
} from '@/lib/android-app';

const APK_PATH = 'public/solco.apk';
const ASSETLINKS_PATH = 'public/.well-known/assetlinks.json';
const TWA_MANIFEST_PATH = 'android/twa-manifest.json';
const BUILD_GRADLE_PATH = 'android/app/build.gradle';
const STRINGS_PATH = 'android/app/src/main/res/values/strings.xml';

// Firme zip e id dei blocchi di firma Android.
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const SIGNING_BLOCK_MAGIC = 'APK Sig Block 42';
const SIGNATURE_SCHEME_IDS = new Set([0x7109871a, 0xf05368c0, 0x1b93ad61]); // v2, v3, v3.1

type ZipEntry = { method: number; compressedSize: number; localOffset: number };

type AssetStatement = {
  relation: string[];
  target: { namespace: string; package_name: string; sha256_cert_fingerprints: string[] };
};

type TwaManifest = {
  packageId: string;
  host: string;
  appVersionName: string;
  appVersionCode: number;
  appVersion: string;
  fullScopeUrl: string;
  iconUrl: string;
  signingKey: { path: string; alias: string };
  fingerprints: { name?: string; value: string }[];
};

function endOfCentralDirectory(zip: Buffer): number {
  const lowest = Math.max(0, zip.length - 22 - 65_535);
  for (let offset = zip.length - 22; offset >= lowest; offset -= 1) {
    if (zip.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new Error('fine della directory centrale non trovata: non è un file zip');
}

function zipEntries(zip: Buffer): Map<string, ZipEntry> {
  const eocd = endOfCentralDirectory(zip);
  const count = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  const entries = new Map<string, ZipEntry>();
  for (let index = 0; index < count; index += 1) {
    if (zip.readUInt32LE(offset) !== CENTRAL_HEADER_SIGNATURE) {
      throw new Error(`voce ${index} della directory centrale corrotta`);
    }
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    entries.set(name, {
      method: zip.readUInt16LE(offset + 10),
      compressedSize: zip.readUInt32LE(offset + 20),
      localOffset: zip.readUInt32LE(offset + 42),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readZipEntry(zip: Buffer, entries: Map<string, ZipEntry>, name: string): Buffer {
  const entry = entries.get(name);
  if (!entry) throw new Error(`${name} assente dall'APK`);
  const local = entry.localOffset;
  if (zip.readUInt32LE(local) !== LOCAL_HEADER_SIGNATURE) {
    throw new Error(`intestazione locale di ${name} corrotta`);
  }
  const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
  const data = zip.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return inflateRawSync(data);
  throw new Error(`${name}: metodo di compressione ${entry.method} non gestito`);
}

/** Sequenza di elementi con lunghezza (uint32 little-endian) davanti, come nei blocchi di firma. */
function lengthPrefixed(buffer: Buffer): Buffer[] {
  const items: Buffer[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const length = buffer.readUInt32LE(offset);
    items.push(buffer.subarray(offset + 4, offset + 4 + length));
    offset += 4 + length;
  }
  return items;
}

/** Certificati X.509 (DER) dei firmatari di un blocco v2/v3: signed data → digests, certificates, … */
function certificatesOfScheme(block: Buffer): Buffer[] {
  const signersLength = block.readUInt32LE(0);
  return lengthPrefixed(block.subarray(4, 4 + signersLength)).flatMap((signer) => {
    const signedDataLength = signer.readUInt32LE(0);
    const signedData = signer.subarray(4, 4 + signedDataLength);
    const digestsLength = signedData.readUInt32LE(0);
    const certificatesOffset = 4 + digestsLength;
    const certificatesLength = signedData.readUInt32LE(certificatesOffset);
    return lengthPrefixed(
      signedData.subarray(certificatesOffset + 4, certificatesOffset + 4 + certificatesLength),
    );
  });
}

/** Certificati di firma dell'APK letti dall'APK Signing Block (prima della directory centrale). */
function signingCertificates(zip: Buffer): Buffer[] {
  const centralDirectory = zip.readUInt32LE(endOfCentralDirectory(zip) + 16);
  const magic = zip.subarray(centralDirectory - 16, centralDirectory).toString('latin1');
  if (magic !== SIGNING_BLOCK_MAGIC) throw new Error("l'APK non ha un APK Signing Block");
  const blockSize = Number(zip.readBigUInt64LE(centralDirectory - 24));
  const blockStart = centralDirectory - blockSize - 8;
  if (Number(zip.readBigUInt64LE(blockStart)) !== blockSize) {
    throw new Error('APK Signing Block corrotto: le due lunghezze non coincidono');
  }
  const certificates: Buffer[] = [];
  let offset = blockStart + 8;
  const pairsEnd = centralDirectory - 24;
  while (offset < pairsEnd) {
    const pairLength = Number(zip.readBigUInt64LE(offset));
    const id = zip.readUInt32LE(offset + 8);
    if (SIGNATURE_SCHEME_IDS.has(id)) {
      certificates.push(
        ...certificatesOfScheme(zip.subarray(offset + 12, offset + 8 + pairLength)),
      );
    }
    offset += 8 + pairLength;
  }
  return certificates;
}

/** Impronta come la pubblica Digital Asset Links: SHA-256 del DER, coppie maiuscole con i due punti. */
function fingerprintOf(certificate: Buffer): string {
  const hex = createHash('sha256').update(certificate).digest('hex').toUpperCase();
  return hex.replace(/(..)(?!$)/g, '$1:');
}

/** Le risorse compilate possono essere in UTF-8 o UTF-16: il testo conta se compare in una delle due. */
function includesText(binary: Buffer, text: string): boolean {
  return (
    binary.includes(Buffer.from(text, 'utf8')) || binary.includes(Buffer.from(text, 'utf16le'))
  );
}

const apk = readFileSync(APK_PATH);
const entries = zipEntries(apk);
const assetStatements = JSON.parse(readFileSync(ASSETLINKS_PATH, 'utf8')) as AssetStatement[];
const publishedFingerprints = assetStatements[0]?.target.sha256_cert_fingerprints ?? [];
const twaManifest = JSON.parse(readFileSync(TWA_MANIFEST_PATH, 'utf8')) as TwaManifest;
const buildGradle = readFileSync(BUILD_GRADLE_PATH, 'utf8');

describe('APK Android: certificati e Digital Asset Links', () => {
  it("l'APK distribuito è firmato con il certificato pubblicato in assetlinks.json", () => {
    const fingerprints = signingCertificates(apk).map(fingerprintOf);
    expect(fingerprints.length).toBeGreaterThan(0);
    expect(fingerprints).toContain(ANDROID_APP_CERT_SHA256);
    for (const fingerprint of fingerprints) {
      expect(publishedFingerprints).toContain(fingerprint);
    }
  });

  it('assetlinks.json dichiara il package, la relazione della TWA e impronte ben formate', () => {
    expect(assetStatements).toHaveLength(1);
    const statement = assetStatements[0];
    expect(statement?.relation).toContain('delegate_permission/common.handle_all_urls');
    expect(statement?.target.namespace).toBe('android_app');
    expect(statement?.target.package_name).toBe(ANDROID_APP_PACKAGE);
    for (const fingerprint of publishedFingerprints) {
      expect(fingerprint).toMatch(SHA256_FINGERPRINT_PATTERN);
    }
    expect(new Set(publishedFingerprints).size).toBe(publishedFingerprints.length);
    expect(publishedFingerprints).toEqual(
      expect.arrayContaining([ANDROID_APP_CERT_SHA256, ANDROID_LEGACY_CERT_SHA256]),
    );
  });

  it('twa-manifest.json porta gli stessi certificati, la stessa versione e il dominio ufficiale', () => {
    expect(twaManifest.packageId).toBe(ANDROID_APP_PACKAGE);
    expect(twaManifest.host).toBe(ANDROID_APP_HOST);
    expect(twaManifest.appVersionName).toBe(ANDROID_APP_VERSION);
    expect(twaManifest.appVersion).toBe(ANDROID_APP_VERSION);
    expect(twaManifest.appVersionCode).toBe(ANDROID_APP_VERSION_CODE);
    expect(twaManifest.fullScopeUrl).toBe(`https://${ANDROID_APP_HOST}/`);
    expect(twaManifest.iconUrl.startsWith(`https://${ANDROID_APP_HOST}/`)).toBe(true);
    const declared = twaManifest.fingerprints.map((entry) => entry.value);
    expect(declared).toContain(ANDROID_APP_CERT_SHA256);
    expect([...declared].sort()).toEqual([...publishedFingerprints].sort());
    for (const entry of twaManifest.fingerprints) {
      expect((entry.name ?? '').length).toBeGreaterThan(10);
    }
  });

  it('la chiave privata resta fuori da Git', () => {
    expect(twaManifest.signingKey.path.startsWith('./.keys/')).toBe(true);
    const ignored = readFileSync('.gitignore', 'utf8').split('\n');
    expect(ignored).toContain('/android/.keys/');
    expect(buildGradle).not.toMatch(/storePassword\s+["']/);
  });

  it('build.gradle e strings.xml dichiarano package, versione e dominio della pagina /app', () => {
    expect(buildGradle).toContain(`applicationId "${ANDROID_APP_PACKAGE}"`);
    expect(buildGradle).toContain(`versionName "${ANDROID_APP_VERSION}"`);
    expect(buildGradle).toContain(`hostName: '${ANDROID_APP_HOST}'`);
    expect(buildGradle).toContain(`?: '${ANDROID_APP_VERSION_CODE}'`);
    const strings = readFileSync(STRINGS_PATH, 'utf8');
    expect(strings).toContain(`\\"site\\": \\"https://${ANDROID_APP_HOST}\\"`);
  });

  it("l'APK apre il dominio ufficiale e dichiara package e versione mostrati in /app", () => {
    const resources = readZipEntry(apk, entries, 'resources.arsc');
    expect(includesText(resources, `https://${ANDROID_APP_HOST}/`)).toBe(true);
    expect(includesText(resources, `"site": "https://${ANDROID_APP_HOST}"`)).toBe(true);
    expect(includesText(resources, 'solcomusic.vercel.app')).toBe(false);
    expect(includesText(resources, '://solcomusic.app')).toBe(false);
    const manifest = readZipEntry(apk, entries, 'AndroidManifest.xml');
    expect(includesText(manifest, ANDROID_APP_PACKAGE)).toBe(true);
    expect(includesText(manifest, ANDROID_APP_VERSION)).toBe(true);
  });
});
