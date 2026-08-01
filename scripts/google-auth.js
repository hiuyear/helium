import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import 'dotenv/config'
import { google } from 'googleapis'

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.freebusy',
]
const REDIRECT_URI = 'http://localhost:3000/oauth2callback'

function requireEnv(name) {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing ${name} in .env`)
  }
  return value
}

async function main() {
  const clientId = requireEnv('GOOGLE_CLIENT_ID')
  const clientSecret = requireEnv('GOOGLE_CLIENT_SECRET')

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI)

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
  })

  console.log('\n1. Open this URL in your browser and sign in:\n')
  console.log(authUrl)
  console.log('\n2. After approving, Google redirects to localhost and shows a code in the URL.')
  console.log('   Copy the "code" query param value and paste it below.\n')

  const rl = readline.createInterface({ input, output })
  const code = await rl.question('Authorization code: ')
  rl.close()

  const { tokens } = await oauth2Client.getToken(code.trim())
  oauth2Client.setCredentials(tokens)

  if (!tokens.refresh_token) {
    console.error('\nNo refresh_token returned. Revoke app access in Google Account settings and rerun with prompt=consent.')
    process.exit(1)
  }

  console.log('\nAdd this to your .env and Vercel project:\n')
  console.log(`GOOGLE_CALENDAR_REFRESH_TOKEN=${tokens.refresh_token}`)
  console.log('\nThen run: node scripts/test-booking.js\n')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
