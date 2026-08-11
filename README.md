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

## Designsystem

Die Oberfläche übernimmt die Bildsprache von philippniestroj.com. Die Tokens
liegen zentral in [`apps/web/src/style.css`](apps/web/src/style.css) und sind
1:1 die der Website:

| Token | Wert | Rolle |
| --- | --- | --- |
| `--color-paper` | `#f1efe8` | warmes Off-White, Grundfläche |
| `--color-ink` | `#171714` | Text, Primärbutton, starke Rahmen |
| `--color-soft` / `--color-muted` | `#575750` / `#6c6b64` | Fließtext, Sekundäres |
| `--color-acid` | `#d8ff55` | Limette — der eine laute Akzent |
| `--color-blue` | `#5c76ff` | Kicker-Labels und Links |
| `--color-line` | `rgba(23,23,20,.15)` | Haarlinie |

Drei Regeln tragen den Look:

1. **Radius 0 überall — außer bei Buttons.** Flächen, Karten, Inputs und Badges
   sind scharfkantig; Buttons sind immer vollrunde Pillen.
2. **Linien statt Kästen.** Tabellen und Raster werden durch Haarlinien
   gegliedert, nicht durch abgesetzte Boxen. Kennzahlen stehen unter einer
   kräftigen Oberkante, ohne Rahmen.
3. **Kicker-Labels.** Abschnitte tragen kein `<h2>` in Fließtextgröße, sondern
   ein kleines, gesperrtes Versal-Label in Blau (`.eyebrow`).

Schrift: **Space Grotesk** (variabel 400–700, selbst gehostet unter
`apps/web/public/fonts/`) für Überschriften, Zahlen und alles Tabellarische;
Helvetica Neue/Arial für Fließtext. Ziffern laufen überall tabellarisch, damit
Beträge und Zeiten in Spalten untereinander stehen.

Wiederverwendbare Klassen: `.card`, `.btn-primary` / `.btn-ghost` / `.btn-acid` /
`.btn-xs`, `.input`, `.label`, `.badge` (+ `-acid` / `-good` / `-warn` / `-bad` /
`-blue`), `.table`, `.eyebrow`, `.display-xl`, `.prose-note`.

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

**Schnelleingabe.** Ein Feld auf dem Dashboard: „Termin für neues Projekt mit
Beispiel GmbH nächste Woche" wird zu einem *Plan* — Kunde, Projekt, Termin,
Videoraum, Meeting, Notiz, offene Punkte. Der Plan ist editierbar und wird erst
auf Knopfdruck angelegt. Bewusst zweistufig: unterspezifizierte Sätze sind die
Regel, und stilles Anlegen produziert mehr Aufräumarbeit als es spart. Daneben
Schnellaktionen für Timer, Meeting, Termin, Notiz und Abrechnen.

Die KI bekommt als Kontext die bestehenden Kunden und Projekte sowie die echten
freien Zeitfenster der nächsten zwei Wochen — sie erfindet also weder Kunden neu,
die es schon gibt, noch Termine, die kollidieren. Was sie geraten hat, steht als
Liste unter „Angenommen".

**Kalender.** Wochenansicht, Termine mit Projektbezug, Freie-Slots-Berechnung,
ICS-Feed zum Abonnieren (`/api/calendar/feed.ics?token=<SERVICE_TOKEN>`) — und
echter Zwei-Wege-Sync mit Google und Apple, siehe unten.

**Videoräume.** Jedes Meeting und jeder Termin kann per Häkchen einen Raum
bekommen. Standard ist **Jitsi**: kein Konto, keine Einrichtung, der Raumname
enthält 8 Zufallszeichen (bei Jitsi ist der Name das einzige Geheimnis). Mit
verbundenem Google-Konto lässt sich stattdessen **Google Meet** erzeugen; ein
eigener Dauerraum (Zoom, Teams) geht über `VIDEO_CUSTOM_URL` oder pro Meeting
als eigener Link. Der Raum landet in Meeting, Kalendereintrag, ICS-Feed und in
beiden Fremdkalendern.

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

## Kalender-Sync in beide Richtungen

Einrichtung unter *Einstellungen*. Der Abgleich läuft danach automatisch
(`CALENDAR_SYNC_CRON`, Standard alle 10 Minuten) und lässt sich pro Konto auf
*nur lesen* oder *nur schreiben* stellen.

**Google Calendar** — OAuth mit Scope `calendar`, mehr nicht. Der Abgleich läuft
inkrementell über Googles `syncToken`; läuft der ab, wird automatisch einmal voll
gelesen. `singleEvents=true` löst Serien in Einzeltermine auf, dadurch sind auch
wiederkehrende Termine vollständig editierbar.

Vorbereitung: in der Google Cloud Console die Calendar API aktivieren, eine
OAuth-Client-ID (Webanwendung) anlegen und als Redirect-URI exakt
`http://localhost:3000/api/calendar-accounts/google/callback` eintragen.

**Apple / iCloud** — über CalDAV, mit einem *app-spezifischen Passwort*
(appleid.apple.com → Anmeldung und Sicherheit). Das normale Apple-Passwort
funktioniert nicht. Änderungen kommen über WebDAV-Sync (RFC 6578); unterstützt
ein Server das nicht, fällt soloops auf einen ETag-Vergleich zurück und meldet
das in der Kalenderliste.

Funktioniert genauso gegen Nextcloud, Fastmail oder Radicale — `CALDAV_APPLE_URL`
zeigen lassen, wohin man will.

### Wie Konflikte entschieden werden

Jede Verknüpfung merkt sich zwei Stände: was zuletzt hinausgeschrieben wurde und
was zuletzt hereingeholt wurde. Damit erkennt der Sync einen Termin, den er
gerade selbst gepusht hat, und schreibt ihn nicht erneut — sonst gäbe es eine
Endlosschleife zwischen den Systemen.

Haben sich **beide Seiten** seit dem letzten Abgleich geändert, gewinnt der
jüngere Zeitstempel. Es wird nichts feldweise zusammengeführt, und die
Entscheidung landet im Log und in der Sync-Meldung. Löschungen hinterlassen einen
Grabstein, damit sie auch dann noch weiterwandern, wenn der lokale Termin schon
weg ist.

### Zwei bewusste Grenzen

- **Serien aus CalDAV werden nur gelesen.** Sie erscheinen als ein Termin, sind
  als schreibgeschützt markiert und werden nie zurückgeschrieben. Wiederholungs-
  regeln korrekt bidirektional zu behandeln (Ausnahmen, verschobene Einzeltermine,
  Zeitzonenwechsel) ist ein eigenes Projekt. Bei Google stellt sich die Frage
  nicht, weil dort Instanzen synchronisiert werden.
- **Ohne WebDAV-Sync erkennt der CalDAV-Fallback keine Löschungen.** Ein auf der
  Apple-Seite gelöschter Termin bliebe lokal stehen. Statt zu raten (und dabei
  Termine außerhalb des Zeitfensters zu verlieren) lässt soloops ihn stehen und
  zeigt beim Verbinden einen Hinweis.

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
