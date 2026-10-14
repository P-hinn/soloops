# Authentication

Three ways into the API:

- **JWT** for the interface (`POST /api/auth/login`, valid for 30 days)
- **`SERVICE_TOKEN`** as a bearer token for the worker, the MCP server and the
  ICS feed
- **Automation tokens** (`slp_…`) for n8n workflows, created per connection
  under _Automatisierungen → Verbindungen_

Passwords are hashed with scrypt (no native module required). Automation
tokens are stored as a SHA-256 hash and shown exactly once — 192 random bits
have nothing to brute-force, and a deliberately slow hash would be a
self-inflicted rate limit on every call a workflow makes.

The automation tokens are scoped by surface, not only by right. One does
**not** pass the ordinary gate: it opens `/api/automations/connector` and
nothing else — not the mailbox, not the invoices, not every route that happens
to exist. Widening that is a deliberate edit to one route file rather than a
side effect of minting a token. Within the connector, anything that is not a
`GET` needs the `write` scope.
