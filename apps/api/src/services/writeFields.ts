/**
 * Fields on their way into a create or an update.
 *
 * An empty e-mail field means "nobody", and that has to reach the database
 * as NULL: every "do I already know this address" query treats '' as a value
 * and would match two clients that both have none.
 *
 * Only when the key is actually there, though. A PATCH body carries the
 * fields that changed, so `email: data.email || null` on a body that does
 * not mention the address turns every other edit into a deletion — which is
 * exactly what used to happen when a customer's phone number was corrected.
 */
export function withCleanEmail<T extends { email?: string | null }>(data: T): T {
  return 'email' in data ? { ...data, email: data.email || null } : data
}
