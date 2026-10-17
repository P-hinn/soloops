# Security notes for production

- Do not map `postgres` and `redis` to the outside — neither has
  authentication of its own. The
  [production compose](deployment.md) already doesn't; only the
  development compose exposes Postgres on 5433.
- Put it behind a reverse proxy with TLS; `SERVICE_TOKEN` appears in the ICS
  feed as a query parameter and has no business travelling over plain HTTP.
- `.env` is in `.gitignore` and should stay there.
- PDFs sit unencrypted in the `./data` volume — treat backups accordingly. So
  do the files filed at a customer, in `./data/dateien`.
- A file at a customer can be anything that was uploaded, so it is handed out
  as a download and never sniffed, unless its type is on the allowlist in
  `isInlineSafe`. Rendering an uploaded HTML page or SVG in place would run
  its script against soloops' own origin.
- Mail bodies sit in Postgres in plain text. If you don't want that, don't
  connect a mailbox; there is no half-way version.
- The IMAP password is encrypted with `JWT_SECRET`. Rotate that key and the
  account has to be reconnected — by design. The same holds for the n8n API
  key and the trigger secrets.
- **n8n runs arbitrary code.** A workflow can execute JavaScript and reach
  anything on the Docker network, so `/n8n/` deserves the same protection as
  the rest of the application and n8n's own owner account deserves a real
  password. The production compose gives it no port of its own; it is only
  reachable through nginx.
- Revoke an automation token when the workflow using it is gone. It is scoped
  to the connector surface, but that surface still writes leads, projects,
  tasks, time and notes.
- If you let soloops sign you in to n8n, it holds an n8n password, encrypted
  with `JWT_SECRET`. The session it relays carries no browser binding — n8n
  would otherwise refuse it in your browser — so that cookie works wherever it
  is presented. It is HttpOnly and same-origin, but treat it like the password
  it stands in for.
- Event payloads land in the delivery log, including the lead data they
  carried. That log lives in Postgres like everything else — the same backup
  and the same caveats apply.

Found a vulnerability? Please report it privately through GitHub's security
advisories rather than opening a public issue.
