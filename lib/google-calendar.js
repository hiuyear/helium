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

function stripEnv(value) {
  if (!value) return value
  return value.trim().replace(/^["']|["']$/g, '')
}

function parseBookingConfig() {
  const hoursStart = stripEnv(process.env.BOOKING_HOURS_START) || '09:00'
  const hoursEnd = stripEnv(process.env.BOOKING_HOURS_END) || '19:00'
  const daysRaw = stripEnv(process.env.BOOKING_DAYS) || '1,2,3,4,5'
  const days = daysRaw.split(',').map((d) => Number(d.trim())).filter((n) => n >= 1 && n <= 7)
  const durationMinutes = Number(stripEnv(process.env.BOOKING_DURATION_MINUTES) || 30)

  return {
    timeZone: stripEnv(process.env.BOOKING_TIMEZONE) || 'America/Toronto',
    durationMinutes: Number.isFinite(durationMinutes) && durationMinutes > 0 ? durationMinutes : 30,
    hoursStart,
    hoursEnd,
    days: days.length > 0 ? days : [1, 2, 3, 4, 5],
    calendarId: stripEnv(process.env.GOOGLE_CALENDAR_ID) || 'primary',
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
 * Prefer soonest open slots (next 2–3 days), not a spread across the whole week.
 */
function sampleSlots(available, _timeZone, maxSlots = 6) {
  return available.slice(0, maxSlots)
}

export async function getAvailableSlots({ startDate, endDate, timeZone }) {
  const config = parseBookingConfig()
  const zone = timeZone || config.timeZone
  const today = DateTime.now().setZone(config.timeZone).startOf('day')

  let rangeStartLocal = DateTime.fromISO(startDate, { zone })
  let rangeEndLocal = DateTime.fromISO(endDate, { zone })

  // Models often pass last year's dates. Clamp to a real upcoming window.
  if (!rangeStartLocal.isValid || rangeStartLocal < today) {
    rangeStartLocal = today
  }
  if (!rangeEndLocal.isValid || rangeEndLocal < rangeStartLocal) {
    // Default preference: next ~3 calendar days (covers 2–3 business days).
    rangeEndLocal = rangeStartLocal.plus({ days: 2 })
  }

  // Cap to 14 days so we never scan huge ranges.
  if (rangeEndLocal > rangeStartLocal.plus({ days: 13 })) {
    rangeEndLocal = rangeStartLocal.plus({ days: 13 })
  }

  async function slotsFor(startLocal, endLocal) {
    const startDateClamped = startLocal.toISODate()
    const endDateClamped = endLocal.toISODate()
    const busyIntervals = await queryFreeBusy(
      startLocal.startOf('day').toUTC().toISO(),
      endLocal.endOf('day').toUTC().toISO(),
      config.calendarId
    )
    const candidates = generateCandidateSlots(startDateClamped, endDateClamped, config)
    const available = filterAvailableSlots(candidates, busyIntervals, config.durationMinutes)
    return {
      startDateClamped,
      endDateClamped,
      available,
    }
  }

  // Prefer the near window first; only widen if nothing is free soon.
  let result = await slotsFor(rangeStartLocal, rangeEndLocal)
  let widened = false
  if (result.available.length === 0) {
    const wideEnd = rangeStartLocal.plus({ days: 13 })
    if (wideEnd > rangeEndLocal) {
      result = await slotsFor(rangeStartLocal, wideEnd)
      widened = result.available.length > 0
    }
  }

  const sampled = sampleSlots(result.available, config.timeZone)

  return {
    timeZone: config.timeZone,
    durationMinutes: config.durationMinutes,
    rangeStart: result.startDateClamped,
    rangeEnd: result.endDateClamped,
    preferredWindowDays: 3,
    widenedBeyondPreferred: widened,
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
