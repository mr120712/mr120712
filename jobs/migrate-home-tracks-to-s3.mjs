// Sposta i "brani in evidenza" (home tracks) da Vercel Blob ad AWS S3, UNA TANTUM.
//
// I brani in evidenza ora sono serviti da S3 (vedi src/lib/music/home-tracks.server.ts). Questo
// script copia i file audio già presenti su Vercel Blob (quelli NON sotto `public-uploads/`) dentro
// il bucket S3, con la stessa chiave. È idempotente: salta gli oggetti già presenti su S3.
//
// In alternativa, essendo i brani in evidenza pochi e curati dall'admin, si possono semplicemente
// ricaricare i file nel bucket S3 dalla console AWS (qualsiasi chiave che NON inizi con
// `public-uploads/`). Questo script serve solo a evitare il lavoro manuale.
//
// Uso (servono i permessi sia su Blob sia su S3):
//   BLOB_READ_WRITE_TOKEN=... AWS_REGION=... AWS_S3_BUCKET=... \
//   AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
//   node jobs/migrate-home-tracks-to-s3.mjs [--dry-run]

import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { list } from '@vercel/blob';

const USER_UPLOAD_PREFIX = 'public-uploads/';
const CONTENT_TYPE_BY_EXT = {
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  m4b: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  webm: 'audio/webm',
  weba: 'audio/webm',
};

const dryRun = process.argv.includes('--dry-run');
const token = process.env.BLOB_READ_WRITE_TOKEN;
const region = process.env.AWS_REGION;
const bucket = process.env.AWS_S3_BUCKET;
const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

function out(line) {
  process.stdout.write(`${line}\n`);
}
function err(line) {
  process.stderr.write(`${line}\n`);
}

function extensionOf(key) {
  const base = key.slice(key.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}
function isHomeAudioKey(key) {
  return !key.startsWith(USER_UPLOAD_PREFIX) && extensionOf(key) in CONTENT_TYPE_BY_EXT;
}

async function existsOnS3(s3, key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!token) {
    err('Manca BLOB_READ_WRITE_TOKEN (sorgente Vercel Blob).');
    process.exitCode = 1;
    return;
  }
  if (!region || !bucket || !accessKeyId || !secretAccessKey) {
    err(
      'Mancano le variabili AWS (AWS_REGION, AWS_S3_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY).',
    );
    process.exitCode = 1;
    return;
  }

  const s3 = new S3Client({ region, credentials: { accessKeyId, secretAccessKey } });
  let copied = 0;
  let skipped = 0;
  let failed = 0;
  let cursor;

  do {
    const result = await list({ token, limit: 1000, cursor });
    for (const blob of result.blobs) {
      if (!isHomeAudioKey(blob.pathname)) continue;

      if (await existsOnS3(s3, blob.pathname)) {
        out(`= già su S3, salto: ${blob.pathname}`);
        skipped += 1;
        continue;
      }
      if (dryRun) {
        out(`~ (dry-run) copierei: ${blob.pathname}`);
        continue;
      }

      try {
        const downloadUrl = blob.downloadUrl ?? blob.url;
        const response = await fetch(downloadUrl);
        if (!response.ok) throw new Error(`download HTTP ${response.status}`);
        const body = Buffer.from(await response.arrayBuffer());
        await s3.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: blob.pathname,
            Body: body,
            ContentType: CONTENT_TYPE_BY_EXT[extensionOf(blob.pathname)],
          }),
        );
        out(`+ copiato: ${blob.pathname} (${body.length} byte)`);
        copied += 1;
      } catch (error) {
        err(
          `! errore su ${blob.pathname}: ${error instanceof Error ? error.message : String(error)}`,
        );
        failed += 1;
      }
    }
    cursor = result.hasMore ? result.cursor : undefined;
  } while (cursor);

  out(`\nFatto. Copiati: ${copied}, saltati (già presenti): ${skipped}, falliti: ${failed}.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  err(`Migrazione non riuscita: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
