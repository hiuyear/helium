import 'dotenv/config'
import { createBooking, getAvailableSlots, isBookingConfigured } from '../lib/google-calendar.js'

async function main() {
  if (!isBookingConfigured()) {
    throw new Error('Google Calendar env vars are not configured yet.')
  }

  const startDate = new Date().toISOString().slice(0, 10)
  const endDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

  const availability = await getAvailableSlots({ startDate, endDate })
  console.log('Available slots (next 7 days):')
  console.log(JSON.stringify(availability, null, 2))

  if (availability.slots.length === 0) {
    console.log('\nNo open slots found in the test window.')
    return
  }

  const first = availability.slots[0]
  console.log(`\nCreating test booking for ${first.startLocal} ...`)

  const booking = await createBooking({
    start: first.startUtc,
    attendee: {
      name: 'Helium Test',
      email: 'hiuyan.kwok@mail.utoronto.ca',
      timeZone: availability.timeZone,
    },
  })

  console.log('\nCreated test event:')
  console.log(JSON.stringify(booking, null, 2))
  console.log('\nDelete this event manually in Google Calendar when done.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
