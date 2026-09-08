import 'dotenv/config';
import { APP_CONFIG_DEFAULTS } from '../src/lib/app-config-defaults.js';
import { createPrismaClient } from '../src/lib/prisma.js';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is not set (copy backend/.env.example to backend/.env).');

const prisma = createPrismaClient(connectionString);

async function main() {
  for (const [key, value] of Object.entries(APP_CONFIG_DEFAULTS)) {
    // Existing values win: seeding must never clobber a limit an operator tuned.
    await prisma.appConfig.upsert({
      where: { key },
      update: {},
      create: { key, value: String(value) },
    });
  }

  const rows = await prisma.appConfig.findMany({ orderBy: { key: 'asc' } });
  console.log('AppConfig seeded (PRD §5 limits):');
  for (const row of rows) console.log(`  ${row.key} = ${row.value}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
