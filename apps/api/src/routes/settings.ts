import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod'
import { z, ZodError } from 'zod'
import {
  describeSettings,
  isSettingKey,
  REGISTRY,
  setSetting,
  type SettingKey,
} from '@soloops/core/settings.js'
import { invalid } from '@soloops/core/rules.js'

/**
 * Configuration a person changes, as opposed to configuration a container
 * needs. See packages/core/src/settings.ts for which is which and why
 * JWT_SECRET can never be in here.
 *
 * `source: 'env' | 'db'` travels with every value on purpose: once the
 * database has an answer, editing the .env stops having an effect, and the
 * interface has to be able to say that rather than let somebody wonder.
 */
const routes: FastifyPluginAsyncZod = async (app) => {
  app.addHook('onRequest', app.authenticate)

  app.get('/', async () => describeSettings())

  app.patch(
    '/',
    {
      schema: {
        // An object of whatever keys the registry knows. Validated per key
        // below against that key's own schema, which is the only place that
        // knows a tax rate is a number between 0 and 100.
        body: z.record(z.string(), z.unknown()),
      },
    },
    async (req) => {
      const unknown = Object.keys(req.body).filter((key) => !isSettingKey(key))
      if (unknown.length) {
        throw invalid(`Unbekannte Einstellung: ${unknown.join(', ')}`)
      }

      for (const [key, value] of Object.entries(req.body)) {
        try {
          await setSetting(key as SettingKey, value)
        } catch (err) {
          // Name the field and say what is wrong with it. A form that only
          // says "invalid" is a form somebody fills in twice — and a
          // ZodError's `message` is the whole issue list as JSON, so the
          // first issue's own message is what is readable here.
          const label = REGISTRY[key as SettingKey].label
          const reason =
            err instanceof ZodError
              ? (err.issues[0]?.message ?? 'ungültig')
              : (err as Error).message
          throw invalid(`${label}: ${reason}`)
        }
      }

      return describeSettings()
    },
  )
}

export default routes
