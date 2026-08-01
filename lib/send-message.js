function requireEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

function formatEmailBody({ fromEmail, fromName, body }) {
  const sender = fromName ? `${fromName} <${fromEmail}>` : fromEmail
  return [
    'New message via Helium (portfolio chat).',
    '',
    `From: ${sender}`,
    '',
    body.trim(),
    '',
    '---',
    'Reply directly to this email to reach the sender.',
  ].join('\n')
}

export function isMessageConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.MESSAGE_TO_EMAIL)
}

export async function sendMessage({ fromEmail, fromName, subject, body }) {
  requireEnv('RESEND_API_KEY')
  const to = requireEnv('MESSAGE_TO_EMAIL')
  const from = process.env.MESSAGE_FROM_EMAIL || 'Helium <onboarding@resend.dev>'

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [to],
      reply_to: fromEmail,
      subject: subject.startsWith('[Portfolio]') ? subject : `[Portfolio] ${subject}`,
      text: formatEmailBody({ fromEmail, fromName, body }),
    }),
  })

  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(payload.message ?? payload.error ?? 'Failed to send message.')
  }

  return {
    id: payload.id,
    to,
    replyTo: fromEmail,
  }
}
