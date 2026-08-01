import { randomUUID } from 'node:crypto'
import { google } from 'googleapis'
import { DateTime } from 'luxon'

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.freebusy',
]

function requireEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

function parseBookingConfig() {
  const hoursStart = process.env.BOOKING_HOURS_START || '09:00'
  const hoursEnd = process.env.BOOKING_HOURS_END || '19:00'

  return {
    timeZone: process.env.BOOKING_TIMEZONE || 'America/Toronto',
    durationMinutes: Number(process.env.BOOKING_DURATION_MINUTES || 30),
    hoursStart,
    hoursEnd,
    days: (process.env.BOOKING_DAYS || '1,2,3,4,5').split(',').map(Number),
    calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
    startHour: Number(hoursStart.split(':')[0]),
    startMinute: Number(hoursStart.split(':')[1] || 0),
    endHour: Number(hoursEnd.split(':')[0]),
    endMinute: Number(hoursEnd.split(':')[1] || 0),
  }
}

function getOAuthClient() {
  const client = new google.auth.OAuth2(
    requireEnv('GOOGLE_CLIENT_ID'),
    requireEnv('GOOGLE_CLIENT_SECRET')
  )
  client.setCredentials({
    refresh_token: requireEnv('GOOGLE_CALENDAR_REFRESH_TOKEN'),
  })
  return client
}

async function getCalendarClient() {
  const auth = getOAuthClient()
  return google.calendar({ version: 'v3', auth })
}

function overlapsInterval(start, end, busyStart, busyEnd) {
  return start < busyEnd && end > busyStart
}

function normalizeBusyIntervals(busy = []) {
  return busy.map((block) => ({
    start: DateTime.fromISO(block.start, { setZone: true }),
    end: DateTime.fromISO(block.end, { setZone: true }),
  }))
}

async function queryFreeBusy(timeMin, timeMax, calendarId) {
  const calendar = await getCalendarClient()
  const response = await calendar.freebusy.query({
    requestBody: {
      timeMin,
      timeMax,
      items: [{ id: calendarId }],
    },
  })

  const busy = response.data.calendars?.[calendarId]?.busy ?? []
  return normalizeBusyIntervals(busy)
}

function generateCandidateSlots(startDate, endDate, config) {
  const slots = []
  let cursor = DateTime.fromISO(startDate, { zone: config.timeZone }).startOf('day')
  const end = DateTime.fromISO(endDate, { zone: config.timeZone }).startOf('day')
  const now = DateTime.now()

  while (cursor <= end) {
    if (config.days.includes(cursor.weekday)) {
      let slotStart = cursor.set({
        hour: config.startHour,
        minute: config.startMinute,
        second: 0,
        millisecond: 0,
      })
      const dayEnd = cursor.set({
        hour: config.endHour,
        minute: config.endMinute,
        second: 0,
        millisecond: 0,
      })
      const lastStart = dayEnd.minus({ minutes: config.durationMinutes })

      while (slotStart <= lastStart) {
        if (slotStart > now) {
          slots.push(slotStart.toUTC())
        }
        slotStart = slotStart.plus({ minutes: config.durationMinutes })
      }
    }
    cursor = cursor.plus({ days: 1 })
  }

  return slots
}

function filterAvailableSlots(candidateSlots, busyIntervals, durationMinutes) {
  return candidateSlots.filter((slotStart) => {
    const slotEnd = slotStart.plus({ minutes: durationMinutes })
    return !busyIntervals.some((busy) =>
      overlapsInterval(slotStart, slotEnd, busy.start, busy.end)
    )
  })
}

export function isBookingConfigured() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.GOOGLE_CALENDAR_REFRESH_TOKEN
  )
}

/**
 * Pick a small, day-spread sample of open slots.
 * Never return busy intervals or a full-day dump — that would leak schedule shape.
 */
