import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const expired = await prisma.userMusicCollectionItem.deleteMany({
    where: { source: 'youtube', expiresAt: { lte: new Date() } },
  });
  process.stdout.write(`Elementi YouTube scaduti rimossi: ${expired.count}\n`);
}

main()
  .catch(() => {
    process.stderr.write('Pulizia metadati YouTube non riuscita.\n');
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
