import 'dotenv/config'
import { sendMessage, isMessageConfigured } from '../lib/send-message.js'

async function main() {
  if (!isMessageConfigured()) {
    throw new Error('Set RESEND_API_KEY and MESSAGE_TO_EMAIL in .env first.')
  }

  const result = await sendMessage({
    fromEmail: 'visitor@example.com',
    fromName: 'Helium Test',
    subject: 'Test message from Helium',
    body: 'This is a test message sent by scripts/test-message.js. Safe to ignore.',
  })

  console.log('Sent:', result)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
