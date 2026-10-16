/**
 * A rule that says no.
 *
 * Services do not know about HTTP, but they do know the difference between
 * "that does not exist", "that is not allowed any more" and "that input makes
 * no sense" — and the caller has to be able to tell those apart without
 * matching on message text.
 *
 * So the status travels with the error. The API's error handler turns it into
 * a response; anything else (the worker, a script) can read it or ignore it.
 * The message is German on purpose: it is shown to the user, and inventing a
 * second, English copy of it for translation would be a layer nobody reads.
 */
export class RuleError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 422 = 422,
  ) {
    super(message)
    this.name = 'RuleError'
  }
}

/** Not there. */
export const notFound = (message: string) => new RuleError(message, 404)
/** There, but it may not be done — already invoiced, already issued. */
export const conflict = (message: string) => new RuleError(message, 409)
/** Asked for something that cannot be: an end before its start. */
export const invalid = (message: string) => new RuleError(message, 422)
