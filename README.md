<h1 align="center">soloops</h1>

<p align="center">
  <strong>Ein selbst gehostetes Betriebssystem für die Solo-Selbstständigkeit.</strong><br>
  Kalender, Meetings, Notizen, Projekte, Uptime, CI/CD, Zeiten, Rechnungen —<br>
  an einem Ort, auf der eigenen Maschine, mit MCP-Zugang für Claude.
</p>

<p align="center">
  <img alt="Lizenz MIT" src="https://img.shields.io/badge/Lizenz-MIT-171714?style=flat-square">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.9-3178c6?style=flat-square&logo=typescript&logoColor=white">
  <img alt="Node 22" src="https://img.shields.io/badge/Node-22-5fa04e?style=flat-square&logo=nodedotjs&logoColor=white">
  <img alt="Vue 3" src="https://img.shields.io/badge/Vue-3.5-42b883?style=flat-square&logo=vuedotjs&logoColor=white">
  <img alt="Fastify 5" src="https://img.shields.io/badge/Fastify-5-171714?style=flat-square&logo=fastify&logoColor=white">
  <img alt="Prisma 6" src="https://img.shields.io/badge/Prisma-6-2d3748?style=flat-square&logo=prisma&logoColor=white">
  <img alt="PostgreSQL 17" src="https://img.shields.io/badge/PostgreSQL-17-4169e1?style=flat-square&logo=postgresql&logoColor=white">
  <img alt="Docker Compose" src="https://img.shields.io/badge/Docker-Compose-2496ed?style=flat-square&logo=docker&logoColor=white">
  <img alt="MCP" src="https://img.shields.io/badge/MCP-22%20Tools-d8ff55?style=flat-square&labelColor=171714">
</p>

<p align="center">
  <a href="#schnellstart">Schnellstart</a> ·
  <a href="#module">Module</a> ·
  <a href="#kalender-sync-in-beide-richtungen">Kalender-Sync</a> ·
  <a href="#mcp-server">MCP</a> ·
  <a href="#deployment-auf-einem-kleinen-server">Deployment</a>
</p>

---

## Inhalt

