<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { api } from '@/api'
import {
  addDays,
  addMonths,
  fmtDate,
  fmtMonthYear,
  fmtTime,
  fmtWeekday,
  fmtWeekdayLong,
  isSameDay,
  isToday,
  isWeekend,
  isoWeek,
  allDayCoversDay,
  layoutOverlaps,
  minutesOfDay,
  readableOn,
  chipStyle,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from '@/lib/calendar'

type EventItem = {
  id: string
  title: string
  description: string | null
  location: string | null
  startsAt: string
  endsAt: string
  allDay: boolean
  kind: string
  videoUrl: string | null
  readOnly: boolean
  recurring: boolean
  project?: { id: string; key: string; name: string; color: string } | null
  client?: { id: string; name: string } | null
  meeting?: { id: string; status: string } | null
  links: { accountId: string }[]
}
type Source = {
  id: string
  label: string
  provider: 'LOCAL' | 'GOOGLE' | 'APPLE'
  color: string
  enabled: boolean
  remoteCalendarName: string | null
}
type Project = { id: string; key: string; name: string }

type ViewMode = 'day' | 'week' | 'month'

/** The row height of one hour in the grid. Carries the whole geometry. */
const HOUR = 52
const DAY_MINUTES = 24 * 60

const view = ref<ViewMode>((localStorage.getItem('soloops.calendarView') as ViewMode) ?? 'week')
const anchor = ref(startOfDay(new Date()))
const events = ref<EventItem[]>([])
const sources = ref<Source[]>([])
const projects = ref<Project[]>([])
const hidden = ref<Set<string>>(new Set())
const loading = ref(false)
const selected = ref<EventItem | null>(null)
const scroller = ref<HTMLElement | null>(null)
const now = ref(new Date())

const showForm = ref(false)
const form = ref({
  title: '',
  startsAt: '',
  endsAt: '',
  kind: 'FOCUS',
  projectId: '',
  location: '',
  withVideo: false,
})

watch(view, (v) => localStorage.setItem('soloops.calendarView', v))

// --- The period of the current view ----------------------------------------

const days = computed<Date[]>(() => {
  if (view.value === 'day') return [anchor.value]
  if (view.value === 'week') {
    const start = startOfWeek(anchor.value)
    return Array.from({ length: 7 }, (_, i) => addDays(start, i))
  }
  // Month: always 6 full weeks, so the grid does not jump around
  const first = startOfWeek(startOfMonth(anchor.value))
  return Array.from({ length: 42 }, (_, i) => addDays(first, i))
})

const rangeFrom = computed(() => days.value[0] ?? startOfDay(new Date()))
const rangeTo = computed(() => addDays(days.value[days.value.length - 1] ?? new Date(), 1))

const title = computed(() => {
  if (view.value === 'day') return `${fmtWeekdayLong(anchor.value)}, ${fmtDate(anchor.value)}`
  if (view.value === 'month') return fmtMonthYear(anchor.value)
  const start = days.value[0]!
  const end = days.value[6]!
  const sameMonth = start.getMonth() === end.getMonth()
  return sameMonth
    ? `${start.getDate()}. – ${end.getDate()}. ${fmtMonthYear(start)}`
    : `${start.getDate()}. ${start.toLocaleDateString('de-DE', { month: 'short' })} – ${end.getDate()}. ${fmtMonthYear(end)}`
})

const subtitle = computed(() => {
  if (view.value === 'month') {
    // In month view the week-number range is more useful than "6 weeks".
    const first = isoWeek(days.value[0]!)
    const last = isoWeek(days.value[days.value.length - 1]!)
    return `KW ${first} – ${last}`
  }
  return `KW ${isoWeek(rangeFrom.value)}`
})

// --- Loading ----------------------------------------------------------------

async function load() {
  loading.value = true
  try {
    events.value = await api.get<EventItem[]>('/api/calendar', {
      from: rangeFrom.value.toISOString(),
      to: rangeTo.value.toISOString(),
    })
  } finally {
    loading.value = false
  }
}

watch([view, anchor], load)

// Switching views resets the viewport to the working day; paging inside one
// view keeps the scroll position, the way Apple Calendar behaves.
watch(view, async () => {
  await nextTick()
  scrollToWorkday()
})

// --- Sources and colours ----------------------------------------------------

const sourceById = computed(() => new Map(sources.value.map((s) => [s.id, s])))

/** An event belongs to the first linked account, otherwise to the local calendar. */
function sourceOf(event: EventItem): Source {
  const accountId = event.links[0]?.accountId
  return (
    (accountId ? sourceById.value.get(accountId) : undefined) ??
    sourceById.value.get('local') ?? {
      id: 'local',
      label: 'soloops',
      provider: 'LOCAL',
      color: '#d8ff55',
      enabled: true,
      remoteCalendarName: null,
    }
  )
}

/**
 * The colour comes from the calendar, not from the project: glancing at the
 * week, "where does this event come from" is the question you want answered
 * without reading. The project sits inside the event as a key.
 */
function colorOf(event: EventItem): string {
  return sourceOf(event).color
}

function toggleSource(id: string) {
  const next = new Set(hidden.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  hidden.value = next
}

const visibleEvents = computed(() => events.value.filter((e) => !hidden.value.has(sourceOf(e).id)))

// --- Events per day ---------------------------------------------------------

function eventsOn(day: Date, opts: { allDay: boolean }): EventItem[] {
  const from = day.getTime()
  const to = from + 86_400_000
  return visibleEvents.value.filter((e) => {
    if (e.allDay !== opts.allDay) return false
    if (e.allDay) return allDayCoversDay(new Date(e.startsAt), new Date(e.endsAt), day)
    return new Date(e.startsAt).getTime() < to && new Date(e.endsAt).getTime() > from
  })
}

/** The positioned events of one day column. */
function timedLayout(day: Date) {
  const dayStart = day.getTime()
  const items = eventsOn(day, { allDay: false }).map((e) => {
    const s = new Date(e.startsAt)
    const en = new Date(e.endsAt)
    // Clip events running past midnight at the day boundary
    const startMin = s.getTime() < dayStart ? 0 : minutesOfDay(s)
    const endMin =
      en.getTime() > dayStart + 86_400_000
        ? DAY_MINUTES
        : startMin + (en.getTime() - s.getTime()) / 60000
    return {
      id: e.id,
      start: startMin,
      // A minimum height, so 15-minute events stay clickable
      end: Math.max(endMin, startMin + 20),
      event: e,
    }
  })

  return layoutOverlaps(items).map(({ item, column, columns }) => {
    const width = 100 / columns
    return {
      event: item.event,
      style: {
        top: `${(item.start / 60) * HOUR}px`,
        height: `${((item.end - item.start) / 60) * HOUR}px`,
        left: `calc(${column * width}% + 2px)`,
        width: `calc(${width}% - 4px)`,
      },
      compact: item.end - item.start < 45,
    }
  })
}

const hasAllDay = computed(() => days.value.some((d) => eventsOn(d, { allDay: true }).length > 0))

// --- The now line -----------------------------------------------------------

let clock: ReturnType<typeof setInterval> | null = null

const nowOffset = computed(() => (minutesOfDay(now.value) / 60) * HOUR)
const nowVisible = computed(
  () => view.value !== 'month' && days.value.some((d) => isSameDay(d, now.value)),
)

// --- Navigation -------------------------------------------------------------

function shift(delta: number) {
  if (view.value === 'day') anchor.value = addDays(anchor.value, delta)
  else if (view.value === 'week') anchor.value = addDays(anchor.value, delta * 7)
  else anchor.value = addMonths(anchor.value, delta)
}

function goToday() {
  anchor.value = startOfDay(new Date())
  nextTick(scrollToWorkday)
}

function openDay(day: Date) {
  anchor.value = startOfDay(day)
  view.value = 'day'
}

/** Open on the working day rather than at midnight. */
function scrollToWorkday() {
  if (!scroller.value) return
  const target = isSameDay(anchor.value, new Date())
    ? Math.max(0, minutesOfDay(new Date()) - 90)
    : 7 * 60
  scroller.value.scrollTop = (target / 60) * HOUR
}

// --- Creating ---------------------------------------------------------------

function localInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** A click on empty grid: open the form at the quarter hour that was hit. */
function slotClick(day: Date, event: MouseEvent) {
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const minutes = Math.floor((((event.clientY - box.top) / HOUR) * 60) / 15) * 15
  const start = new Date(day)
  start.setHours(0, minutes, 0, 0)
  openForm(start)
}

function openForm(start?: Date) {
  const from = start ?? new Date(anchor.value.getTime() + 9 * 3600_000)
  form.value = {
    title: '',
    startsAt: localInput(from),
    endsAt: localInput(new Date(from.getTime() + 3600_000)),
    kind: 'FOCUS',
    projectId: '',
    location: '',
    withVideo: false,
  }
  selected.value = null
  showForm.value = true
}

async function create() {
  await api.post('/api/calendar', {
    ...form.value,
    projectId: form.value.projectId || null,
    location: form.value.location || null,
    startsAt: new Date(form.value.startsAt).toISOString(),
    endsAt: new Date(form.value.endsAt).toISOString(),
  })
  showForm.value = false
  await load()
}

async function remove(event: EventItem) {
  if (!confirm(`„${event.title}" löschen?`)) return
  await api.del(`/api/calendar/${event.id}`)
  selected.value = null
  await load()
}

// --- Startup ----------------------------------------------------------------

onMounted(async () => {
  ;[sources.value, projects.value] = await Promise.all([
    api.get<Source[]>('/api/calendar/sources'),
    api.get<Project[]>('/api/projects'),
  ])
  await load()
  await nextTick()
  scrollToWorkday()
  clock = setInterval(() => (now.value = new Date()), 60_000)
})

onUnmounted(() => {
  if (clock) clearInterval(clock)
})

const hours = Array.from({ length: 24 }, (_, i) => i)
const weekdayNames = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']
</script>

<template>
  <div class="flex h-full flex-col bg-paper">
    <!-- ==================================================================== -->
    <!-- Header                                                                -->
    <!-- ==================================================================== -->
    <header class="shrink-0 border-b border-line bg-shell px-6 py-3">
      <div class="flex flex-wrap items-center gap-4">
        <div class="min-w-0">
          <div class="eyebrow">{{ subtitle }}</div>
          <h1 class="font-display text-2xl font-semibold leading-tight tracking-[-0.02em]">
            {{ title }}
          </h1>
        </div>

        <!-- Paging -->
        <div class="ml-2 flex items-center">
          <button
            class="flex h-8 w-8 items-center justify-center border border-line-strong transition-colors hover:bg-ink hover:text-paper"
            title="Zurück"
            @click="shift(-1)"
          >
            ‹
          </button>
          <button
            class="h-8 border-y border-line-strong px-3 text-[11px] font-bold uppercase tracking-[0.09em] transition-colors hover:bg-ink hover:text-paper"
            @click="goToday"
          >
            Heute
          </button>
          <button
            class="flex h-8 w-8 items-center justify-center border border-line-strong transition-colors hover:bg-ink hover:text-paper"
            title="Weiter"
            @click="shift(1)"
          >
            ›
          </button>
        </div>

        <!-- View -->
        <div class="flex items-center border border-line-strong">
          <button
            v-for="mode in ['day', 'week', 'month'] as ViewMode[]"
            :key="mode"
            class="h-8 px-3 text-[11px] font-bold uppercase tracking-[0.09em] transition-colors"
            :class="view === mode ? 'bg-ink text-paper' : 'hover:bg-ink/5'"
            @click="view = mode"
          >
            {{ mode === 'day' ? 'Tag' : mode === 'week' ? 'Woche' : 'Monat' }}
          </button>
        </div>

        <div class="ml-auto flex items-center gap-2">
          <span v-if="loading" class="text-xs text-muted">lädt …</span>
          <button class="btn-primary" @click="openForm()">
            <span>Termin</span><span aria-hidden="true">+</span>
          </button>
        </div>
      </div>

      <!-- The calendar legend, which doubles as a filter -->
      <div v-if="sources.length > 1" class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <button
          v-for="source in sources"
          :key="source.id"
          class="flex items-center gap-1.5 text-[11px] transition-opacity"
          :class="hidden.has(source.id) ? 'opacity-35' : ''"
          :title="hidden.has(source.id) ? 'einblenden' : 'ausblenden'"
          @click="toggleSource(source.id)"
        >
          <span
            class="h-2.5 w-2.5 shrink-0 border"
            :style="{
              background: hidden.has(source.id) ? 'transparent' : source.color,
              borderColor: source.color,
            }"
          />
          <span class="font-medium">{{ source.remoteCalendarName ?? source.label }}</span>
        </button>
      </div>
    </header>

    <!-- ==================================================================== -->
    <!-- Month view                                                            -->
    <!-- ==================================================================== -->
    <div v-if="view === 'month'" class="flex min-h-0 flex-1 flex-col">
      <div class="grid shrink-0 grid-cols-7 border-b border-line bg-shell">
        <div
          v-for="name in weekdayNames"
          :key="name"
          class="px-2 py-1.5 text-center text-[10px] font-bold uppercase tracking-[0.12em] text-muted"
        >
          {{ name }}
        </div>
      </div>

      <div class="grid min-h-0 flex-1 grid-cols-7 grid-rows-6">
        <div
          v-for="day in days"
          :key="day.toISOString()"
          class="group flex min-h-0 flex-col border-b border-r border-line last:border-r-0"
          :class="[
            day.getMonth() !== anchor.getMonth() ? 'bg-ink/[0.02]' : '',
            isWeekend(day) ? 'bg-ink/[0.015]' : '',
          ]"
        >
          <div class="flex shrink-0 items-center justify-between px-1.5 pt-1">
            <button
              class="flex h-6 min-w-6 items-center justify-center px-1 font-display text-xs font-semibold tabular-nums transition-colors"
              :class="
                isToday(day)
                  ? 'bg-ink text-paper'
                  : day.getMonth() !== anchor.getMonth()
                    ? 'text-muted hover:text-ink'
                    : 'hover:text-blue'
              "
              @click="openDay(day)"
            >
              {{ day.getDate() }}
            </button>
            <button
              class="hidden h-5 w-5 items-center justify-center text-muted transition-colors group-hover:flex hover:text-ink"
              title="Termin anlegen"
              @click="openForm(new Date(day.getTime() + 9 * 3600000))"
            >
              +
            </button>
          </div>

          <div class="min-h-0 flex-1 space-y-0.5 overflow-hidden px-1 pb-1">
            <button
              v-for="e in [
                ...eventsOn(day, { allDay: true }),
                ...eventsOn(day, { allDay: false }),
              ].slice(0, 4)"
              :key="e.id"
              class="flex w-full items-center gap-1 truncate px-1 py-[3px] text-left text-[11px] leading-tight transition-opacity hover:opacity-80"
              :style="
                e.allDay
                  ? { background: colorOf(e), color: readableOn(colorOf(e)) }
                  : chipStyle(colorOf(e))
              "
              @click="selected = e"
            >
              <span
                v-if="!e.allDay"
                class="h-1.5 w-1.5 shrink-0 rounded-full"
                :style="{ background: colorOf(e) }"
              />
              <span v-if="!e.allDay" class="shrink-0 font-display tabular-nums opacity-60">
                {{ new Date(e.startsAt).getHours() }}
              </span>
              <span class="truncate font-medium">{{ e.title }}</span>
            </button>
            <div
              v-if="
                eventsOn(day, { allDay: true }).length + eventsOn(day, { allDay: false }).length > 4
              "
              class="px-1 text-[10px] text-muted"
            >
              +{{
                eventsOn(day, { allDay: true }).length + eventsOn(day, { allDay: false }).length - 4
              }}
              weitere
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ==================================================================== -->
    <!-- Day and week views                                                    -->
    <!-- ==================================================================== -->
    <div v-else class="flex min-h-0 flex-1 flex-col">
      <!-- Column heads -->
      <div
        class="grid shrink-0 border-b border-line bg-shell pr-[10px]"
        :style="{ gridTemplateColumns: `56px repeat(${days.length}, minmax(0, 1fr))` }"
      >
        <div />
        <div
          v-for="day in days"
          :key="day.toISOString()"
          class="border-l border-line px-2 py-2 text-center"
          :class="isWeekend(day) ? 'bg-ink/[0.015]' : ''"
        >
          <div class="text-[10px] font-bold uppercase tracking-[0.12em] text-muted">
            {{ fmtWeekday(day) }}
          </div>
          <button
            class="mx-auto mt-0.5 flex h-7 min-w-7 items-center justify-center px-1.5 font-display text-base font-semibold tabular-nums transition-colors"
            :class="isToday(day) ? 'bg-ink text-paper' : 'hover:text-blue'"
            @click="openDay(day)"
          >
            {{ day.getDate() }}
          </button>
        </div>
      </div>

      <!-- All-day -->
      <div
        v-if="hasAllDay"
        class="grid max-h-24 shrink-0 overflow-y-auto border-b border-line-strong bg-paper-2/60 pr-[10px]"
        :style="{ gridTemplateColumns: `56px repeat(${days.length}, minmax(0, 1fr))` }"
      >
        <div class="py-1 pr-2 text-right text-[10px] uppercase tracking-wide text-muted">
          ganztägig
        </div>
        <div
          v-for="day in days"
          :key="day.toISOString()"
          class="min-h-7 space-y-0.5 border-l border-line p-0.5"
          :class="isWeekend(day) ? 'bg-ink/[0.015]' : ''"
        >
          <button
            v-for="e in eventsOn(day, { allDay: true })"
            :key="e.id"
            class="block w-full truncate px-1.5 py-[3px] text-left text-[11px] font-medium"
            :style="{ background: colorOf(e), color: readableOn(colorOf(e)) }"
            @click="selected = e"
          >
            {{ e.title }}
          </button>
        </div>
      </div>

      <!-- The time grid -->
      <div ref="scroller" class="min-h-0 flex-1 overflow-y-auto">
        <div
          class="relative grid"
          :style="{
            gridTemplateColumns: `56px repeat(${days.length}, minmax(0, 1fr))`,
            height: `${24 * HOUR}px`,
          }"
        >
          <!-- Hour axis -->
          <div class="relative">
            <div
              v-for="h in hours"
              :key="h"
              class="absolute right-2 -translate-y-1/2 font-display text-[11px] tabular-nums text-muted"
              :style="{ top: `${h * HOUR}px` }"
            >
              <span v-if="h > 0">{{ String(h).padStart(2, '0') }}:00</span>
            </div>
          </div>

          <!-- Day columns -->
          <div
            v-for="day in days"
            :key="day.toISOString()"
            class="relative border-l border-line"
            :class="isWeekend(day) ? 'bg-ink/[0.015]' : ''"
            @click.self="slotClick(day, $event)"
          >
            <!-- Hour lines; the half hour only hinted at -->
            <div
              v-for="h in hours"
              :key="h"
              class="pointer-events-none absolute inset-x-0 border-t border-line"
              :style="{ top: `${h * HOUR}px` }"
            />
            <div
              v-for="h in hours"
              :key="`half-${h}`"
              class="pointer-events-none absolute inset-x-0 border-t border-line/40"
              :style="{ top: `${h * HOUR + HOUR / 2}px` }"
            />

            <!-- Events -->
            <button
              v-for="placed in timedLayout(day)"
              :key="placed.event.id"
              class="absolute overflow-hidden border-l-[3px] px-1.5 text-left transition-shadow hover:z-10 hover:shadow-paper"
              :class="placed.compact ? 'py-0' : 'py-1'"
              :style="{ ...placed.style, ...chipStyle(colorOf(placed.event)) }"
              @click.stop="selected = placed.event"
            >
              <div class="truncate text-[12px] font-semibold leading-tight">
                {{ placed.event.title }}
              </div>
              <div
                v-if="!placed.compact"
                class="truncate font-display text-[10px] tabular-nums opacity-70"
              >
                {{ fmtTime(new Date(placed.event.startsAt)) }}–{{
                  fmtTime(new Date(placed.event.endsAt))
                }}
                <span v-if="placed.event.project"> · {{ placed.event.project.key }}</span>
              </div>
              <div
                v-if="!placed.compact && placed.event.videoUrl"
                class="truncate text-[10px] font-bold uppercase tracking-wide opacity-80"
              >
                ▶ Video
              </div>
            </button>

            <!-- Now -->
            <div
              v-if="nowVisible && isSameDay(day, now)"
              class="pointer-events-none absolute inset-x-0 z-20 flex items-center"
              :style="{ top: `${nowOffset}px` }"
            >
              <span class="-ml-1 h-2 w-2 rounded-full bg-bad" />
              <span class="h-px flex-1 bg-bad" />
            </div>
          </div>

          <!-- The now marker on the axis -->
          <div
            v-if="nowVisible"
            class="pointer-events-none absolute left-0 w-14 -translate-y-1/2 pr-2 text-right"
            :style="{ top: `${nowOffset}px` }"
          >
            <span class="bg-bad px-1 font-display text-[10px] font-bold tabular-nums text-paper">
              {{ fmtTime(now) }}
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- ==================================================================== -->
    <!-- Event detail                                                          -->
    <!-- ==================================================================== -->
    <Teleport to="body">
      <div v-if="selected" class="fixed inset-0 z-50 flex items-center justify-center p-6">
        <div class="absolute inset-0 bg-ink/40" @click="selected = null" />
        <div class="popover relative w-full max-w-md">
          <div
            class="flex items-center gap-2 border-b border-ink px-4 py-2.5"
            :style="{ background: chipStyle(colorOf(selected)).background }"
          >
            <span class="h-2.5 w-2.5" :style="{ background: colorOf(selected) }" />
            <span class="eyebrow-muted !text-ink">
              {{ sourceOf(selected).remoteCalendarName ?? sourceOf(selected).label }}
            </span>
            <button class="ml-auto text-sm text-ink/60 hover:text-ink" @click="selected = null">
              ✕
            </button>
          </div>

          <div class="p-5">
            <h2 class="font-display text-xl font-semibold leading-snug tracking-[-0.01em]">
              {{ selected.title }}
            </h2>
            <p class="mt-1 font-display text-sm tabular-nums text-soft">
              <template v-if="selected.allDay">
                {{ fmtDate(new Date(selected.startsAt)) }} · ganztägig
              </template>
              <template v-else>
                {{ fmtWeekdayLong(new Date(selected.startsAt)) }},
                {{ fmtDate(new Date(selected.startsAt)) }} ·
                {{ fmtTime(new Date(selected.startsAt)) }}–{{ fmtTime(new Date(selected.endsAt)) }}
              </template>
            </p>

            <dl class="mt-4 space-y-2 text-sm">
              <div v-if="selected.project" class="flex justify-between gap-4">
                <dt class="text-muted">Projekt</dt>
                <dd>{{ selected.project.key }} — {{ selected.project.name }}</dd>
              </div>
              <div v-if="selected.client" class="flex justify-between gap-4">
                <dt class="text-muted">Kunde</dt>
                <dd>{{ selected.client.name }}</dd>
              </div>
              <div v-if="selected.location" class="flex justify-between gap-4">
                <dt class="text-muted">Ort</dt>
                <dd class="text-right">{{ selected.location }}</dd>
              </div>
            </dl>

            <p v-if="selected.description" class="mt-4 whitespace-pre-line text-sm text-soft">
              {{ selected.description }}
            </p>

            <p v-if="selected.readOnly" class="mt-4 border-l-2 border-warn pl-3 text-xs text-warn">
              Serie aus einem Fremdkalender — Änderungen bitte dort vornehmen.
            </p>

            <div class="mt-5 flex flex-wrap gap-2 border-t border-line pt-4">
              <a
                v-if="selected.videoUrl"
                :href="selected.videoUrl"
                target="_blank"
                class="btn-acid"
              >
                <span>Beitreten</span><span aria-hidden="true">↗</span>
              </a>
              <RouterLink
                v-if="selected.meeting"
                :to="`/meetings/${selected.meeting.id}`"
                class="btn-ghost"
              >
                Zum Meeting
              </RouterLink>
              <button
                v-if="!selected.readOnly"
                class="btn-danger ml-auto"
                @click="remove(selected)"
              >
                Löschen
              </button>
            </div>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- ==================================================================== -->
    <!-- New event                                                             -->
    <!-- ==================================================================== -->
    <Teleport to="body">
      <div v-if="showForm" class="fixed inset-0 z-50 flex items-center justify-center p-6">
        <div class="absolute inset-0 bg-ink/40" @click="showForm = false" />
        <form class="popover relative w-full max-w-lg" @submit.prevent="create">
          <div class="flex items-center gap-2 border-b border-ink bg-acid px-4 py-2.5">
            <span class="eyebrow-muted !text-ink">Neuer Termin</span>
            <button
              type="button"
              class="ml-auto text-sm text-ink/60 hover:text-ink"
              @click="showForm = false"
            >
              ✕
            </button>
          </div>

          <div class="grid gap-3 p-5 sm:grid-cols-2">
            <div class="sm:col-span-2">
              <label class="label">Titel</label>
              <input v-model="form.title" class="input" required autofocus />
            </div>
            <div>
              <label class="label">Beginn</label>
              <input v-model="form.startsAt" type="datetime-local" class="input" required />
            </div>
            <div>
              <label class="label">Ende</label>
              <input v-model="form.endsAt" type="datetime-local" class="input" required />
            </div>
            <div>
              <label class="label">Art</label>
              <select v-model="form.kind" class="input">
                <option value="FOCUS">Fokusarbeit</option>
                <option value="MEETING">Meeting</option>
                <option value="ADMIN">Admin</option>
                <option value="TRAVEL">Reise</option>
                <option value="PERSONAL">Privat</option>
              </select>
            </div>
            <div>
              <label class="label">Projekt</label>
              <select v-model="form.projectId" class="input">
                <option value="">—</option>
                <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.key }}</option>
              </select>
            </div>
            <div class="sm:col-span-2">
              <label class="label">Ort</label>
              <input v-model="form.location" class="input" />
            </div>
            <label class="flex items-center gap-2 text-sm sm:col-span-2">
              <input v-model="form.withVideo" type="checkbox" /> Videoraum anlegen
            </label>
          </div>

          <div class="flex justify-end gap-2 border-t border-line px-5 py-3">
            <button type="button" class="btn-ghost" @click="showForm = false">Abbrechen</button>
            <button class="btn-primary">
              <span>Anlegen</span><span aria-hidden="true">↗</span>
            </button>
          </div>
        </form>
      </div>
    </Teleport>
  </div>
</template>
