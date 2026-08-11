import { env } from '../env.js'

type LexClient = {
  id: string
  name: string
  company: string | null
  email: string | null
  phone: string | null
  street: string | null
  zip: string | null
  city: string | null
  country: string
  vatId: string | null
  lexofficeContactId: string | null
}

type LexInvoice = {
  number: string
  issueDate: Date
  dueDate: Date
  currency: string
  taxRate: number
  smallBusiness: boolean
  intro: string | null
  notes: string | null
  items: {
    description: string
    quantity: unknown // Prisma.Decimal
    unit: string
    unitPriceCents: number
  }[]
}

/** ISO-3166-alpha-2 für lexoffice. Deckt die üblichen Fälle ab. */
function countryCode(country: string): string {
  const map: Record<string, string> = {
    deutschland: 'DE',
    germany: 'DE',
    österreich: 'AT',
    austria: 'AT',
    schweiz: 'CH',
    switzerland: 'CH',
  }
  return map[country.trim().toLowerCase()] ?? 'DE'
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  if (!env.LEXOFFICE_API_KEY) throw new Error('LEXOFFICE_API_KEY nicht gesetzt')
  const res = await fetch(`${env.LEXOFFICE_BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.LEXOFFICE_API_KEY}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`lexoffice HTTP ${res.status}: ${text.slice(0, 400)}`)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export const lexoffice = {
  profile: () => call<{ organizationId: string; companyName: string; taxType: string }>('/v1/profile'),

  /** Legt den Kontakt an, falls noch keine lexoffice-ID hinterlegt ist. */
  async upsertContact(client: LexClient): Promise<string> {
    if (client.lexofficeContactId) return client.lexofficeContactId

    const payload = {
      version: 0,
      roles: { customer: {} },
      ...(client.company
        ? { company: { name: client.company, vatRegistrationId: client.vatId ?? undefined } }
        : { person: { firstName: client.name.split(' ')[0] ?? client.name, lastName: client.name.split(' ').slice(1).join(' ') || client.name } }),
      addresses: {
        billing: [
          {
            street: client.street ?? '',
            zip: client.zip ?? '',
            city: client.city ?? '',
            countryCode: countryCode(client.country),
          },
        ],
      },
      emailAddresses: client.email ? { business: [client.email] } : undefined,
      phoneNumbers: client.phone ? { business: [client.phone] } : undefined,
      note: `soloops-Kunde: ${client.name}`,
    }

    const created = await call<{ id: string }>('/v1/contacts', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    return created.id
  },

  /**
   * Überträgt die Rechnung als finalisiertes Dokument (`finalize=true`),
   * damit lexoffice sie sofort in den Buchungsstapel nimmt.
   */
  async createInvoice(invoice: LexInvoice, contactId: string): Promise<string> {
    // Kleinunternehmer nach §19 UStG weisen keine USt aus -> vatfree
    const taxType = invoice.smallBusiness ? 'vatfree' : 'net'
    const payload = {
      voucherDate: invoice.issueDate.toISOString(),
      address: { contactId },
      lineItems: invoice.items.map((item) => ({
        type: 'custom',
        name: item.description.split('\n')[0]?.slice(0, 200) ?? 'Leistung',
        description: item.description,
        quantity: Number(item.quantity),
        unitName: item.unit,
        unitPrice: {
          currency: invoice.currency,
          netAmount: item.unitPriceCents / 100,
          taxRatePercentage: invoice.smallBusiness ? 0 : invoice.taxRate,
        },
      })),
      totalPrice: { currency: invoice.currency },
      taxConditions: {
        taxType,
        ...(invoice.smallBusiness ? { taxTypeNote: 'Kleinunternehmer gemäß § 19 UStG' } : {}),
      },
      shippingConditions: {
        shippingDate: invoice.issueDate.toISOString(),
        shippingType: 'service',
      },
      paymentConditions: {
        paymentTermLabel: `Zahlbar bis ${invoice.dueDate.toLocaleDateString('de-DE')}`,
        paymentTermDuration: Math.max(
          1,
          Math.round((invoice.dueDate.getTime() - invoice.issueDate.getTime()) / 86_400_000),
        ),
      },
      title: 'Rechnung',
      introduction: invoice.intro ?? undefined,
      remark: invoice.notes ?? undefined,
    }

    const created = await call<{ id: string }>('/v1/invoices?finalize=true', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
    return created.id
  },
}