function sampleSlots(available, timeZone, maxSlots = 6) {
  if (available.length <= maxSlots) return available

  const byDay = new Map()
  for (const slot of available) {
    const day = slot.setZone(timeZone).toISODate()
    if (!byDay.has(day)) byDay.set(day, [])
    byDay.get(day).push(slot)
  }

  const days = [...byDay.keys()]
  const sampled = []
  let dayIndex = 0

  while (sampled.length < maxSlots && days.length > 0) {
    const day = days[dayIndex % days.length]
    const daySlots = byDay.get(day)
    if (daySlots.length > 0) {
      sampled.push(daySlots.shift())
    }
    if (daySlots.length === 0) {
      days.splice(dayIndex % days.length, 1)
      if (days.length === 0) break
      dayIndex = dayIndex % days.length
    } else {
      dayIndex = (dayIndex + 1) % days.length
    }
  }

  return sampled.sort((a, b) => a.toMillis() - b.toMillis())
}

export async function getAvailableSlots({ startDate, endDate, timeZone }) {
  const config = parseBookingConfig()
  const zone = timeZone || config.timeZone

  const rangeStart = DateTime.fromISO(startDate, { zone }).startOf('day').toUTC().toISO()
  const rangeEnd = DateTime.fromISO(endDate, { zone }).endOf('day').toUTC().toISO()

  // freeBusy returns only busy windows — never event titles or descriptions.
  const busyIntervals = await queryFreeBusy(rangeStart, rangeEnd, config.calendarId)
  const candidates = generateCandidateSlots(startDate, endDate, config)
  const available = filterAvailableSlots(candidates, busyIntervals, config.durationMinutes)
  const sampled = sampleSlots(available, config.timeZone)

  return {
    timeZone: config.timeZone,
    durationMinutes: config.durationMinutes,
    // Offer a short sample only — never the full open calendar.
    slots: sampled.map((slot) => ({
      startUtc: slot.toISO(),
      startLocal: slot.setZone(config.timeZone).toFormat("EEE, MMM d 'at' h:mm a"),
    })),
  }
}

export async function createBooking({ start, attendee, summary }) {
  const config = parseBookingConfig()
  const slotStart = DateTime.fromISO(start, { zone: 'utc' })
  const slotEnd = slotStart.plus({ minutes: config.durationMinutes })

  if (!slotStart.isValid) {
    throw new Error('Invalid start time. Use an ISO 8601 UTC timestamp from check_availability.')
  }

  const busyIntervals = await queryFreeBusy(
    slotStart.minus({ minutes: 1 }).toISO(),
    slotEnd.plus({ minutes: 1 }).toISO(),
    config.calendarId
  )

  if (
    busyIntervals.some((busy) =>
      overlapsInterval(slotStart, slotEnd, busy.start, busy.end)
    )
  ) {
    throw new Error('That slot was just taken. Please choose another time.')
  }

  const calendar = await getCalendarClient()
  const response = await calendar.events.insert({
    calendarId: config.calendarId,
    conferenceDataVersion: 1,
    sendUpdates: 'all',
    requestBody: {
      summary: summary || `Portfolio chat with ${attendee.name}`,
      description: 'Booked via Helium, Hiu Yan Kwok\'s portfolio assistant.',
      start: {
        dateTime: slotStart.setZone(config.timeZone).toISO({ suppressMilliseconds: true }),
        timeZone: config.timeZone,
      },
      end: {
        dateTime: slotEnd.setZone(config.timeZone).toISO({ suppressMilliseconds: true }),
        timeZone: config.timeZone,
      },
      attendees: [
        {
          email: attendee.email,
          displayName: attendee.name,
        },
      ],
      conferenceData: {
        createRequest: {
          requestId: randomUUID(),
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      },
    },
  })

  const meetLink =
    response.data.hangoutLink ??
    response.data.conferenceData?.entryPoints?.find((entry) => entry.entryPointType === 'video')
      ?.uri

  return {
    eventId: response.data.id,
    start: response.data.start?.dateTime ?? slotStart.toISO(),
    end: response.data.end?.dateTime ?? slotEnd.toISO(),
    htmlLink: response.data.htmlLink,
    meetLink,
    timeZone: config.timeZone,
  }
}
