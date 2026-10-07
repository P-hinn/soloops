import { Queue } from 'bullmq'
import IORedis from 'ioredis'
import { env } from './env.js'

export const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null })

export const QUEUE_NAMES = {
  uptime: 'uptime',
  pipelines: 'pipelines',
  digest: 'digest',
  calendar: 'calendar',
  automations: 'automations',
} as const

export const uptimeQueue = new Queue(QUEUE_NAMES.uptime, { connection })
export const pipelineQueue = new Queue(QUEUE_NAMES.pipelines, { connection })
export const digestQueue = new Queue(QUEUE_NAMES.digest, { connection })
export const calendarQueue = new Queue(QUEUE_NAMES.calendar, { connection })
/**
 * Two kinds of job: `sync` pulls the n8n mirror, `dispatch` posts one soloops
 * event to one webhook. Both here because they share the rate at which n8n
 * can be bothered.
 */
export const automationQueue = new Queue(QUEUE_NAMES.automations, { connection })

export type DigestJob = {
  projectId?: string
  kind: 'project' | 'week' | 'meeting'
  meetingId?: string
}
