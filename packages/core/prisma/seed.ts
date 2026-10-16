import { PrismaClient } from '@prisma/client'
import { hashPassword } from '../src/auth.js'
import { env } from '../src/env.js'

const prisma = new PrismaClient()

async function main() {
  const user = await prisma.user.upsert({
    where: { email: env.OWNER_EMAIL },
    create: {
      email: env.OWNER_EMAIL,
      name: env.OWNER_NAME,
      passwordHash: await hashPassword(env.OWNER_PASSWORD),
    },
    update: {},
  })
  console.log(`✓ Nutzer ${user.email}`)

  const existingProjects = await prisma.project.count()
  if (existingProjects === 0) {
    const client = await prisma.client.create({
      data: {
        name: 'Beispiel GmbH',
        company: 'Beispiel GmbH',
        email: 'buchhaltung@beispiel.de',
        street: 'Industriestraße 7',
        zip: '44137',
        city: 'Dortmund',
        hourlyRateCents: env.INVOICE_DEFAULT_HOURLY_RATE_CENTS,
        paymentTermDays: 14,
      },
    })
    await prisma.project.create({
      data: {
        key: 'BSP-DWH',
        name: 'Data Warehouse Ablösung',
        description: 'Migration der Altsysteme auf ein modernes Datenmodell.',
        clientId: client.id,
        status: 'ACTIVE',
        color: '#6366f1',
      },
    })
    await prisma.project.create({
      data: {
        key: 'INTERN',
        name: 'Interne Arbeit',
        description: 'Akquise, Buchhaltung, Weiterbildung.',
        status: 'ACTIVE',
        color: '#64748b',
      },
    })
    console.log('✓ Beispielkunde und zwei Projekte angelegt')
  }
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err)
    await prisma.$disconnect()
    process.exit(1)
  })
