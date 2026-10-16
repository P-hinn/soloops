/**
 * The middle of soloops: the database, the configuration, the queues and the
 * rules that act on them.
 *
 * It exists because the API and the worker are two processes over one set of
 * rules. Before this package the worker reached into `apps/api/src` with a
 * dozen relative imports, without declaring the API as a dependency — it
 * worked only because npm hoists everything into one node_modules, and the
 * worker was missing half the packages the code it imported needed.
 *
 * This barrel carries the three things nearly every caller wants. Everything
 * else is reached by its own path, which keeps the names of 45 services from
 * having to be unique across all of them:
 *
 *     import { prisma } from '@soloops/core'
 *     import { createTask } from '@soloops/core/services/taskWrite.js'
 */
export { dbRaw, ensureSearchIndexes, initSync, prisma } from './db.js'
export { env, type Env } from './env.js'
export * from './queue.js'
