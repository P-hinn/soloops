import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { env } from '../../../api/src/env.js'
import { prisma } from '../../../api/src/db.js'
import { summarizeMeeting } from '../../../api/src/ai/digest.js'

type TranscribeResponse = {
  language: string
  duration: number
  text: string
  segments: { start: number; end: number; text: string }[]
}

/**
 * Schickt die Aufnahme an den faster-whisper-Service. Das Audio verlässt
 * dabei nie die eigene Docker-Umgebung — relevant für Mandantendaten.
 */
export async function runTranscription(meetingId: string): Promise<{ chars: number }> {
  const recording = await prisma.recording.findUnique({ where: { meetingId } })
  if (!recording) throw new Error('Keine Aufnahme vorhanden')

  await prisma.transcript.upsert({
    where: { meetingId },
    create: {
      meetingId,
      status: 'RUNNING',
      language: env.WHISPER_LANGUAGE,
      model: env.WHISPER_MODEL,
    },
    update: { status: 'RUNNING', error: null },
  })

  try {
    await stat(recording.storagePath)

    const form = new FormData()
    // Aufnahme wird komplett in den Speicher gelesen. Für Meeting-Audio (~100 MB)
    // unkritisch; bei größeren Dateien auf Chunk-Upload umstellen.
    const blob = await streamToBlob(recording.storagePath, recording.mimeType)
    form.append('file', blob, recording.filename)
    form.append('language', env.WHISPER_LANGUAGE)
    form.append('model', env.WHISPER_MODEL)

    const res = await fetch(`${env.TRANSCRIBE_URL}/transcribe`, { method: 'POST', body: form })
    if (!res.ok) {
      throw new Error(
        `Transkriptions-Service HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`,
      )
    }
    const data = (await res.json()) as TranscribeResponse

    await prisma.$transaction([
      prisma.transcript.update({
        where: { meetingId },
        data: {
          status: 'DONE',
          text: data.text,
          segments: data.segments,
          language: data.language,
          finishedAt: new Date(),
          error: null,
        },
      }),
      prisma.recording.update({
        where: { meetingId },
        data: { durationSec: Math.round(data.duration) },
      }),
    ])

    // Direkt im Anschluss zusammenfassen, wenn ein Key hinterlegt ist.
    if (env.ANTHROPIC_API_KEY) {
      try {
        await summarizeMeeting(meetingId)
      } catch (err) {
        console.warn(`[transcribe] Zusammenfassung fehlgeschlagen: ${(err as Error).message}`)
      }
    }

    return { chars: data.text.length }
  } catch (err) {
    await prisma.transcript.update({
      where: { meetingId },
      data: { status: 'FAILED', error: (err as Error).message, finishedAt: new Date() },
    })
    throw err
  }
}

async function streamToBlob(path: string, mimeType: string): Promise<Blob> {
  const chunks: Buffer[] = []
  for await (const chunk of createReadStream(path)) chunks.push(chunk as Buffer)
  return new Blob([Buffer.concat(chunks)], { type: mimeType })
}
