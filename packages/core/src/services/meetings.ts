/**
 * Meetings, and the calendar entry that belongs to one.
 *
 * The thing worth knowing about this file is the pairing: a meeting may own a
 * `CalendarEvent`, and then title, time, video room and deletion have to be
 * carried over to it. That happens in four places, which is exactly why they
 * are collected here rather than spread across a route.
 *
 * It is deliberately **not** in a transaction, because that is how it was
 * before this file existed and this move does not change behaviour. It should
 * be: if the second write fails, meeting and event drift apart, and the
 * delete path below even swallows the error. Noted as the next thing to fix,
 * not fixed here.
 */
import type { MeetingStatus } from '@prisma/client'
import { prisma } from '../db.js'
import { emitAutomationEvent } from './automationDelivery.js'
import { tombstoneEvent } from './calendarSync.js'
import { createVideoRoom } from './video.js'
import { videoSettings } from '../settings.js'
import { notFound } from '../rules.js'

export type MeetingFilter = { projectId?: string; from?: string; take?: number }

export function listMeetings(q: MeetingFilter) {
  return prisma.meeting.findMany({
    where: {
      ...(q.projectId ? { projectId: q.projectId } : {}),
      ...(q.from ? { startsAt: { gte: new Date(q.from) } } : {}),
    },
    orderBy: { startsAt: 'desc' },
    take: q.take ?? 50,
    include: {
      project: { select: { id: true, key: true, name: true, color: true } },
      client: { select: { id: true, name: true } },
      _count: { select: { actionItems: true } },
    },
  })
}

export async function getMeeting(id: string) {
  const meeting = await prisma.meeting.findUnique({
    where: { id },
    include: {
      project: true,
      client: true,
      actionItems: { orderBy: [{ done: 'asc' }, { createdAt: 'asc' }] },
      notes_: true,
    },
  })
  if (!meeting) throw notFound('Meeting nicht gefunden')
  return meeting
}

export type CreateMeeting = {
  title: string
  status: MeetingStatus
  startsAt: string | Date
  endsAt?: string | Date | null
  participants: string[]
  agenda?: string | null
  minutes?: string | null
  projectId?: string | null
  clientId?: string | null
  createEvent?: boolean
  withVideo?: boolean
  videoUrl?: string | null
}

export async function createMeeting(data: CreateMeeting) {
  const startsAt = new Date(data.startsAt)
  const endsAt = data.endsAt ? new Date(data.endsAt) : new Date(startsAt.getTime() + 3600_000)

  // Create the video room once and mirror it into event and meeting
  const room = data.withVideo
    ? createVideoRoom(data.title, await videoSettings())
    : data.videoUrl
      ? { videoUrl: data.videoUrl, videoProvider: 'CUSTOM' as const }
      : null

  // Calendar entry first, so that meeting and event share the same time.
  const event = data.createEvent
    ? await prisma.calendarEvent.create({
        data: {
          title: data.title,
          startsAt,
          endsAt,
          kind: 'MEETING',
          projectId: data.projectId ?? null,
          clientId: data.clientId ?? null,
          videoUrl: room?.videoUrl ?? null,
          videoProvider: room?.videoProvider ?? null,
        },
      })
    : null

  return prisma.meeting.create({
    data: {
      title: data.title,
      status: data.status,
      startsAt,
      endsAt,
      participants: data.participants,
      agenda: data.agenda ?? null,
      minutes: data.minutes ?? null,
      projectId: data.projectId ?? null,
      clientId: data.clientId ?? null,
      eventId: event?.id ?? null,
      videoUrl: room?.videoUrl ?? null,
      videoProvider: room?.videoProvider ?? null,
    },
    include: { event: true },
  })
}

/** `createEvent` and `withVideo` are accepted and ignored — the same as
 * before: they describe how a meeting is *created*, not how it changes. */
export type UpdateMeeting = Partial<CreateMeeting>

export async function updateMeeting(id: string, data: UpdateMeeting) {
  // Needed before the write: "ended" is the transition into DONE, not the
  // state. Saving a meeting that was already done changes nothing and should
  // not fire again.
  const before = await prisma.meeting.findUniqueOrThrow({
    where: { id },
    select: { status: true },
  })
  const meeting = await prisma.meeting.update({
    where: { id },
    data: {
      title: data.title,
      status: data.status,
      startsAt: data.startsAt ? new Date(data.startsAt) : undefined,
      endsAt: data.endsAt ? new Date(data.endsAt) : undefined,
      participants: data.participants,
      agenda: data.agenda,
      minutes: data.minutes,
      projectId: data.projectId,
      clientId: data.clientId,
    },
    include: { event: true },
  })
  // Carry the linked calendar entry along
  if (meeting.eventId && (data.title || data.startsAt || data.endsAt)) {
    await prisma.calendarEvent.update({
      where: { id: meeting.eventId },
      data: {
        title: data.title,
        startsAt: data.startsAt ? new Date(data.startsAt) : undefined,
        endsAt: data.endsAt ? new Date(data.endsAt) : undefined,
      },
    })
  }

  if (before.status !== 'DONE' && meeting.status === 'DONE') {
    await emitAutomationEvent({
      event: 'MEETING_ENDED',
      projectId: meeting.projectId,
      path: `/meetings/${meeting.id}`,
      data: {
        id: meeting.id,
        title: meeting.title,
        startsAt: meeting.startsAt,
        endsAt: meeting.endsAt,
        participants: meeting.participants,
        projectId: meeting.projectId,
        clientId: meeting.clientId,
        // The summary is written by the AI step afterwards, so it is usually
        // still empty here. Sent anyway rather than withheld — a workflow
        // can check.
        summary: meeting.summary,
        minutes: meeting.minutes,
      },
    })
  }
  return meeting
}

export async function deleteMeeting(id: string) {
  const meeting = await prisma.meeting.findUniqueOrThrow({ where: { id } })
  await prisma.meeting.delete({ where: { id } })
  // The calendar entry belongs to the meeting — it goes too, remotely as well.
  if (meeting.eventId) {
    await tombstoneEvent(meeting.eventId)
    await prisma.calendarEvent.delete({ where: { id: meeting.eventId } }).catch(() => {})
  }
}

/** Create or replace the video room after the fact. */
export async function setMeetingVideo(id: string, url?: string) {
  const meeting = await prisma.meeting.findUniqueOrThrow({ where: { id } })

  const room = url
    ? { videoUrl: url, videoProvider: 'CUSTOM' as const }
    : createVideoRoom(meeting.title, await videoSettings())
  if (!room) return { error: 'Kein Videoanbieter konfiguriert' }

  const updated = await prisma.meeting.update({
    where: { id },
    data: { videoUrl: room.videoUrl, videoProvider: room.videoProvider },
  })
  if (meeting.eventId) {
    await prisma.calendarEvent.update({
      where: { id: meeting.eventId },
      data: { videoUrl: room.videoUrl, videoProvider: room.videoProvider },
    })
  }
  return updated
}

/** A ticket off a meeting. It inherits the meeting's project. */
export async function addMeetingActionItem(
  meetingId: string,
  input: { title: string; dueOn?: string | null; assignee?: string | null },
) {
  const meeting = await prisma.meeting.findUniqueOrThrow({ where: { id: meetingId } })
  return prisma.actionItem.create({
    data: {
      title: input.title,
      dueOn: input.dueOn ? new Date(input.dueOn) : null,
      assignee: input.assignee ?? null,
      meetingId,
      projectId: meeting.projectId,
    },
  })
}
