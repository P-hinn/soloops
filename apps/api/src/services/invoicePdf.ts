import PDFDocument from 'pdfkit'
import { env } from '../env.js'

type PdfInvoice = {
  number: string
  issueDate: Date
  dueDate: Date
  currency: string
  taxRate: number
  smallBusiness: boolean
  subtotalCents: number
  taxCents: number
  totalCents: number
  intro: string | null
  notes: string | null
  client: {
    name: string
    company: string | null
    street: string | null
    zip: string | null
    city: string | null
    country: string
    vatId: string | null
  }
  project: { key: string; name: string } | null
  items: {
    position: number
    description: string
    quantity: unknown
    unit: string
    unitPriceCents: number
    amountCents: number
  }[]
}

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat('de-DE', { style: 'currency', currency }).format(cents / 100)
const date = (d: Date) => d.toLocaleDateString('de-DE')

/** A layout close to DIN 5008, without a headless browser. */
export async function renderInvoicePdf(invoice: PdfInvoice): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 50 })
  const chunks: Buffer[] = []
  doc.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))))

  const left = 50
  const right = 545

  // Sender
  doc.fontSize(16).font('Helvetica-Bold').text(env.COMPANY_NAME, left, 50)
  doc
    .fontSize(8)
    .font('Helvetica')
    .fillColor('#555')
    .text(
      [env.COMPANY_STREET, `${env.COMPANY_ZIP} ${env.COMPANY_CITY}`.trim(), env.COMPANY_COUNTRY]
        .filter(Boolean)
        .join(' · '),
      left,
      72,
    )
  doc.fillColor('#000')

  // Recipient
  const recipient = [
    invoice.client.company ?? invoice.client.name,
    // Contact person only when it differs from the company name
    invoice.client.company && invoice.client.company !== invoice.client.name
      ? invoice.client.name
      : null,
    invoice.client.street,
    `${invoice.client.zip ?? ''} ${invoice.client.city ?? ''}`.trim() || null,
    invoice.client.country !== env.COMPANY_COUNTRY ? invoice.client.country : null,
  ].filter(Boolean) as string[]
  doc.fontSize(11).font('Helvetica').text(recipient.join('\n'), left, 130)

  // Meta block on the right
  const metaTop = 130
  doc.fontSize(9).font('Helvetica')
  const meta: [string, string][] = [
    ['Rechnungsnr.', invoice.number],
    ['Datum', date(invoice.issueDate)],
    ['Fällig am', date(invoice.dueDate)],
  ]
  if (invoice.project) meta.push(['Projekt', invoice.project.key])
  if (env.COMPANY_VAT_ID) meta.push(['USt-IdNr.', env.COMPANY_VAT_ID])
  else if (env.COMPANY_TAX_NUMBER) meta.push(['Steuernr.', env.COMPANY_TAX_NUMBER])
  meta.forEach(([label, value], i) => {
    doc.fillColor('#666').text(label, 350, metaTop + i * 14, { width: 90 })
    doc.fillColor('#000').text(value, 440, metaTop + i * 14, { width: 105, align: 'right' })
  })

  // Title
  doc.fontSize(18).font('Helvetica-Bold').text(`Rechnung ${invoice.number}`, left, 235)
  let y = 265
  if (invoice.intro) {
    doc
      .fontSize(10)
      .font('Helvetica')
      .text(invoice.intro, left, y, { width: right - left })
    y = doc.y + 12
  }

  // Table head
  const cols = { pos: left, desc: left + 28, qty: 330, price: 400, sum: 470 }
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#000')
  doc.text('Pos', cols.pos, y)
  doc.text('Beschreibung', cols.desc, y)
  doc.text('Menge', cols.qty, y, { width: 60, align: 'right' })
  doc.text('Einzelpreis', cols.price, y, { width: 60, align: 'right' })
  doc.text('Betrag', cols.sum, y, { width: 75, align: 'right' })
  y += 14
  doc.moveTo(left, y).lineTo(right, y).strokeColor('#ccc').stroke()
  y += 8

  doc.font('Helvetica').fontSize(9)
  for (const item of invoice.items) {
    if (y > 690) {
      doc.addPage()
      y = 60
    }
    const descHeight = doc.heightOfString(item.description, { width: cols.qty - cols.desc - 10 })
    doc.text(String(item.position), cols.pos, y)
    doc.text(item.description, cols.desc, y, { width: cols.qty - cols.desc - 10 })
    doc.text(`${Number(item.quantity).toLocaleString('de-DE')} ${item.unit}`, cols.qty, y, {
      width: 60,
      align: 'right',
    })
    doc.text(money(item.unitPriceCents, invoice.currency), cols.price, y, {
      width: 60,
      align: 'right',
    })
    doc.text(money(item.amountCents, invoice.currency), cols.sum, y, { width: 75, align: 'right' })
    y += Math.max(descHeight, 12) + 8
  }

  // Totals
  y += 4
  doc.moveTo(330, y).lineTo(right, y).strokeColor('#ccc').stroke()
  y += 8
  const totalRow = (label: string, value: string, bold = false) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9)
    doc.text(label, 330, y, { width: 130, align: 'right' })
    doc.text(value, 470, y, { width: 75, align: 'right' })
    y += bold ? 18 : 14
  }
  totalRow('Zwischensumme', money(invoice.subtotalCents, invoice.currency))
  if (!invoice.smallBusiness) {
    totalRow(`zzgl. ${invoice.taxRate} % USt`, money(invoice.taxCents, invoice.currency))
  }
  totalRow('Gesamtbetrag', money(invoice.totalCents, invoice.currency), true)

  y += 8
  doc.font('Helvetica').fontSize(9).fillColor('#000')
  if (invoice.smallBusiness) {
    doc.text('Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.', left, y, { width: right - left })
    y = doc.y + 8
  }
  doc.text(
    `Bitte überweisen Sie den Betrag bis zum ${date(invoice.dueDate)} unter Angabe der Rechnungsnummer ${invoice.number}.`,
    left,
    y,
    { width: right - left },
  )
  y = doc.y + 8
  if (invoice.notes) {
    doc.text(invoice.notes, left, y, { width: right - left })
    y = doc.y + 8
  }

  // Footer
  const footer = [
    [env.COMPANY_NAME, env.COMPANY_STREET, `${env.COMPANY_ZIP} ${env.COMPANY_CITY}`.trim()]
      .filter(Boolean)
      .join(', '),
    [env.COMPANY_EMAIL, env.COMPANY_PHONE].filter(Boolean).join(' · '),
    [
      env.COMPANY_BANK && `Bank: ${env.COMPANY_BANK}`,
      env.COMPANY_IBAN && `IBAN: ${env.COMPANY_IBAN}`,
      env.COMPANY_BIC && `BIC: ${env.COMPANY_BIC}`,
    ]
      .filter(Boolean)
      .join(' · '),
  ].filter(Boolean)

  doc
    .fontSize(7.5)
    .fillColor('#666')
    .text(footer.join('\n'), left, 770, { width: right - left, align: 'center' })

  doc.end()
  return done
}
