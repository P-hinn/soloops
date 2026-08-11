import { Queue } from 'bullmq'
import IORedis from 'ioredis'
import { env } from './env.js'

export const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null })

export const QUEUE_NAMES = {
  transcribe: 'transcribe',
  uptime: 'uptime',
  pipelines: 'pipelines',
  digest: 'digest',
} as const

export const transcribeQueue = new Queue(QUEUE_NAMES.transcribe, { connection })
export const uptimeQueue = new Queue(QUEUE_NAMES.uptime, { connection })
export const pipelineQueue = new Queue(QUEUE_NAMES.pipelines, { connection })
export const digestQueue = new Queue(QUEUE_NAMES.digest, { connection })

export type TranscribeJob = { meetingId: string }
export type DigestJob = { projectId?: string; kind: 'project' | 'week' | 'meeting'; meetingId?: string }
