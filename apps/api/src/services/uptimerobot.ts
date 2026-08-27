import { prisma } from '../db.js'
import { env } from '../env.js'

type RobotMonitor = {
  id: number
  friendly_name: string
  url: string
  type: number
  status: number
  interval: number
  average_response_time?: string
  custom_uptime_ratio?: string
  logs?: {
    type: number
    datetime: number
    duration: number
    reason?: { code: string; detail: string }
  }[]
}

/**
 * UptimeRobot v2 ist eine form-encoded POST-API. Wir spiegeln Monitore und
 * Down-Logs, damit die Projektübersicht ohne zweiten Tab auskommt.
 */
export async function syncUptimeRobot(): Promise<{ monitors: number; incidents: number }> {
  if (!env.UPTIMEROBOT_API_KEY) throw new Error('UPTIMEROBOT_API_KEY nicht gesetzt')

  const body = new URLSearchParams({
    api_key: env.UPTIMEROBOT_API_KEY,
    format: 'json',
    logs: '1',
    logs_limit: '20',
    custom_uptime_ratios: '1-7-30',
    response_times: '1',
    response_times_average: '60',
  })

  const res = await fetch('https://api.uptimerobot.com/v2/getMonitors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
    body,
  })
  if (!res.ok) throw new Error(`UptimeRobot HTTP ${res.status}`)

  const json = (await res.json()) as {
    stat: string
    error?: { message: string }
    monitors?: RobotMonitor[]
  }
  if (json.stat !== 'ok') throw new Error(json.error?.message ?? 'UptimeRobot-Fehler')

  let incidentCount = 0
  for (const m of json.monitors ?? []) {
    const ratios = (m.custom_uptime_ratio ?? '').split('-').map(Number)
    const monitor = await prisma.monitor.upsert({
      where: { uptimeRobotId: BigInt(m.id) },
      create: {
        uptimeRobotId: BigInt(m.id),
        friendlyName: m.friendly_name,
        url: m.url,
        type: m.type,
        status: m.status,
        intervalSec: m.interval,
        ratio24h: ratios[0] ?? null,
        ratio7d: ratios[1] ?? null,
        ratio30d: ratios[2] ?? null,
        avgResponseMs: m.average_response_time ? Math.round(Number(m.average_response_time)) : null,
        lastCheckedAt: new Date(),
      },
      update: {
        friendlyName: m.friendly_name,
        url: m.url,
        status: m.status,
        intervalSec: m.interval,
        ratio24h: ratios[0] ?? null,
        ratio7d: ratios[1] ?? null,
        ratio30d: ratios[2] ?? null,
        avgResponseMs: m.average_response_time ? Math.round(Number(m.average_response_time)) : null,
        lastCheckedAt: new Date(),
      },
    })

    // log.type 1 = down, 2 = up
    for (const log of m.logs ?? []) {
      if (log.type !== 1) continue
      const startedAt = new Date(log.datetime * 1000)
      const externalId = `${log.datetime}`
      await prisma.incident.upsert({
        where: { monitorId_externalId: { monitorId: monitor.id, externalId } },
        create: {
          monitorId: monitor.id,
          externalId,
          startedAt,
          durationSec: log.duration || null,
          endedAt: log.duration ? new Date((log.datetime + log.duration) * 1000) : null,
          reason: log.reason ? `${log.reason.code} ${log.reason.detail}` : null,
        },
        update: {
          durationSec: log.duration || null,
          endedAt: log.duration ? new Date((log.datetime + log.duration) * 1000) : null,
        },
      })
      incidentCount++
    }
  }

  return { monitors: json.monitors?.length ?? 0, incidents: incidentCount }
}
