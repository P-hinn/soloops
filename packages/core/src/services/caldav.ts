/**
 * A lean CalDAV client for Apple/iCloud (works just as well against
 * Nextcloud, Fastmail, Radicale).
 *
 * Deliberately without an XML library: CalDAV responses are flat and machine
 * generated, a namespace-tolerant extractor is enough. The day this parser
 * gets any more complicated is the day to reach for a real XML library.
 */

export type CalDavCredentials = {
  baseUrl: string
  username: string
  password: string
}

export type CalDavCalendar = {
  href: string
  displayName: string
  ctag: string | null
  supportsSyncCollection: boolean
}

export type CalDavResource = {
  href: string
  etag: string | null
  data: string | null
  deleted: boolean
}

// --- XML helpers ------------------------------------------------------------

/** The contents of every element with this local name, prefix regardless. */
function elements(xml: string, localName: string): string[] {
  const re = new RegExp(
    `<(?:[A-Za-z0-9_.-]+:)?${localName}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?${localName}>`,
    'gi',
  )
  return [...xml.matchAll(re)].map((m) => m[1] ?? '')
}

function element(xml: string, localName: string): string | null {
  return elements(xml, localName)[0] ?? null
}

/** For empty marker elements like <D:calendar/> or <C:calendar />. */
function hasElement(xml: string, localName: string): boolean {
  return new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${localName}[\\s/>]`, 'i').test(xml)
}

function decodeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim()
}

// --- HTTP -----------------------------------------------------------------

function authHeader(creds: CalDavCredentials): string {
  return `Basic ${Buffer.from(`${creds.username}:${creds.password}`).toString('base64')}`
}

/** Resolve relative hrefs from the response against the server origin. */
function absolute(baseUrl: string, href: string): string {
  return new URL(href, baseUrl).toString()
}

async function dav(
  creds: CalDavCredentials,
  url: string,
  method: string,
  body?: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; text: string; headers: Headers }> {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: authHeader(creds),
      ...(body ? { 'Content-Type': 'application/xml; charset=utf-8' } : {}),
      ...extraHeaders,
    },
    body,
  })
  const text = await res.text()
  if (res.status === 401) throw new Error('CalDAV: Anmeldung abgelehnt (App-Passwort prüfen)')
  return { status: res.status, text, headers: res.headers }
}

// --- Discovery -------------------------------------------------------------

/** Finds every calendar collection of the account. */
export async function discoverCalendars(creds: CalDavCredentials): Promise<CalDavCalendar[]> {
  const base = creds.baseUrl.replace(/\/$/, '')

  // 1) current-user-principal
  const principalRes = await dav(
    creds,
    `${base}/`,
    'PROPFIND',
    `<?xml version="1.0" encoding="utf-8"?>
     <d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`,
    { Depth: '0' },
  )
  const principalHref = decodeXml(
    element(element(principalRes.text, 'current-user-principal') ?? '', 'href') ?? '',
  )
  if (!principalHref) throw new Error('CalDAV: Principal nicht gefunden')

  // 2) calendar-home-set
  const homeRes = await dav(
    creds,
    absolute(base, principalHref),
    'PROPFIND',
    `<?xml version="1.0" encoding="utf-8"?>
     <d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
       <d:prop><c:calendar-home-set/></d:prop>
     </d:propfind>`,
    { Depth: '0' },
  )
  const homeHref = decodeXml(
    element(element(homeRes.text, 'calendar-home-set') ?? '', 'href') ?? '',
  )
  if (!homeHref) throw new Error('CalDAV: calendar-home-set nicht gefunden')

  // 3) list the calendars
  const listRes = await dav(
    creds,
    absolute(base, homeHref),
    'PROPFIND',
    `<?xml version="1.0" encoding="utf-8"?>
     <d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">
       <d:prop>
         <d:resourcetype/>
         <d:displayname/>
         <cs:getctag/>
         <d:sync-token/>
         <c:supported-calendar-component-set/>
       </d:prop>
     </d:propfind>`,
    { Depth: '1' },
  )

  const calendars: CalDavCalendar[] = []
  for (const response of elements(listRes.text, 'response')) {
    const href = decodeXml(element(response, 'href') ?? '')
    const resourceType = element(response, 'resourcetype') ?? ''
    if (!href || !hasElement(resourceType, 'calendar')) continue

    // Only calendars that carry VEVENT (iCloud also returns VTODO lists)
    const components = element(response, 'supported-calendar-component-set') ?? ''
    if (components && !/VEVENT/i.test(components)) continue

    calendars.push({
      href: absolute(base, href),
      displayName: decodeXml(element(response, 'displayname') ?? '') || href,
      ctag: decodeXml(element(response, 'getctag') ?? '') || null,
      supportsSyncCollection: !!element(response, 'sync-token'),
    })
  }
  return calendars
}

// --- Reading -------------------------------------------------------------

/**
 * WebDAV sync (RFC 6578). Returns only what changed since the token.
 * An empty token means first sync — then the server returns everything.
 */
export async function syncCollection(
  creds: CalDavCredentials,
  calendarHref: string,
  syncToken: string | null,
): Promise<{ resources: CalDavResource[]; syncToken: string | null; needsFullSync: boolean }> {
  const res = await dav(
    creds,
    calendarHref,
    'REPORT',
    `<?xml version="1.0" encoding="utf-8"?>
     <d:sync-collection xmlns:d="DAV:">
       <d:sync-token>${syncToken ?? ''}</d:sync-token>
       <d:sync-level>1</d:sync-level>
       <d:prop><d:getetag/></d:prop>
     </d:sync-collection>`,
    { Depth: '1' },
  )

  // 403/409 with "valid-sync-token": the token has grown too old.
  if (res.status === 403 || res.status === 409 || /valid-sync-token/i.test(res.text)) {
    return { resources: [], syncToken: null, needsFullSync: true }
  }
  if (res.status >= 400) throw new Error(`CalDAV sync-collection: HTTP ${res.status}`)

  const resources: CalDavResource[] = []
  for (const response of elements(res.text, 'response')) {
    const href = decodeXml(element(response, 'href') ?? '')
    if (!href) continue
    const status = element(response, 'status') ?? ''
    const deleted = /404|410/.test(status)
    resources.push({
      href: absolute(calendarHref, href),
      etag: decodeXml(element(response, 'getetag') ?? '').replace(/^"|"$/g, '') || null,
      data: null,
      deleted,
    })
  }

  const nextToken = decodeXml(element(res.text, 'sync-token') ?? '') || null
  return { resources, syncToken: nextToken, needsFullSync: false }
}

/** Fallback without WebDAV sync: fetch every ETag in the window. */
export async function listEtags(
  creds: CalDavCredentials,
  calendarHref: string,
  from: Date,
  to: Date,
): Promise<CalDavResource[]> {
  const stamp = (d: Date) => `${d.toISOString().replace(/[-:]/g, '').split('.')[0] ?? ''}Z`
  const res = await dav(
    creds,
    calendarHref,
    'REPORT',
    `<?xml version="1.0" encoding="utf-8"?>
     <c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
       <d:prop><d:getetag/></d:prop>
       <c:filter>
         <c:comp-filter name="VCALENDAR">
           <c:comp-filter name="VEVENT">
             <c:time-range start="${stamp(from)}" end="${stamp(to)}"/>
           </c:comp-filter>
         </c:comp-filter>
       </c:filter>
     </c:calendar-query>`,
    { Depth: '1' },
  )
  if (res.status >= 400) throw new Error(`CalDAV calendar-query: HTTP ${res.status}`)

  const out: CalDavResource[] = []
  for (const response of elements(res.text, 'response')) {
    const href = decodeXml(element(response, 'href') ?? '')
    if (!href) continue
    out.push({
      href: absolute(calendarHref, href),
      etag: decodeXml(element(response, 'getetag') ?? '').replace(/^"|"$/g, '') || null,
      data: null,
      deleted: false,
    })
  }
  return out
}

/** Load several resources at once (RFC 4791 calendar-multiget). */
export async function multiget(
  creds: CalDavCredentials,
  calendarHref: string,
  hrefs: string[],
): Promise<CalDavResource[]> {
  if (!hrefs.length) return []
  const out: CalDavResource[] = []

  // iCloud dislikes huge multigets — ask in chunks.
  for (let i = 0; i < hrefs.length; i += 50) {
    const chunk = hrefs.slice(i, i + 50)
    const res = await dav(
      creds,
      calendarHref,
      'REPORT',
      `<?xml version="1.0" encoding="utf-8"?>
       <c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
         <d:prop><d:getetag/><c:calendar-data/></d:prop>
         ${chunk.map((h) => `<d:href>${new URL(h).pathname}</d:href>`).join('')}
       </c:calendar-multiget>`,
      { Depth: '1' },
    )
    if (res.status >= 400) throw new Error(`CalDAV multiget: HTTP ${res.status}`)

    for (const response of elements(res.text, 'response')) {
      const href = decodeXml(element(response, 'href') ?? '')
      const data = element(response, 'calendar-data')
      if (!href || !data) continue
      out.push({
        href: absolute(calendarHref, href),
        etag: decodeXml(element(response, 'getetag') ?? '').replace(/^"|"$/g, '') || null,
        data: decodeXml(data),
        deleted: false,
      })
    }
  }
  return out
}

// --- Writing -------------------------------------------------------------

/**
 * Create or update. `etag` guards against overwriting someone else's changes
 * (If-Match); without an etag, If-None-Match: * only ever creates.
 */
export async function putEvent(
  creds: CalDavCredentials,
  href: string,
  ics: string,
  etag: string | null,
): Promise<{ etag: string | null; conflict: boolean }> {
  const res = await fetch(href, {
    method: 'PUT',
    headers: {
      Authorization: authHeader(creds),
      'Content-Type': 'text/calendar; charset=utf-8',
      ...(etag ? { 'If-Match': `"${etag}"` } : { 'If-None-Match': '*' }),
    },
    body: ics,
  })

  if (res.status === 412) return { etag: null, conflict: true }
  if (res.status >= 400) {
    throw new Error(`CalDAV PUT ${href}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
  }
  // Some servers return no ETag — then we pick it up on the next sync.
  return { etag: res.headers.get('etag')?.replace(/^"|"$/g, '') ?? null, conflict: false }
}

export async function deleteEvent(
  creds: CalDavCredentials,
  href: string,
  etag: string | null,
): Promise<void> {
  const res = await fetch(href, {
    method: 'DELETE',
    headers: {
      Authorization: authHeader(creds),
      ...(etag ? { 'If-Match': `"${etag}"` } : {}),
    },
  })
  // 404 means: already gone. That is not an error.
  if (res.status >= 400 && res.status !== 404 && res.status !== 412) {
    throw new Error(`CalDAV DELETE ${href}: HTTP ${res.status}`)
  }
}

/** The href for a new event — UID as the file name, as is customary. */
export function resourceHref(calendarHref: string, uid: string): string {
  const base = calendarHref.endsWith('/') ? calendarHref : `${calendarHref}/`
  return `${base}${encodeURIComponent(uid)}.ics`
}
