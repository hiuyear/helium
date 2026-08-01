import Anthropic from '@anthropic-ai/sdk';
import 'dotenv/config'
import OpenAI from 'openai'
import { createClient } from '@supabase/supabase-js'
import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'
import {
  createBooking,
  getAvailableSlots,
  isBookingConfigured,
} from '../lib/google-calendar.js'
import { isMessageConfigured, sendMessage } from '../lib/send-message.js'

const HELIUM_ENABLED = true

const ratelimit = new Ratelimit({
  redis: Redis.fromEnv(),
  limiter: Ratelimit.slidingWindow(10, '10 s'),
})

const messageRatelimit = new Ratelimit({
  redis: Redis.fromEnv(),
  prefix: 'helium:message',
  limiter: Ratelimit.slidingWindow(3, '1 h'),
})

const bookingRatelimit = new Ratelimit({
  redis: Redis.fromEnv(),
  prefix: 'helium:booking',
  limiter: Ratelimit.slidingWindow(3, '1 h'),
})

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai = new OpenAI({apiKey: process.env.OPENAI_API_KEY })
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001'

const SYSTEM_PROMPT = `You are Helium — a sharp, confident AI rep for Hiu Yan Kwok, built into her portfolio. Your job is to pitch her to recruiters.

Assume the person you're talking to is a recruiter or someone evaluating Hiu Yan for a role. Your goal is to make them excited about her — not overwhelm them with information.

On the first message: greet them warmly, introduce yourself in one sentence, and invite them to ask anything about Hiu Yan.

Use the search_wiki tool to look up relevant info before answering. Call it multiple times if the question spans multiple topics.

- Keep every response to 2-3 sentences unless they explicitly ask for more detail.
- Lead with the strongest, most relevant point. Don't bury the lede.
- Answer in third person ("Hiu Yan has...", "She built...", "Her background is...").
- No markdown. No bullet points. No asterisks. Plain text only.
- When you name a specific project or experience, end with a separate "learn more" line that includes its writeup URL from the retrieved wiki (the Writeup: line) as a full https://hiuyankwok.com/... URL in plain text so the portfolio UI can make it clickable. Put a blank line between the main answer and that learn-more line (one empty line — so the URL is not stuck to the pitch). Do not invent slugs; if the wiki has no Writeup URL, omit the learn-more line.
- Don't volunteer schedule or availability unprompted. If they ask whether she is open to internships, what she is seeking, or timing (Winter/Summer/etc.), answer that fact from the wiki (goals / identity).
- Contact flow — when they want to connect, reach out, discuss further, meet, network, interview, or follow up on opportunities: (1) answer any factual wiki part first; (2) ask for their email address before doing anything else — do not call check_availability, create_booking, or send_message until you have a valid email; (3) once you have their email, ask whether they want to send a message to Hiu Yan or book a 30-minute meeting.
- Message path: help them say what they want in plain language, turn the conversation into a concise professional email with a clear subject and body, confirm briefly if needed, then call send_message with their email, optional name, subject, and body. Tell them Hiu Yan will reply by email.
- Booking path: ask for their full name if you do not have it yet, then call check_availability for the next 7-14 days, offer only the short list of open times returned by the tool (in America/Toronto, 30 minutes each), ask which slot they want, then call create_booking using the exact startUtc from check_availability and the email you already collected.
- Calendar privacy (hard rules): never invent, describe, or explain why a time is unavailable. Never mention what Hiu Yan is doing, her events, meetings, classes, or busy blocks. Never dump a full day or week of availability. Only offer the small set of bookable slots from check_availability. If they ask what she is busy with, decline and offer a different open slot or the message path instead.
- Do not collect contact info or run contact tools for general wiki questions.
- If contact tools fail, give hiuyan.kwok@mail.utoronto.ca as a manual fallback.
- Only suggest manual email for missing wiki facts when the wiki truly has no answer. Never use email to dodge a factual question the wiki covers.
- Be warm but efficient. A good recruiter pitch moves fast.`

async function searchWiki(query) {
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: query
  })
  const vector = response.data[0].embedding

  const hybrid = await supabase.rpc(`search_wiki`, {
    query_embedding: vector,
    query_text: query,
    match_count: 3
  })

  // Backward compatible fallback if the hybrid-search migration has not run yet.
  if (hybrid.error) {
    const maybeMissingHybridSignature =
      hybrid.error.message.includes('query_text') ||
      hybrid.error.message.includes('does not exist')

    if (!maybeMissingHybridSignature) {
      throw new Error(hybrid.error.message)
    }

    const legacy = await supabase.rpc(`search_wiki`, {
      query_embedding: vector,
      match_count: 3
    })

    if (legacy.error) throw new Error(legacy.error.message)
    return (legacy.data ?? []).map(row => `[${row.filename}]\n${row.content}`).join('\n\n---\n\n')
  }

  return (hybrid.data ?? []).map(row => `[${row.filename}]\n${row.content}`).join('\n\n---\n\n')
}

async function createAnthropicResponse({ currentMessages }) {
  const fallbackModels = [ANTHROPIC_MODEL, 'claude-haiku-4-5-20251001', 'claude-sonnet-5']
  const models = [...new Set(fallbackModels.filter(Boolean))]
  let lastError

  for (const model of models) {
    try {
      return await anthropic.messages.create({
        model,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools,
        messages: currentMessages
      })
    } catch (err) {
      const message = (err?.message ?? '').toLowerCase()
      const isModelIssue =
        err?.status === 404 ||
        (message.includes('model') &&
          (message.includes('not found') ||
            message.includes('not_found') ||
            message.includes('invalid')))

      if (!isModelIssue) throw err
      lastError = err
    }
  }

  throw lastError ?? new Error('No valid Anthropic model available')
}

