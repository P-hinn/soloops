# Vertragsautomatisierung – Setup (einmalig, ~45 Min)

## Was du bekommst

`SoloOps → n8n → Zoho Sign`: Am Kunden „NDA versenden" auslösen → PDF mit deinem Branding wird generiert, per Zoho Sign an Kunde + dich verschickt, Tracking läuft über SoloOps-Notizen/Follow-ups.

## 1. Zoho Sign API-Plan (Free reicht nicht)

1. Zoho Sign → Einstellungen → Abonnement → **API-Plan** (pay-per-use, ~0,50 $ pro Versand, keine Grundgebühr)
2. https://api-console.zoho.eu → **Self Client** anlegen
3. Scope: `ZohoSign.documents.ALL` → Code generieren → gegen **Refresh Token** tauschen:
   ```
   curl -X POST "https://accounts.zoho.eu/oauth/v2/token" \
     -d "grant_type=authorization_code&client_id=...&client_secret=...&code=<CODE>"
   ```
4. Wichtig: durchgehend **EU-Domains** (`accounts.zoho.eu`, `sign.zoho.eu`) – dein Account liegt im EU-Rechenzentrum.

## 2. n8n-Host vorbereiten

```bash
# Templates auf den n8n-Host (in den Container gemountet als /data)
mkdir -p /data/vertraege/templates
cp nda.html werkvertrag.html dienstvertrag.html freie-mitarbeit.html /data/vertraege/templates/

# Gotenberg für HTML→PDF (gleiche Docker-Umgebung wie n8n)
docker run -d --name gotenberg --restart unless-stopped --network <n8n-netz> gotenberg/gotenberg:8
```

Env-Vars für n8n:

| Variable                                | Wert                    |
| --------------------------------------- | ----------------------- |
| `ZOHO_CLIENT_ID` / `ZOHO_CLIENT_SECRET` | aus der API-Console     |
| `ZOHO_REFRESH_TOKEN`                    | aus Schritt 1.3         |
| `GOTENBERG_URL`                         | `http://gotenberg:3000` |

## 3. Workflows importieren

1. `n8n-vertrag-versenden.json` und `n8n-vertrag-signiert.json` importieren
2. Im Node **„Eingabe prüfen & Konfig"**: IBAN/BIC eintragen, Defaults prüfen (Adresse nach dem Umzug aktualisieren!)
3. Die **►-NoOp-Nodes** durch deine SoloOps-Nodes ersetzen (get_client, create_note, set_follow_up, complete_follow_up); Mapping im Node „Kundendaten mappen" an deine SoloOps-Feldnamen anpassen
4. In Zoho Sign → Einstellungen → Webhooks: Produktions-URL von „Vertrag signiert" eintragen, Event `RequestCompleted`

## 4. Einmal kalibrieren (Pflicht!)

Testversand an dich selbst (`vertrag: "nda"`, Test-Client). Dabei prüfen:

- **Signaturfelder**: liegen sie in den beiden Boxen auf der Unterschriftenseite? Sonst im Node „Signaturfelder platzieren" die `COORDS` (PDF-Punkte, A4 = 595×842) anpassen.
- **Zoho-Payload**: Feldnamen (`x_coord`, `abs_width`, `page_no` …) gegen die aktuelle Zoho-Sign-API-Doku prüfen – Zoho ändert da gelegentlich was. Fehlerhafte Requests geben eine sprechende Fehlermeldung zurück.

## 5. Auslösen aus SoloOps

Automation „Vertrag versenden" (Trigger: manuell am Kunden) → HTTP-POST auf den n8n-Webhook:

```json
{
  "vertrag": "nda | werkvertrag | dienstvertrag | freie-mitarbeit",
  "client_id": "<SoloOps-Client-ID>",
  "felder": { "...vertragsspezifisch, siehe unten..." }
}
```

### Pflichtfelder pro Vertragstyp

| Typ               | Pflichtfelder (per `felder` mitgeben)                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------ |
| `nda`             | `projekt_gegenstand`, `gespraeche_seit`                                                                      |
| `werkvertrag`     | `werk_beschreibung`, `fertigstellung_datum`, `abnahme_person`, `festpreis`                                   |
| `dienstvertrag`   | `beratung_gegenstand`, `beratung_bereich`, `beratung_leistungen`, `beginn_datum`, `stundensatz`, `tagessatz` |
| `freie-mitarbeit` | `taetigkeit_rolle`, `taetigkeit_bereich`, `taetigkeit_aufgaben`, `beginn_datum`, `stundensatz`, `tagessatz`  |

Defaults (überschreibbar): `zahlungsziel_tage` 14 · `kuendigungsfrist` „vier Wochen zum Monatsende" · NDA-Vertragsstrafe 5.000–25.000 € · Abwerbeverbot 3 Monatsgehälter.

Kundendaten (`kunde_*`) kommen automatisch aus SoloOps `get_client`.

### Wo der Vertrag landet

- Versand: Vertragsdatensatz am Kunden (`status: versendet`, Zoho-Request-ID als
  `externalId`) + Follow-up „Signatur ausstehend"
- Signiert: Status `signiert`, Unterschriftsdatum, PDF daran — und das Follow-up ist
  abgehakt
- Übersicht „wer hat was": beim Kunden in der Spalte _Verträge_, über alle Kunden
  unter _Verträge_ oder per `soloops_list_contracts`

## Änderungen an deinen Mustern

- Muster-Boilerplate (Hinweise, Haftungsausschluss, Anbieterlogo) entfernt, Inhalte sonst übernommen
- Kleinunternehmer-Alternative (§ 19 UStG) entfernt – du weist USt aus
- Honorarvertrag: Pauschalvergütungs-Alternative entfernt (Stunden-/Tagessatz bleiben)
- Werkvertrag Schlussbestimmungen: „Sitz des Freien Mitarbeiters" (Copy-Paste-Fehler im Muster) → „Sitz des Unternehmers"
- Eigene Unterschriftenseite ergänzt (feste Positionen für die Zoho-Signaturfelder)

**Kein Rechtsrat** – die inhaltlichen Klauseln stammen aus deinen Mustern; einmal anwaltlich prüfen lassen bleibt sinnvoll.
