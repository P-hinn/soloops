/**
 * What a contract needs filled in.
 *
 * A copy of the workflow's `vertraege` config, deliberately kept thin: this
 * builds the form, the workflow decides. If a field is added there and
 * forgotten here, the send comes back with "Pflichtfelder fehlen: …" instead
 * of silently producing a contract with a hole in it — the asymmetry is on
 * purpose, because the workflow is the one that renders the document.
 *
 * Defaults mirror the config node so the form opens pre-filled the way the
 * workflow would fill it in anyway.
 */

import { SENDABLE_CONTRACT_TYPES } from '@soloops/shared'

/**
 * The four with a template — the list itself lives in @soloops/shared,
 * because the API validates against it and this file would otherwise be a
 * second opinion on what may be sent.
 */
export type ContractType = (typeof SENDABLE_CONTRACT_TYPES)[number]

export type ContractField = {
  name: string
  label: string
  /** Multi-line for anything that is a paragraph rather than a value. */
  kind: 'text' | 'area' | 'date' | 'money'
  required: boolean
  placeholder?: string
  default?: string
  hint?: string
}

export type ContractDefinition = {
  type: ContractType
  label: string
  /** What the PDF will be called — the workflow's `titel`. */
  title: string
  fields: ContractField[]
}

const ZAHLUNGSZIEL: ContractField = {
  name: 'zahlungsziel_tage',
  label: 'Zahlungsziel (Tage)',
  kind: 'text',
  required: false,
  default: '14',
}

const KUENDIGUNG: ContractField = {
  name: 'kuendigungsfrist',
  label: 'Kündigungsfrist',
  kind: 'text',
  required: false,
  default: 'vier Wochen zum Monatsende',
}

const BEGINN: ContractField = {
  name: 'beginn_datum',
  label: 'Beginn',
  kind: 'date',
  required: true,
}

const SAETZE: ContractField[] = [
  {
    name: 'stundensatz',
    label: 'Stundensatz',
    kind: 'money',
    required: true,
    placeholder: '120,00',
  },
  { name: 'tagessatz', label: 'Tagessatz', kind: 'money', required: true, placeholder: '960,00' },
]

export const CONTRACTS: ContractDefinition[] = [
  {
    type: 'nda',
    label: 'NDA',
    title: 'Geheimhaltungsvereinbarung (NDA)',
    fields: [
      {
        name: 'projekt_gegenstand',
        label: 'Worum geht es',
        kind: 'area',
        required: true,
        placeholder: 'die Ablösung des Data Warehouse und die dafür nötigen Einblicke in …',
      },
      {
        name: 'gespraeche_seit',
        label: 'Gespräche seit',
        kind: 'date',
        required: true,
        hint: 'Ab wann die Vereinbarung zurückwirkt',
      },
      {
        name: 'vertragsstrafe_min',
        label: 'Vertragsstrafe von',
        kind: 'money',
        required: false,
        default: '5.000,00',
      },
      {
        name: 'vertragsstrafe_max',
        label: 'bis',
        kind: 'money',
        required: false,
        default: '25.000,00',
      },
      {
        name: 'abwerbe_strafe_monate',
        label: 'Abwerbeverbot (Monatsgehälter)',
        kind: 'text',
        required: false,
        default: 'drei',
      },
    ],
  },
  {
    type: 'werkvertrag',
    label: 'Werkvertrag',
    title: 'Werkvertrag',
    fields: [
      {
        name: 'werk_beschreibung',
        label: 'Das Werk',
        kind: 'area',
        required: true,
        placeholder:
          'Was genau geschuldet ist — der Werkvertrag schuldet ein Ergebnis, keine Tätigkeit.',
      },
      { name: 'fertigstellung_datum', label: 'Fertig bis', kind: 'date', required: true },
      {
        name: 'abnahme_person',
        label: 'Abnahme durch',
        kind: 'text',
        required: true,
        placeholder: 'Name beim Kunden',
      },
      {
        name: 'festpreis',
        label: 'Festpreis',
        kind: 'money',
        required: true,
        placeholder: '12.500,00',
      },
      {
        name: 'werk_anlagen',
        label: 'Anlagen',
        kind: 'text',
        required: false,
        default: '–',
        hint: 'Pflichtenheft, Angebot, Spezifikation …',
      },
      // Kein Zahlungsziel: der Werkvertrag regelt die Fälligkeit über die
      // Abnahme, das Template hat dafür keinen Platzhalter.
    ],
  },
  {
    type: 'dienstvertrag',
    label: 'Dienstvertrag',
    title: 'Dienstvertrag (Beratung)',
    fields: [
      {
        name: 'beratung_gegenstand',
        label: 'Gegenstand der Beratung',
        kind: 'area',
        required: true,
      },
      {
        name: 'beratung_bereich',
        label: 'Bereich',
        kind: 'text',
        required: true,
        placeholder: 'Datenarchitektur',
      },
      { name: 'beratung_leistungen', label: 'Leistungen', kind: 'area', required: true },
      BEGINN,
      ...SAETZE,
      KUENDIGUNG,
      ZAHLUNGSZIEL,
    ],
  },
  {
    type: 'freie-mitarbeit',
    label: 'Freie Mitarbeit',
    title: 'Honorarvertrag (freie Mitarbeit)',
    fields: [
      {
        name: 'taetigkeit_rolle',
        label: 'Rolle',
        kind: 'text',
        required: true,
        placeholder: 'Senior Backend Engineer',
      },
      { name: 'taetigkeit_bereich', label: 'Bereich', kind: 'text', required: true },
      { name: 'taetigkeit_aufgaben', label: 'Aufgaben', kind: 'area', required: true },
      BEGINN,
      ...SAETZE,
      KUENDIGUNG,
      ZAHLUNGSZIEL,
    ],
  },
]

export function contractByType(type: ContractType): ContractDefinition {
  return CONTRACTS.find((c) => c.type === type) ?? CONTRACTS[0]!
}

/** The pre-filled draft for a type: every field with its default. */
export function draftFor(type: ContractType): Record<string, string> {
  return Object.fromEntries(contractByType(type).fields.map((f) => [f.name, f.default ?? '']))
}