- [Schnellstart](#schnellstart) — von null auf laufend in vier Befehlen
- [Designsystem](#designsystem) — Tokens, Regeln, Klassen
- [Werkzeuge und Regeln](#werkzeuge-und-regeln) — Prettier, ESLint, die 1000-Zeilen-Grenze
- [E2E über alle Browser](#e2e-über-alle-browser) — Playwright-Kit, auch für andere Projekte
- [Architektur](#architektur) — vier Apps, ein Monorepo
- [Module](#module) — was das Ding tatsächlich kann
- [Kalender-Sync in beide Richtungen](#kalender-sync-in-beide-richtungen) — Google, CalDAV, Konfliktregeln
- [MCP-Server](#mcp-server) — 22 Tools für Claude
- [Authentifizierung](#authentifizierung)
- [Betrieb](#betrieb) — Logs, Schemaänderungen, Backup
- [Deployment auf einem kleinen Server](#deployment-auf-einem-kleinen-server) — 2 Kerne, 2 GB RAM
- [Sicherheitshinweise](#sicherheitshinweise-für-den-produktivbetrieb)
- [Lizenz](#lizenz)

---

## Schnellstart

**Voraussetzungen:** Docker mit Compose v2. Node 22 nur, wenn du Linter, Tests
oder den MCP-Server außerhalb der Container laufen lassen willst.

**1. Konfiguration anlegen**

```bash
cp .env.example .env
```

In der `.env` mindestens setzen: `POSTGRES_PASSWORD`, `DATABASE_URL` (gleiches Passwort),
`JWT_SECRET`, `SERVICE_TOKEN`, `OWNER_PASSWORD`. Secrets erzeugen:

```bash
openssl rand -hex 32
```

**2. Hochfahren**

```bash
docker compose up -d --build
```

**3. Owner-Konto und zwei Beispielprojekte anlegen**

```bash
docker compose exec api npm -w @soloops/api run seed
```

**4. Einloggen** unter http://localhost:5174 mit `OWNER_EMAIL` und
`OWNER_PASSWORD`. Beim ersten Login startet der Rundgang.

| Dienst   | URL                   |
| -------- | --------------------- |
| Frontend | http://localhost:5174 |
| API      | http://localhost:3000 |
| Postgres | localhost:5433        |

---

## Designsystem

Die Oberfläche übernimmt die Bildsprache von philippniestroj.com. Die Tokens
liegen zentral in [`apps/web/src/style.css`](apps/web/src/style.css) und sind
1:1 die der Website:

| Token                            | Wert                  | Rolle                             |
| -------------------------------- | --------------------- | --------------------------------- |
| `--color-paper`                  | `#f1efe8`             | warmes Off-White, Grundfläche     |
| `--color-ink`                    | `#171714`             | Text, Primärbutton, starke Rahmen |
| `--color-soft` / `--color-muted` | `#575750` / `#6c6b64` | Fließtext, Sekundäres             |
| `--color-acid`                   | `#d8ff55`             | Limette — der eine laute Akzent   |
| `--color-blue`                   | `#5c76ff`             | Kicker-Labels und Links           |
| `--color-line`                   | `rgba(23,23,20,.15)`  | Haarlinie                         |

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

## Werkzeuge und Regeln

```bash
npm run check      # Format, Linter, Typen und Tests in einem Lauf
npm run format     # Prettier über alles
npm run lint:fix   # ESLint mit Autokorrektur
npm run test       # RRULE-Expander (11 Fälle)
```

**Prettier** macht die Formatierung (keine Semikolons, einfache
Anführungszeichen, 100 Zeichen), **tsc** die Typen. Der **Linter** kümmert sich
nur um das, was beide nicht sehen — allen voran die **Obergrenze von 1000
Zeilen pro Datei** (`max-lines`, Leerzeilen und Kommentare zählen nicht mit,
damit gute Dokumentation nicht bestraft wird). Wer sie reißt, hat zwei Dinge in
einer Datei. Größte Datei aktuell: `CalendarView.vue` mit 814 Zeilen.

### E2E über alle Browser

```bash
npm run e2e:install                     # einmalig: Chromium, Firefox, WebKit
npm run e2e                             # Oberfläche in allen drei Engines
E2E_BROWSERS=webkit npm run e2e         # nur Safari-Engine
npm -w @soloops/web run e2e:ui          # interaktiv, mit Zeitreise
```

Die Tests liegen in [`apps/web/e2e/`](apps/web/e2e) und brauchen nur Vite —
die API ist gemockt ([`mock-api.ts`](apps/web/e2e/mock-api.ts)), und zwar
streng: ein Endpunkt ohne Attrappe antwortet 501 und lässt den Test scheitern.
Jeder Test prüft nebenbei automatisch auf JS-Fehler, `console.error` und
5xx-Antworten; die Smoke-Tests zusätzlich Barrierefreiheit (axe, WCAG 2.2 AA)
und seitliches Scrollen. In CI läuft das pro Browser als eigener Job
([`.github/workflows/e2e.yml`](.github/workflows/e2e.yml)).

Zwei Dinge sind bewusst ausgenommen und im Code begründet: **Farbkontraste**
(`--color-muted` und das Kicker-Blau liegen unter 4,5:1 — eine Entscheidung
am Designsystem) und **Mobilgeräte** (es gibt noch kein Layout unter ~1024px).

Das Kit selbst ([`packages/e2e`](packages/e2e/README.md)) ist
projektunabhängig und lässt sich in jedes andere Webprojekt einbauen:

```bash
npm run e2e:init -- ../anderes-projekt --routes /,/preise,/kontakt
```

### Abhängigkeiten

Bewusst **nicht** mitgezogen, jeweils mit Grund:

| Paket         | Aktuell | Verfügbar       | Warum nicht                                                               |
| ------------- | ------- | --------------- | ------------------------------------------------------------------------- |
| TypeScript    | 5.9     | 7.0             | Neu geschriebener Compiler, noch keine belastbare Erfahrung mit `vue-tsc` |
| Prisma        | 6.19    | 7.10 (8 als RC) | Großer Migrationsschritt; lohnt als eigener Vorgang, nicht nebenbei       |
| Zod           | 3.25    | 4.4             | Geänderte Semantik bei `.default()`/`.optional()` quer durch alle Schemas |
| `@types/node` | 22      | 26              | Muss zur Laufzeit im Container passen, und die ist Node 22                |

Offen und bekannt: `deepmerge-ts@7.1.5` unter `@prisma/config` hat eine
Stack-Erschöpfung bei rekursiven Objektgraphen (GHSA-ggr8-5vv4-36mx, hoch).
Der Pfad ist die Prisma-**CLI** (`generate`, `db push`), nicht die Query-Engine,
und verarbeitet ausschließlich die eigene Konfiguration — praktisch keine
Angriffsfläche. Ein npm-`override` auf 8.x greift mit npm 11 nicht durch; die
Lücke verschwindet mit dem Prisma-Upgrade.

---

## Architektur

```
apps/
  api/        Fastify + Prisma + Postgres — REST-API, PDF-Rendering, AI-Aufrufe
  worker/     BullMQ — Kalender-Sync, UptimeRobot-Poll, CI/CD-Poll, Tages-Digests
  web/        Vue 3 + Vite + Tailwind — die Oberfläche
  mcp/        MCP-Server (stdio) für Claude Code / Claude Desktop
packages/
  shared/     Zod-Schemas und Formatierer, die API, Web und MCP teilen
  e2e/        Playwright-Kit für E2E über alle Browser — auch für andere Projekte
```

Worker und API teilen sich Prisma-Client und Service-Layer über relative Importe —
ein Monorepo, eine Quelle der Wahrheit, keine doppelten Integrationen.

---

## Module

**Onboarding.** Beim ersten Login startet ein Rundgang in sieben Schritten
(Scheinwerfer auf das jeweilige Element, weiter mit → oder Klick, Esc bricht ab).
Danach bleibt auf dem Dashboard eine Einrichtungsliste, die den **echten Zustand
liest**: sie hakt nur ab, was tatsächlich existiert — angelegte Kunden, erfasste
Zeiten, verbundene Kalender, gesetzte Umgebungsvariablen. Bewusst nichts, was man
selbst abhaken kann; eine solche Liste sagt nach zwei Wochen nichts mehr über den
Zustand aus. Standardmäßig ist sie eine Zeile — Fortschritt und nächster Schritt;
alle Schritte auf Klick. Ausblenden geht jederzeit, zurückholen unter
_Einstellungen_.

**Schnelleingabe.** Ein Feld auf dem Dashboard: „Termin für neues Projekt mit
Beispiel GmbH nächste Woche" wird zu einem _Plan_ — Kunde, Projekt, Termin,
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

**Meetings.** Meeting anlegen (legt optional den Kalendereintrag mit an), Mitschrift
tippen, danach optional eine AI-Zusammenfassung mit Entscheidungen und Action Items.

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

**Zeiterfassung.** Stoppuhr oben auf _Zeiten_: Projekt (das zuletzt bebuchte ist
vorgewählt), Beschreibung, Start. Während sie läuft, lässt sich die Beschreibung
nachtragen; „Verwerfen" stoppt und löscht in einem Zug, damit keine
Zwei-Sekunden-Buchung in der Auswertung landet. „Weiter mit" nimmt die zuletzt
gebuchten Kombinationen per Klick wieder auf. Der laufende Timer ist in
Seitenleiste und Kopfzeile sichtbar; Start auf einem Projekt stoppt einen
laufenden automatisch. Dazu Nachträge und Wochen-/Monatsauswertung mit Gegenwert
in Euro. Stundensatz: Projekt > Kunde > globaler Default.

Einen Passwort-Manager gibt es bewusst nicht — dafür ist 1Password da. soloops
speichert nur die Zugangsdaten, die es selbst zum Synchronisieren braucht
(Kalender-Tokens, verschlüsselt at rest).

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

Einrichtung unter _Einstellungen_. Der Abgleich läuft danach automatisch
(`CALENDAR_SYNC_CRON`, Standard alle 10 Minuten) und lässt sich pro Konto auf
_nur lesen_ oder _nur schreiben_ stellen.

**Google Calendar** — OAuth mit Scope `calendar`, mehr nicht. Der Abgleich läuft
inkrementell über Googles `syncToken`; läuft der ab, wird automatisch einmal voll
gelesen. `singleEvents=true` löst Serien in Einzeltermine auf, dadurch sind auch
wiederkehrende Termine vollständig editierbar.

Vorbereitung: in der Google Cloud Console die Calendar API aktivieren, eine
OAuth-Client-ID (Webanwendung) anlegen und als Redirect-URI exakt
`http://localhost:3000/api/calendar-accounts/google/callback` eintragen.

**Apple / iCloud** — über CalDAV, mit einem _app-spezifischen Passwort_
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

### Was geschrieben wird, und was nicht

Genau ein Konto trägt die Markierung **Zielkalender**. Nur dorthin gehen Termine,
die in soloops entstehen. Ein Termin, der aus Kalender A stammt, wird nie nach
Kalender B kopiert — sonst vervielfältigt sich bei mehreren verbundenen
Kalendern jeder Eintrag über alle hinweg.

**Gelöscht wird in der Gegenstelle nur mit ausdrücklicher Freigabe** pro Konto,
Standard ist aus. Ein Fehlgriff in soloops soll nicht Termine auf allen Geräten
entfernen.

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
Projekte, Timer, Zeitnachträge, Notizen, Meetings, Betriebsstatus, offene Zeiten,
Rechnungsentwürfe, Umsatz.

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
der Container führt beim Start `prisma db push` aus. Es gibt bewusst keinen
Migrationsordner: ein Nutzer, eine Datenbank, `db push` reicht. Wer das ändert,
sollte vorher ein Backup ziehen — `db push` kann Spalten fallen lassen.

### Konfiguration

Alle Umgebungsvariablen stehen kommentiert in
[`.env.example`](.env.example); [`apps/api/src/env.ts`](apps/api/src/env.ts) ist
die verbindliche Quelle mit Typen und Defaults. Fehlt etwas Pflichtiges, startet
die API gar nicht erst und sagt, was.

### Backup

Zwei Dinge müssen mit: die Datenbank und `./data` (Rechnungs-PDFs). Die `.env`
gehört in den Passwort-Manager, nicht ins Backup-Archiv.

```bash
# Sichern
docker compose exec -T postgres pg_dump -U soloops -Fc soloops > soloops-$(date +%F).dump
tar czf soloops-data-$(date +%F).tar.gz data/

# Zurückspielen
docker compose exec -T postgres pg_restore -U soloops -d soloops --clean --if-exists < soloops-2026-01-01.dump
```

Der Kalender-Sync ist **kein** Backup: er trägt Änderungen weiter, auch das
Löschen. Und `allowRemoteDelete` steht pro Konto standardmäßig auf aus, damit ein
Fehlgriff hier nicht die Termine auf allen Geräten mitnimmt.

### Fehlersuche

| Symptom                                     | Ursache und Abhilfe                                                                 |
| ------------------------------------------- | ----------------------------------------------------------------------------------- |
| API startet nicht, Log nennt Variablennamen | Pflichtfeld in `.env` fehlt oder ist zu kurz (`JWT_SECRET` braucht 16+ Zeichen)     |
| Login schlägt fehl, obwohl `.env` stimmt    | Seed lief nie: `docker compose exec api npm -w @soloops/api run seed`               |
| Termine fehlen in der Wochenansicht         | Konto neu verbunden? Erster Sync holt nur das Zeitfenster — Log von `worker` prüfen |
| CalDAV meldet Anmeldefehler                 | Apple braucht ein app-spezifisches Passwort, nicht das Apple-ID-Passwort            |
| Web lädt, API antwortet mit 502             | API-Container noch im Start (`prisma db push`); `docker compose logs -f api`        |

---

## Deployment auf einem kleinen Server

Ausgelegt auf die Maschine, auf der auch das Portfolio läuft: **2 Kerne, 1,92 GB
RAM, Port 3000 belegt**. `docker-compose.prod.yml` ist eine eigenständige
Compose-Datei, kein Override.

```bash
cp .env.example .env       # ausfüllen, NODE_ENV=production, APP_URL setzen
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml exec api npm -w @soloops/api run seed
```

Was anders ist als in der Entwicklung:

|              | Entwicklung                       | Produktion                                  |
| ------------ | --------------------------------- | ------------------------------------------- |
| Web          | Vite-Devserver (`tsx watch`, HMR) | statisches Bundle hinter nginx              |
| Offene Ports | 5174 Web, 3000 API, 5433 Postgres | genau einer: `SOLOOPS_PORT` (Standard 8090) |
| Quellcode    | vom Host gemountet                | im Image                                    |
| Node         | `tsx watch`                       | `tsx`, `NODE_OPTIONS=--max-old-space-size`  |

nginx liefert das Bundle aus und proxyt `/api` und `/health` an die API — die
API selbst hat keinen Port nach außen, Postgres und Redis auch nicht.
`SOLOOPS_PORT` ist bewusst **nicht** 3000; dahinter gehört ein Reverse Proxy mit
TLS. Alle Betriebsbefehle oben — Logs, Backup, Restore — gelten hier genauso, nur
mit `-f docker-compose.prod.yml`.

### Speicher

Grenzen pro Dienst (`mem_limit`) und was im Leerlauf tatsächlich anfällt:

| Dienst      | Grenze      | gemessen (idle) |
| ----------- | ----------- | --------------- |
| api         | 384 MB      | 138 MB          |
| worker      | 320 MB      | 103 MB          |
| postgres    | 320 MB      | 32 MB           |
| redis       | 96 MB       | 11 MB           |
| web (nginx) | 64 MB       | 10 MB           |
| **Summe**   | **1184 MB** | **294 MB**      |

Postgres läuft mit `shared_buffers=96MB` und `max_connections=30` statt der
Standardwerte, die für deutlich mehr RAM gedacht sind. Redis ist auf 64 MB
gedeckelt mit `maxmemory-policy noeviction` — BullMQ-Jobs sollen bei vollem
Speicher hart scheitern und im Log auftauchen, nicht stillschweigend verschwinden.

Der Engpass ist nicht der Betrieb, sondern der **Build**: `npm install` plus
Vite-Build auf zwei Kernen. Der Web-Build läuft deshalb mit
`build:only` (ohne `vue-tsc`, das läuft in `npm run check`) und gedeckeltem Heap.
Wenn der Build auf dem Server trotzdem eng wird, vorher Swap anlegen oder das
Image auf dem Entwicklungsrechner bauen und in eine Registry schieben.

---

## Sicherheitshinweise für den Produktivbetrieb

- `postgres` und `redis` nicht nach außen mappen — beide haben keine eigene
  Authentifizierung. Die [Produktions-Compose](#deployment-auf-einem-kleinen-server)
  tut das bereits nicht; nur die Entwicklungs-Compose legt Postgres auf 5433.
- Hinter einen Reverse Proxy mit TLS stellen; `SERVICE_TOKEN` taucht im ICS-Feed
  als Query-Parameter auf und gehört nicht über HTTP übertragen.
- `.env` ist in `.gitignore` und sollte es bleiben.
- PDFs liegen unverschlüsselt im `./data`-Volume — Backup entsprechend
  behandeln.

---

## Lizenz

[MIT](LICENSE) — Philipp Niestroj.
