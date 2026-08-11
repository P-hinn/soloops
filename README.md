# soloops

Ein selbst gehostetes Betriebssystem für die Solo-Selbstständigkeit: Kalender,
Meetings mit lokalem Transkript, Notizen, Projektübersichten mit AI-Lagebericht,
Uptime, CI/CD, Passwort-Manager, Zeiterfassung, Rechnungen und lexoffice-Anbindung —
plus ein MCP-Server, damit Claude auf all das zugreifen kann.

TypeScript überall, Vue 3 im Frontend, alles über `docker compose`.

---

## Schnellstart

```bash
cp .env.example .env
```

In der `.env` mindestens setzen: `POSTGRES_PASSWORD`, `DATABASE_URL` (gleiches Passwort),
`JWT_SECRET`, `SERVICE_TOKEN`, `OWNER_PASSWORD`. Secrets erzeugen:

```bash
openssl rand -hex 32
```

Dann hochfahren:

```bash
docker compose up -d --build
```

Beim ersten Start das Owner-Konto und zwei Beispielprojekte anlegen:

```bash
docker compose exec api npm -w @soloops/api run seed
```

| Dienst | URL |
| --- | --- |
| Frontend | http://localhost:5174 |
| API | http://localhost:3000 |
| Transkription | http://localhost:8080/health |
| Postgres | localhost:5433 |

Der Transkriptions-Container lädt beim ersten Lauf das Whisper-Modell (~1,5 GB bei
`medium`) und braucht entsprechend lange. Wer ihn zunächst nicht braucht, startet
ohne ihn:

```bash
docker compose up -d postgres redis api worker web
```

---

## Architektur

```
apps/
  api/        Fastify + Prisma + Postgres — REST-API, PDF-Rendering, AI-Aufrufe
  worker/     BullMQ — Transkription, UptimeRobot-Poll, CI/CD-Poll, Tages-Digests
  web/        Vue 3 + Vite + Tailwind — die Oberfläche
  mcp/        MCP-Server (stdio) für Claude Code / Claude Desktop
packages/
  shared/     Zod-Schemas und Formatierer, die API, Web und MCP teilen
services/
  transcribe/ FastAPI + faster-whisper — läuft lokal, Audio verlässt den Host nicht
```

Worker und API teilen sich Prisma-Client und Service-Layer über relative Importe —
ein Monorepo, eine Quelle der Wahrheit, keine doppelten Integrationen.

---

## Module

**Kalender.** Wochenansicht, Termine mit Projektbezug, ICS-Feed zum Abonnieren in
Apple/Google Kalender (`/api/calendar/feed.ics?token=<SERVICE_TOKEN>`), plus eine
Freie-Slots-Berechnung für Terminvorschläge.

**Meetings & Transkript.** Meeting anlegen (legt optional den Kalendereintrag mit an),
Aufnahme hochladen → BullMQ-Job → faster-whisper im Nachbarcontainer → Transkript mit
Zeitmarken. Direkt danach optional eine AI-Zusammenfassung mit Entscheidungen und
Action Items.

**Notizen.** Markdown, Tags, Projektbezug, deutsche Postgres-Volltextsuche
(GIN-Index über Titel + Body, angelegt beim API-Start).

**Projektübersichten mit AI.** Pro Projekt ein Lagebericht: Status-Ampel, nächste
Schritte mit Dringlichkeit, Risiken, Abrechnungshinweis. Erzeugt über Structured
Outputs (`claude-opus-5`, adaptives Thinking), damit die UI ein festes Schema
rendert statt Freitext zu parsen. Werktags 7:30 Uhr baut der Worker alle Berichte neu.

**Uptime.** Spiegelt UptimeRobot-Monitore inkl. Down-Logs alle 5 Minuten; Monitore
lassen sich Projekten zuordnen und tauchen dann in der Projektansicht auf.

**CI/CD.** GitHub Actions und GitLab Pipelines, alle 3 Minuten gepollt, ebenfalls
projektbezogen.