const messageTool = {
  name: 'send_message',
  description: 'Send an email to Hiu Yan on behalf of the visitor. Use only after collecting their email and turning their intent into a clear subject and body.',
  input_schema: {
    type: 'object',
    properties: {
      fromEmail: {
        type: 'string',
        description: 'Visitor email address',
      },
      fromName: {
        type: 'string',
        description: 'Visitor name, if provided',
      },
      subject: {
        type: 'string',
        description: 'Short professional subject line for the email',
      },
      body: {
        type: 'string',
        description: 'The message body written as a concise professional email based on the conversation',
      },
    },
    required: ['fromEmail', 'subject', 'body'],
  },
}

const bookingTools = [
  {
    name: 'check_availability',
    description: 'Return a small sample of bookable open slots (not a full calendar dump). Does not reveal event titles or busy reasons — only times that can be booked.',
    input_schema: {
      type: 'object',
      properties: {
        startDate: {
          type: 'string',
          description: 'Start date in YYYY-MM-DD format',
        },
        endDate: {
          type: 'string',
          description: 'End date in YYYY-MM-DD format',
        },
        timeZone: {
          type: 'string',
          description: 'Optional IANA timezone for interpreting dates. Defaults to America/Toronto.',
        },
      },
      required: ['startDate', 'endDate'],
    },
  },
  {
    name: 'create_booking',
    description: 'Book a 30-minute portfolio chat on Hiu Yan\'s Google Calendar and send the attendee a calendar invite with Google Meet.',
    input_schema: {
      type: 'object',
      properties: {
        start: {
          type: 'string',
          description: 'Exact slot start time in UTC ISO 8601 from check_availability (startUtc)',
        },
        attendee: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            email: { type: 'string' },
            timeZone: { type: 'string' },
          },
          required: ['name', 'email'],
        },
        summary: {
          type: 'string',
          description: 'Optional calendar event title',
        },
      },
      required: ['start', 'attendee'],
    },
  },
]

const tools = [
  {
    name: 'search_wiki',
    description: 'Search Hiu Yan\'s personal wiki for information about her background, experience, projects, skills, and goals.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query'
        }
      },
      required: ['query']
    }
  },
  ...(isMessageConfigured() ? [messageTool] : []),
  ...(isBookingConfigured() ? bookingTools : []),
]

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

async function executeTool(toolUse, ip) {
  switch (toolUse.name) {
    case 'search_wiki':
      return searchWiki(toolUse.input.query)

    case 'check_availability': {
      const availability = await getAvailableSlots(toolUse.input)
      return JSON.stringify(availability)
    }

    case 'send_message': {
      const { success } = await messageRatelimit.limit(ip)
      if (!success) {
        return JSON.stringify({
          error: 'Too many message attempts from this address. Please try again later or email hiuyan.kwok@mail.utoronto.ca directly.',
        })
      }

      const email = toolUse.input?.fromEmail
      if (!email || !isValidEmail(email)) {
        return JSON.stringify({ error: 'A valid visitor email is required before sending a message.' })
      }

      const subject = toolUse.input?.subject?.trim()
      const body = toolUse.input?.body?.trim()
      if (!subject || !body) {
        return JSON.stringify({ error: 'Both subject and body are required.' })
      }

      try {
        const result = await sendMessage({
          fromEmail: email,
          fromName: toolUse.input?.fromName?.trim(),
          subject,
          body,
        })
        return JSON.stringify(result)
      } catch (err) {
        return JSON.stringify({ error: err.message ?? 'Failed to send message.' })
      }
    }

    case 'create_booking': {
      const { success } = await bookingRatelimit.limit(ip)
      if (!success) {
        return JSON.stringify({
          error: 'Too many booking attempts from this address. Please try again later or email hiuyan.kwok@mail.utoronto.ca.',
        })
      }

      const email = toolUse.input?.attendee?.email
      if (!email || !isValidEmail(email)) {
        return JSON.stringify({ error: 'A valid attendee email is required before booking.' })
      }

      try {
        const booking = await createBooking(toolUse.input)
        return JSON.stringify(booking)
      } catch (err) {
        return JSON.stringify({ error: err.message ?? 'Booking failed.' })
      }
    }

    default:
      return JSON.stringify({ error: `Unknown tool: ${toolUse.name}` })
  }
}

export default async function handler(req, res) {
  if (!HELIUM_ENABLED) {
    return res.status(503).json({ error: 'Helium is currently offline.' })
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const ip = req.headers['x-forwarded-for'] ?? '127.0.0.1'
  const { success } = await ratelimit.limit(ip)
  if (!success) {
    return res.status(429).json({ error: 'Too many requests. Please slow down.' })
  }

  const { messages } = req.body
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Invalid messages' })
  }

  const recentMessages = messages
    .slice(-20)
    .filter((m) => typeof m.content === 'string')


  try {
    const currentMessages = [...recentMessages]

    while (true) {
      const response = await createAnthropicResponse({ currentMessages })

      if (response.stop_reason === 'tool_use') {
        // Return one tool_result per tool_use block.
        const toolUses = response.content.filter((b) => b.type === 'tool_use')

        const toolResults = await Promise.all(
          toolUses.map(async (toolUse) => ({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: await executeTool(toolUse, ip),
          }))
        )

        currentMessages.push({ role: 'assistant', content: response.content })
        currentMessages.push({ role: 'user', content: toolResults })
        continue
      }

      const text = response.content.find((b) => b.type === 'text')?.text ?? ''
      return res.status(200).json({ content: text })
    }

  } catch (err) {
    console.error(err)
    return res.status(500).json({ error: 'Failed to get response' })
  }
}
