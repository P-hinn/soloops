import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import {
  idParam,
  reserveCostInput,
  reserveMonthInput,
  reserveYearInput,
  yearMonthParam,
  yearParam,
} from '@soloops/shared'
import { prisma } from '@soloops/core/db.js'
import { ensureYear, listYears, readYear } from '@soloops/core/services/reserve.js'

/**
 * Die Rücklagenrechnung.
 *
 * Lesen legt nichts an — ein Jahr entsteht erst, wenn etwas hineingeschrieben
 * wird, und erbt dabei Sätze und Kostenposten vom Vorjahr. Deshalb geht jeder
 * Schreibzugriff hier durch `ensureYear` und nicht durch einen eigenen
 * "Jahr anlegen"-Aufruf, den die Oberfläche vorher nicht vergessen darf.
 */
const routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('onRequest', app.authenticate)

  app.get('/', async () => listYears())

  app.get('/:year', { schema: { params: yearParam } }, async (req) => readYear(req.params.year))

  app.patch(
    '/:year',
    { schema: { params: yearParam, body: reserveYearInput.partial() } },
    async (req) => {
      const { year } = req.params
      const stored = await ensureYear(year)
      await prisma.reserveYear.update({ where: { id: stored.id }, data: req.body })
      return readYear(year)
    },
  )

  app.put(
    '/:year/months/:month',
    { schema: { params: yearMonthParam, body: reserveMonthInput } },
    async (req) => {
      const { year, month } = req.params
      const stored = await ensureYear(year)
      await prisma.reserveMonth.upsert({
        where: { yearId_month: { yearId: stored.id, month } },
        create: { yearId: stored.id, month, ...req.body },
        update: req.body,
      })
      return readYear(year)
    },
  )

  app.post(
    '/:year/costs',
    { schema: { params: yearParam, body: reserveCostInput } },
    async (req, reply) => {
      const { year } = req.params
      const stored = await ensureYear(year)
      const { position, ...rest } = req.body
      // Neue Posten hinten anstellen, statt alle auf 0 zu setzen: die
      // Reihenfolge der Liste ist die, in der man sie eingetippt hat.
      const last = await prisma.reserveCost.findFirst({
        where: { yearId: stored.id },
        orderBy: { position: 'desc' },
        select: { position: true },
      })
      await prisma.reserveCost.create({
        data: {
          yearId: stored.id,
          position: position ?? (last ? last.position + 1 : 0),
          ...rest,
        },
      })
      return reply.code(201).send(await readYear(year))
    },
  )

  app.patch(
    '/costs/:id',
    { schema: { params: idParam, body: reserveCostInput.partial() } },
    async (req) => {
      const cost = await prisma.reserveCost.update({
        where: { id: req.params.id },
        data: req.body,
        include: { year: { select: { year: true } } },
      })
      return readYear(cost.year.year)
    },
  )

  app.delete('/costs/:id', { schema: { params: idParam } }, async (req) => {
    const cost = await prisma.reserveCost.delete({
      where: { id: req.params.id },
      include: { year: { select: { year: true } } },
    })
    return readYear(cost.year.year)
  })
}

export default routes
