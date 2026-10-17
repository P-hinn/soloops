/**
 * Euro im Eingabefeld, Cent in der API.
 *
 * Eine Stelle für beide Richtungen, weil die Umrechnung sonst in jedem
 * Formular noch einmal entsteht — und spätestens das dritte liest "12,50"
 * dann als 12 Euro.
 */

/**
 * Euro, wie getippt, als Cent. `null`, wenn das Feld leer ist oder keine Zahl
 * enthält.
 *
 * Komma gilt als Dezimaltrennzeichen; steht eines im Wert, sind Punkte
 * Tausenderpunkte ("12.554,50"). Ohne Komma ist der Punkt das Dezimalzeichen
 * ("95.50") — die Schreibweise, die jedes Zahlenfeld im Browser liefert.
 */
export function euroToCents(value: string): number | null {
  const cleaned = value.trim().replace(/[\s€]/g, '')
  if (!cleaned) return null
  const normalized = cleaned.includes(',') ? cleaned.replace(/\./g, '').replace(',', '.') : cleaned
  const amount = Number(normalized)
  if (!Number.isFinite(amount)) return null
  return Math.round(amount * 100)
}

/** Cent als Betrag fürs Eingabefeld. Leerstring für "nichts hinterlegt". */
export function centsToEuro(cents?: number | null): string {
  return cents === null || cents === undefined ? '' : (cents / 100).toFixed(2)
}