**Passwort-Manager.** Zero-Knowledge: PBKDF2-SHA-512 (600.000 Iterationen) aus dem
Master-Passwort + serverseitigem Salt, AES-256-GCM pro Eintrag. Der Server speichert
ausschließlich Ciphertext, IV und Klartext-Metadaten (Titel, URL, Ordner, Tags) für
die Suche. Der Schlüssel liegt nur im Speicher der Browser-Session — Reload heißt
neu entsperren. Master-Passwort verloren = Einträge verloren.

**Zeiterfassung.** Ein globaler Timer, überall sichtbar; Start auf einem Projekt
stoppt einen laufenden automatisch. Nachträge und Wochen-/Monatsauswertung mit
Gegenwert in Euro. Stundensatz: Projekt > Kunde > globaler Default.

**Rechnungen.** „Aus Zeiten erstellen" nimmt alle offenen, abrechenbaren Einträge
eines Kunden im Zeitraum, gruppiert sie pro Projekt und verknüpft die Zeiteinträge
fest mit der Position — damit landet nichts zweimal auf einer Rechnung. PDF wird
serverseitig mit pdfkit gerendert (DIN-5008-nah, §19-UStG-Hinweis wenn konfiguriert).
Fortlaufende Nummern pro Jahr. Gestellte Rechnungen sind gesperrt und können nur
storniert werden.

**Buchhaltung.** lexoffice-Adapter: Kontakte anlegen, Rechnungen als finalisiertes
Dokument übertragen (`finalize=true`), Monatsumsatz netto/USt/brutto für die
USt-Voranmeldung.

---

## MCP-Server

Gibt Claude Zugriff auf den kompletten Datenbestand — Tagesüberblick, Suche,
Projekte, Timer, Zeitnachträge, Notizen, Meetings inkl. Transkript, Betriebsstatus,
offene Zeiten, Rechnungsentwürfe, Umsatz.

```bash
SOLOOPS_URL=http://localhost:3000 \
SOLOOPS_TOKEN=<SERVICE_TOKEN> \
claude mcp add soloops -- npx tsx /pfad/zu/soloops/apps/mcp/src/index.ts
```

Verfügbare Tools: `soloops_today`, `soloops_search`, `soloops_list_projects`,
`soloops_get_project`, `soloops_project_digest`, `soloops_timer_status`,
`soloops_timer_start`, `soloops_timer_stop`, `soloops_log_time`,
`soloops_time_report`, `soloops_free_slots`, `soloops_create_event`,
`soloops_list_meetings`, `soloops_get_meeting`, `soloops_summarize_meeting`,
`soloops_create_note`, `soloops_list_notes`, `soloops_ops_status`,
`soloops_unbilled_time`, `soloops_list_invoices`,
`soloops_draft_invoice_from_time`, `soloops_revenue`.

Schreibende Tools sind bewusst zurückhaltend: `soloops_draft_invoice_from_time`
erzeugt nur einen Entwurf — Versand und Übertragung an lexoffice bleiben manuell.

---

## Authentifizierung

Zwei Wege in die API:

- **JWT** für die Oberfläche (`POST /api/auth/login`, 30 Tage gültig)
- **`SERVICE_TOKEN`** als Bearer für Worker, MCP-Server und den ICS-Feed

Passwörter werden mit scrypt gehasht (kein natives Modul nötig).

---

## Betrieb

```bash
docker compose logs -f api worker    # Logs
docker compose exec api npm -w @soloops/api run db:studio   # Prisma Studio
docker compose down                  # stoppen
```

Schemaänderungen: `prisma/schema.prisma` anpassen, dann `docker compose restart api` —
der Container führt beim Start `prisma db push` aus.

Typecheck über alle Workspaces:

```bash
npm run typecheck
```

---

## Sicherheitshinweise für den Produktivbetrieb

- `transcribe` und `postgres` nicht nach außen mappen (Port-Einträge in
  `docker-compose.yml` entfernen) — beide haben keine eigene Authentifizierung.
- Hinter einen Reverse Proxy mit TLS stellen; `SERVICE_TOKEN` taucht im ICS-Feed
  als Query-Parameter auf und gehört nicht über HTTP übertragen.
- `.env` ist in `.gitignore` und sollte es bleiben.
- Aufnahmen und PDFs liegen unverschlüsselt im `./data`-Volume — Backup entsprechend
  behandeln.
