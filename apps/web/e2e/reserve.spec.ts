import { expect, test } from './fixtures'

/**
 * Der Rücklagenrechner.
 *
 * Geprüft wird das, was die Seite ausmacht: sie rechnet beim Tippen, bevor
 * irgendetwas gespeichert ist, und sie speichert dann genau eine Zahl. Eine
 * Oberfläche, die erst nach dem Speichern rechnet, wäre zum Ausprobieren
 * unbrauchbar — und genau dafür ist sie da.
 */

const YEAR = new Date().getFullYear()

test('der Monat rechnet sich schon beim Tippen durch', async ({ page }) => {
  await page.goto('/reserve')

  const januar = page.getByRole('row').filter({ hasText: 'Januar' })
  await januar.getByLabel('Januar').fill('11900')

  // 11.900 brutto: 10.000 netto, 1.900 Umsatzsteuer, 3.500 Rücklage,
  // 500 Kosten — bleiben 6.000, ohne dass etwas gespeichert wurde.
  await expect(januar).toContainText('10.000,00')
  await expect(januar).toContainText('3.500,00')
  await expect(januar).toContainText('6.000,00')
})

test('beim Verlassen des Feldes geht genau der Bruttobetrag raus', async ({ page }) => {
  await page.goto('/reserve')

  const januar = page.getByRole('row').filter({ hasText: 'Januar' })
  await januar.getByLabel('Januar').fill('11900')

  const [request] = await Promise.all([
    page.waitForRequest(
      (r) => r.method() === 'PUT' && r.url().endsWith(`/api/reserve/${YEAR}/months/1`),
    ),
    januar.getByLabel('Januar').blur(),
  ])

  expect(request.postDataJSON()).toEqual({ grossCents: 1_190_000 })
})

test('der Vorschlag aus den Rechnungen lässt sich übernehmen', async ({ page }) => {
  await page.goto('/reserve')

  const januar = page.getByRole('row').filter({ hasText: 'Januar' })
  const [request] = await Promise.all([
    page.waitForRequest(
      (r) => r.method() === 'PUT' && r.url().endsWith(`/api/reserve/${YEAR}/months/1`),
    ),
    januar.getByRole('button', { name: /5.950,00/ }).click(),
  ])

  expect(request.postDataJSON()).toEqual({ grossCents: 595_000 })
})

test('die Jahressumme steht oben', async ({ page }) => {
  await page.goto('/reserve')

  // Die Kachel, nicht die gleichnamige Spaltenüberschrift: `.eyebrow-muted`
  // trägt nur die Kachel, die Überschrift ist ein `th`.
  const tile = (label: string) => page.locator('.eyebrow-muted', { hasText: label }).locator('..')

  // Der März ist im Stub gefüllt: 11.900 brutto, 6.000 Auszahlung. Übers Jahr
  // bleiben davon 500 — die elf umsatzlosen Monate kosten trotzdem je 500 €,
  // und genau das soll die Jahreszahl zeigen.
  await expect(tile('Umsatz brutto')).toContainText('11.900,00')

  // Ausgelesen statt gematcht: Intl setzt vor das € ein schmales geschütztes
  // Leerzeichen, "500,00" allein stünde auch in "1.500,00", und das Etikett
  // kommt durch `text-transform` in Großbuchstaben zurück.
  const payout = (await tile('Auszahlung privat').innerText()).replace(/\s+/g, ' ')
  expect(payout).toBe('AUSZAHLUNG PRIVAT 500,00 €')
})
