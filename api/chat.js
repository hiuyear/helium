import Anthropic from '@anthropic-ai/sdk';
import 'dotenv/config'
import OpenAI from 'openai'
import { createClient } from '@supabase/supabase-js'
import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'

const HELIUM_ENABLED = true

const ratelimit = new Ratelimit({
  redis: Redis.fromEnv(),
  limiter: Ratelimit.slidingWindow(10, '10 s'),
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
- When you name a specific project or experience, include its writeup URL from the retrieved wiki (the Writeup: line) as a full https://hiuyankwok.com/... URL in plain text so the portfolio UI can make it clickable. Do not invent slugs; if the wiki has no Writeup URL, omit the link.
- Don't volunteer upcoming commitments or schedule unless they ask about a skill directly tied to it.
- If the wiki doesn't have the answer, say so briefly and suggest emailing hiuyan.kwok@mail.utoronto.ca.
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
  }
]

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
            content: await searchWiki(toolUse.input.query)
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
