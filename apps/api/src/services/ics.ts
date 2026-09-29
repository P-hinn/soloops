type IcsEvent = {
  externalUid: string
  title: string
  description: string | null
  location: string | null
  startsAt: Date
  endsAt: Date
  allDay: boolean
  updatedAt: Date
  videoUrl?: string | null
  project?: { key: string } | null
}

function stamp(d: Date, allDay = false): string {
  const iso = d.toISOString()
  if (allDay) return iso.slice(0, 10).replace(/-/g, '')
  return `${iso.replace(/[-:]/g, '').split('.')[0] ?? ''}Z`
}

function escape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n')
}

/** RFC 5545 requires lines of ≤ 75 octets. */
function fold(line: string): string {
  if (line.length <= 73) return line
  const chunks: string[] = []
  let rest = line
  chunks.push(rest.slice(0, 73))
  rest = rest.slice(73)
  while (rest.length > 72) {
    chunks.push(' ' + rest.slice(0, 72))
    rest = rest.slice(72)
  }
  if (rest) chunks.push(' ' + rest)
  return chunks.join('\r\n')
}

export function buildIcs(events: IcsEvent[]): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//soloops//Kalender//DE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:soloops',
  ]

  for (const e of events) {
    const title = e.project ? `[${e.project.key}] ${e.title}` : e.title
    lines.push('BEGIN:VEVENT')
    lines.push(`UID:${e.externalUid}@soloops`)
    lines.push(`DTSTAMP:${stamp(e.updatedAt)}`)
    if (e.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${stamp(e.startsAt, true)}`)
      lines.push(`DTEND;VALUE=DATE:${stamp(e.endsAt, true)}`)
    } else {
      lines.push(`DTSTART:${stamp(e.startsAt)}`)
      lines.push(`DTEND:${stamp(e.endsAt)}`)
    }
    lines.push(fold(`SUMMARY:${escape(title)}`))

    // Mirror the video room into the description — Apple and Google then link
    // it right in the event view.
    const description = [e.description, e.videoUrl ? `Videoraum: ${e.videoUrl}` : null]
      .filter(Boolean)
      .join('\n\n')
    if (description) lines.push(fold(`DESCRIPTION:${escape(description)}`))
    if (e.location) lines.push(fold(`LOCATION:${escape(e.location)}`))
    if (e.videoUrl) {
      lines.push(fold(`URL:${e.videoUrl}`))
      lines.push(fold(`CONFERENCE;VALUE=URI;FEATURE=VIDEO:${e.videoUrl}`))
    }
    lines.push('END:VEVENT')
  }

  lines.push('END:VCALENDAR')
  return lines.join('\r\n') + '\r\n'
}
