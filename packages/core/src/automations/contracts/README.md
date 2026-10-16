# Vertragsautomatisierung

`SoloOps → n8n → Zoho Sign`. Am Kunden „Vertrag" drücken, Felder ausfüllen, fertig:
Kundendaten werden gezogen, das Template gefüllt, Gotenberg macht ein PDF, Zoho Sign
schickt es an den Kunden und an dich. Kommt beides unterschrieben zurück, hakt sich die
Aufgabe ab, die Notiz wird geschrieben und das signierte PDF landet beim Kunden.

`SETUP.md` ist die ursprüngliche Anleitung und beschreibt das Zielbild. Dieses Dokument
sagt, was davon jetzt tatsächlich im Repo steht, was sich dabei geändert hat — und die
zwei Dinge, die nur du machen kannst.

## Was du noch tun musst

**1. Zoho-Credentials und IBAN eintragen.** Die Zoho-Werte stehen **nicht** in der
`.env`, sondern in n8n → Credentials → **„Zoho Sign"** (liegt angelegt und leer bereit):
Client ID, Client Secret, Refresh Token. Über die Umgebung könnte sie jeder Workflow auf
der Instanz lesen, eine Credential sieht nur, wer sie im Node auswählt.

Self Client auf **api-console.zoho.eu**, Scope `ZohoSign.documents.ALL`, Code gegen einen
Refresh Token tauschen (Befehl in `SETUP.md`). Zoho Sign braucht den API-Plan, der freie
hat keine API. Die Workflows sprechen mit `accounts.zoho.eu` und `sign.zoho.eu`; ein
US-Konto braucht in beiden JSONs die `.com`-Hosts.

Die Bankverbindung steht im Workflow, nicht im Repo: n8n → **Vertrag versenden** → Node
**„Eingabe prüfen & Konfig"** → `CONFIG.an.an_bank`. Dort steht derzeit
`IBAN: DE.. ← eintragen`. Gleiche Stelle, falls die Adresse nach dem Umzug nicht mehr
stimmt.

**2. Zoho-Webhook registrieren.** Zoho Sign → Einstellungen → Webhooks → Event
`RequestCompleted` auf die Produktions-URL des zweiten Workflows:

```
<deine öffentliche soloops-URL>/n8n/webhook/zoho-sign-abgeschlossen-hxulz8ejt8ggfd3g
```

Der Zufallsteil am Ende ist Absicht: Zoho kann keinen eigenen Header mitschicken, also
ist der Pfad das Geheimnis. **Nicht weitergeben** — wer ihn kennt, kann Verträge als
signiert melden. Lokal erreichbar unter
`http://localhost:5174/n8n/webhook/zoho-sign-abgeschlossen-hxulz8ejt8ggfd3g`; Zoho muss von außen
drankommen, für einen Test tut ein Tunnel.

