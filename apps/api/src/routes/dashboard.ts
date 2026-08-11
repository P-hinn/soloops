import type { FastifyPluginAsync } from 'fastify'
import { prisma } from '../db.js'

const routes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', app.authenticate)

  /** Ein Aufruf, ein Bild: Termine, Timer, Betrieb, Geld, offene Punkte. */
  app.get('/', async () => {
    const now = new Date()
    const todayStart = new Date(now)
    todayStart.setHours(0, 0, 0, 0)
    const todayEnd = new Date(todayStart)
    todayEnd.setDate(todayEnd.getDate() + 1)
    const weekStart = new Date(todayStart)
    weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7))
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

    const [
      todayEvents,
      upcomingMeetings,
      runningTimer,
      weekTime,
      monthTime,
      unbilled,
      openInvoices,
      overdueInvoices,
      monitorsDown,
      failedRuns,
      openActions,
      activeProjects,
    ] = await Promise.all([
      prisma.calendarEvent.findMany({
        where: { startsAt: { lt: todayEnd }, endsAt: { gt: todayStart } },
        orderBy: { startsAt: 'asc' },
        include: { project: { select: { key: true, color: true } } },
      }),
      prisma.meeting.findMany({
        where: { startsAt: { gte: now }, status: { not: 'DONE' } },
        orderBy: { startsAt: 'asc' },
        take: 5,
        include: { project: { select: { key: true } }, client: { select: { name: true } } },
      }),
      prisma.timeEntry.findFirst({
        where: { endedAt: null },
        include: { project: { select: { id: true, key: true, name: true, color: true } } },
      }),
      prisma.timeEntry.aggregate({
        where: { startedAt: { gte: weekStart }, endedAt: { not: null } },
        _sum: { durationSec: true },
      }),
      prisma.timeEntry.aggregate({
        where: { startedAt: { gte: monthStart }, endedAt: { not: null } },
        _sum: { durationSec: true },
      }),
      prisma.timeEntry.findMany({
        where: { billable: true, invoiceItemId: null, endedAt: { not: null } },
        select: { durationSec: true, rateCents: true },
      }),
      prisma.invoice.aggregate({
        where: { status: { in: ['SENT', 'OVERDUE'] } },
        _sum: { totalCents: true },
        _count: true,
      }),
      prisma.invoice.findMany({
        where: { status: { in: ['SENT', 'OVERDUE'] }, dueDate: { lt: now } },
        include: { client: { select: { name: true } } },
        orderBy: { dueDate: 'asc' },
      }),
      prisma.monitor.findMany({ where: { status: { in: [8, 9] } } }),
      prisma.pipelineRun.findMany({
        where: { status: 'FAILED' },
        orderBy: { startedAt: 'desc' },
        take: 5,
        include: { repo: { select: { slug: true, provider: true } } },
      }),
      prisma.actionItem.findMany({
        where: { done: false },
        orderBy: [{ dueOn: 'asc' }, { createdAt: 'asc' }],
        take: 10,
        include: { project: { select: { key: true } }, meeting: { select: { title: true } } },
      }),
      prisma.project.count({ where: { status: 'ACTIVE' } }),
    ])

    const unbilledCents = unbilled.reduce(
      (sum, e) => sum + Math.round((e.durationSec / 3600) * (e.rateCents ?? 0)),
      0,
    )

    return {
      today: { events: todayEvents },
      upcomingMeetings,
      runningTimer,
      time: {
        weekSec: weekTime._sum.durationSec ?? 0,
        monthSec: monthTime._sum.durationSec ?? 0,
        unbilledSec: unbilled.reduce((s, e) => s + e.durationSec, 0),
        unbilledCents,
      },
      money: {
        openCents: openInvoices._sum.totalCents ?? 0,
        openCount: openInvoices._count,
        overdue: overdueInvoices.map((i) => ({
          id: i.id,
          number: i.number,
          client: i.client.name,
          dueDate: i.dueDate,
          totalCents: i.totalCents,
          daysLate: Math.floor((now.getTime() - i.dueDate.getTime()) / 86_400_000),
        })),
      },
      ops: { monitorsDown, failedRuns },
      openActions,
      activeProjects,
    }
  })
}

export default routes
