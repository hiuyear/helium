function stripEnv(value) {
  if (!value) return value
  return String(value).trim().replace(/^["']|["']$/g, '')
}

function requireEnv(name) {
  const value = stripEnv(process.env[name])
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
  return Boolean(stripEnv(process.env.RESEND_API_KEY) && stripEnv(process.env.MESSAGE_TO_EMAIL))
}

export async function sendMessage({ fromEmail, fromName, subject, body }) {
  const apiKey = requireEnv('RESEND_API_KEY')
  const to = requireEnv('MESSAGE_TO_EMAIL')
  const from = stripEnv(process.env.MESSAGE_FROM_EMAIL) || 'Helium <onboarding@resend.dev>'

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
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
    status: 'accepted_by_resend',
    to,
    replyTo: fromEmail,
    note: 'Accepted by Resend. If you do not see it, check spam and confirm MESSAGE_TO_EMAIL on the server.',
  }
}