Danach einmal an dich selbst versenden und die Signaturfelder prüfen (siehe
„Kalibrierung" unten).

## Was gebaut wurde

### n8n

Beide Workflows sind importiert und **aktiv** (`Vertrag versenden …`,
`Vertrag signiert …`). Die drei ►-NoOp-Platzhalter sind durch echte SoloOps-Nodes
ersetzt:

| vorher                 | jetzt                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| ► get_client           | **SoloOps: Kunde laden** (Client → Get)                                                                                              |
| ► Notiz + Follow-up    | **SoloOps: Signatur-Aufgabe** (Task → Create) + **SoloOps: Notiz versendet** (Note → Create)                                         |
| ► Tracking abschließen | **SoloOps: Vertragsnotiz finden** → **Kontext bauen** → **PDF ablegen** → **SoloOps: Aufgabe abhaken** → **SoloOps: Notiz signiert** |

Zwei Dinge dazu, die in `SETUP.md` offen waren:

- **Follow-up = Aufgabe.** Wiedervorlagen hängen in SoloOps an Leads, nicht an Kunden.
  Die offene Signatur ist deshalb eine Aufgabe („Signatur ausstehend: …", fällig in
  sieben Tagen, am Kunden) — die steht auf dem Board, lässt sich bebuchen und ist genau
  das, was ein `complete_follow_up` hier bedeuten sollte.
- **Der Rückweg braucht einen Join.** Zoho meldet nur seine Request-ID. Die Notiz vom
  Versand trägt `Zoho-ID:` im Titel und die Aufgaben-ID im Text; der Signiert-Workflow
  sucht darüber die Notiz, und aus ihr kommen Kunde und Aufgabe. Ohne passende Notiz
  bricht er mit einer Ansage ab statt stillschweigend nichts zu tun.

### Zoho-Payloads

Gegen die aktuelle Doku geprüft. Zwei Felder fehlten im Node „Signaturfelder platzieren":

- `field_category: 'image'` — **ohne das legt Zoho ein Textfeld an**, der Empfänger
  bekommt eine Tippzeile statt einer Unterschrift.
- `field_label` sowie `action_id` am Feld selbst.

`x_coord`, `y_coord`, `abs_width`, `abs_height`, `page_no` (0-basiert) stimmten.
`total_pages` kommt als String zurück und wird jetzt durch `Number()` geschoben.

### Koordinaten

Nachgemessen statt geraten: NDA gerendert, Seite 5 von 5 bei 595 × 842 pt. Die
Unterschriftsboxen liegen bei **x ≈ 50 / 312 pt, Oberkante ≈ 164 pt, 232 × 68 pt**. Die
`COORDS` im Workflow (55 / 315, y 168, 225 × 55) liegen damit in beiden Boxen, mit ein
paar Punkten Luft. Beim ersten echten Versand trotzdem draufschauen.

### SoloOps

- **Connector**: `GET /clients`, `GET /clients/:id` (nur lesend — Kundendaten ändert
  kein Workflow) und `GET /notes` zum Wiederfinden. `POST /tasks` kennt jetzt
  `clientId`, `GET /tasks` filtert nach Kunde und Titel.
- **n8n-Node**: neue Ressource **Client** (Get, Get Many), Note bekommt **Get Many**,
  Task bekommt Client-ID, Lead-ID und Titelfilter. Paket neu gebaut.
- **Aktion am Kunden**: Kundenliste → Knopf **Vertrag** → Dialog mit Vertragsart und den
  Feldern dieses Typs (Defaults vorbelegt). Schickt `{ vertrag, client_id, felder }` an
  den Webhook und zeigt die Zoho-Request-ID an.
- **Übersicht** unter _Verträge_: wer hat was in welchem Status, offene Aufgabe und
  Verschickt-/Signiert-Datum, signiertes PDF per Klick.
- **Auslösen läuft über die API** (`POST /api/contracts/send`), nicht aus dem Browser:
  der Webhook liegt im Compose-Netz, und so landet die Fehlermeldung des Workflows in
  der Oberfläche statt in der Konsole.

### Wo der Vertrag landet

In der Tabelle `Contract` am Kunden — nicht in einer Notiz, wie es früher war. Der
Versand legt den Datensatz an (`POST /api/contracts/send`, `status: versendet`,
`externalId` = Zoho-Request-ID) und hängt die Aufgabe „Signatur ausstehend" daran.

Der Rückweg braucht deshalb zwei Connector-Aufrufe:

```
GET  /api/automations/connector/contracts?externalId=<zoho-request-id>
POST /api/automations/connector/contracts/<id>/signed   { "file": "<name>" }
```

Der erste liefert den Vertrag **samt `fileName`** — dem Namen, unter dem das signierte
PDF abzulegen ist. Die Regel dafür steht in `services/contracts.ts` und wird im Workflow
bewusst nicht nachgebaut; der Code-Node übernimmt den Namen und gibt ihn mit dem zweiten
Aufruf zurück. Der setzt in einem Rutsch Status, Datum und Datei und hakt die Aufgabe ab
(über denselben Service wie die Oberfläche, damit ein daran hängender Follow-up
mitgeschlossen wird).

Die Ablage ist flach (`/data/vertraege/signiert/`), weil n8ns Write-Node keine
Verzeichnisse anlegt. Gelesen wird sie nur über `resolveSignedPath`.

### Infrastruktur

- **Gotenberg** (`gotenberg/gotenberg:8`) im selben Compose, ohne Host-Port — nur n8n
  spricht mit ihm. JavaScript beim Rendern abgeschaltet, 60 s Timeout.
- **Templates** werden aus dem Repo gemountet (`vertragsautomatisierung/templates` →
  `/data/vertraege/templates`, read-only), nicht nach `data/` kopiert: `data/` ist
  Laufzeitzeug und nicht in git, eine Kopie dort wäre nach der ersten Änderung veraltet.
- **Signierte PDFs** landen flach unter
  `data/vertraege/signiert/<kunde>-<datum>-<titel>-<zoho-id>.pdf`. Flach, weil n8ns
  Write-Node fehlende Verzeichnisse nicht anlegt (er öffnet die Datei direkt mit
  `O_CREAT`) — ein Ordner pro Kunde wäre beim ersten Vertrag jedes Kunden ein ENOENT.
- Eine n8n-Einstellung war nötig und steht im Compose:
  `N8N_RESTRICT_FILE_ACCESS_TO=/data/vertraege` — n8n verbietet Dateizugriff sonst
  komplett, so ist genau dieses Verzeichnis offen und sonst nichts.

### Wer die Workflows auslösen darf

Ein n8n-Webhook ist offen, sobald der Origin erreichbar ist — und `/n8n/` wird durch den
Web-Origin durchgereicht. Beide Workflows haben deshalb eine Schranke:

- **Versand**: Header-Auth. Das Secret liegt in der `.env` als
  `N8N_CONTRACT_WEBHOOK_SECRET` und in der n8n-Credential „Vertrags-Webhook"; soloops
  schickt es bei jedem Versand als `X-Soloops-Contract-Secret` mit. Ohne den Header
  antwortet n8n mit 403 — geprüft.
- **Rückweg**: Zufallspfad (siehe oben), weil Zoho keine Header mitgibt.

Das war vorher nicht so: wer die URL kannte, konnte Verträge an Kunden schicken, und
jeder Versand kostet bei Zoho Geld.

### Eine Besonderheit dieser Installation

n8n lädt die SoloOps-Nodes über `N8N_CUSTOM_EXTENSIONS` und registriert sie dabei unter
dem Präfix `CUSTOM.` — der Node-Typ heißt **`CUSTOM.soloops`**, nicht
`n8n-nodes-soloops.soloops`. Die JSONs hier sind entsprechend geschrieben. Wer das Paket
irgendwann per npm installiert, muss den Typ in beiden Dateien ändern.

## Was getestet ist

Durchstich über `POST /api/contracts/send` gegen den laufenden Stack:

```
Webhook → Eingabe prüfen & Konfig → SoloOps: Kunde laden → Kundendaten mappen
       → Zoho Access Token → Template laden → Platzhalter füllen → Gotenberg: HTML → PDF
       → Zoho: Request anlegen   ← hier ist ohne deine Credentials Schluss
```

Das PDF-Rendering ist separat gegen den echten Gotenberg geprüft: NDA mit vollständigen
Daten, 5 Seiten, Branding und Umbrüche sitzen, Unterschriftenseite wie oben vermessen.

Fehlerfälle, alle mit Klartext bis in die Oberfläche:

| Fall                 | Meldung                                                                             |
| -------------------- | ----------------------------------------------------------------------------------- |
| Pflichtfeld fehlt    | `Pflichtfelder fehlen: fertigstellung_datum, abnahme_person, festpreis`             |
| Kunde ohne E-Mail    | `… hat keine E-Mail-Adresse — ohne sie kann Zoho Sign nichts zustellen`             |
| Kunde ohne Adresse   | `Beim Kunden … fehlt: Straße, PLZ und Ort, Ort — in SoloOps unter Kunden ergänzen.` |
| Zoho antwortet nicht | `Authorization failed - please check your credentials`                              |
| Webhook ohne Secret  | n8n antwortet 403, der Workflow läuft nicht an                                      |
| Workflow hängt       | Abbruch nach 90 s mit Hinweis auf die n8n-Ausführungen                              |
| unbekannter Typ      | Validierungsfehler mit den vier erlaubten Werten                                    |

**Nicht getestet**, weil es deine Zoho-Credentials braucht: der Versand selbst, die
Platzierung der Signaturfelder in Zoho, der Webhook-Rückweg und damit die PDF-Ablage.
Das ist der erste Testversand aus „Was du noch tun musst".

## Kalibrierung beim ersten Versand

1. Testkunde mit deiner eigenen E-Mail, NDA versenden.
2. Im Zoho-Mail prüfen: sitzen die beiden Unterschriftsfelder in den Kästen auf der
   letzten Seite? Wenn nicht: n8n → **Signaturfelder platzieren** → `COORDS` anpassen
   (PDF-Punkte, Ursprung oben links, A4 = 595 × 842).
3. Beide unterschreiben und schauen, ob die Aufgabe „Signatur ausstehend" von selbst
   verschwindet und unter _Verträge_ ein PDF-Knopf auftaucht.

## Dateien

| Datei                        | Rolle                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| `templates/*.html`           | die vier Verträge, inhaltlich unverändert; nach `/data/vertraege/templates` gemountet |
| `n8n-vertrag-versenden.json` | Versand-Workflow, verdrahtet                                                          |
| `n8n-vertrag-signiert.json`  | Rückweg-Workflow, verdrahtet                                                          |
| `SETUP.md`                   | die ursprüngliche Anleitung                                                           |

Kein Rechtsrat — die Klauseln stammen aus deinen Mustern.
