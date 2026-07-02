# Helium

A wiki-grounded AI agent that answers questions about Hiu Yan Kwok, built to pitch
her to recruiters. Helium is embedded in [her portfolio](https://github.com/hiuyear/portfolio2)
as a chat sidebar; this repo is the backend that powers it.

## How it works

```
browser (portfolio chat UI)
      │  POST /api/chat  { messages: [...] }
      ▼
api/chat.js  ── the agent loop ──────────────────────────────┐
      │                                                       │
      │  1. rate-limit the caller (Upstash Redis)             │
      │  2. call Claude (Haiku) with the search_wiki tool     │
      │  3. Claude asks to search → run search_wiki:          │
      │        - embed the query (OpenAI text-embedding-3)    │
      │        - vector search over the wiki (Supabase pgvector)
      │     ...handles MULTIPLE parallel tool calls per turn  │
      │  4. feed results back, loop until Claude answers      │
      ▼                                                       │
   { content: "..." }  ◀──────────────────────────────────────┘
```

The knowledge base is a set of markdown files. `scripts/embed.js` embeds each file
into a Supabase table (`wiki_chunks`) that `search_wiki` queries at runtime — this
is retrieval-augmented generation (RAG): the model only answers from the wiki.

> **Note:** the `wiki/` markdown holds personal content and is intentionally kept
> out of this repo (gitignored). The deployed function doesn't need it — it reads
> the already-embedded chunks from Supabase. `wiki/` is only used locally to
> (re)build those embeddings via `scripts/embed.js`.

## Layout

- `api/chat.js` — the serverless endpoint (agent loop + RAG). Deployed as a Vercel function.
- `wiki/` — the knowledge base (markdown). Local-only / gitignored; not in this repo.
- `scripts/embed.js` — embeds `wiki/` into Supabase. Run after editing the wiki.

## Environment variables

Set these locally in `.env` (gitignored) and in the Vercel project:

| Var | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Claude (the model) |
| `OPENAI_API_KEY` | embeddings for search |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | vector store (`wiki_chunks` + `search_wiki` RPC) |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | rate limiting |

## Local development

```bash
npm install
cp .env.example .env   # then fill in the keys
vercel dev             # serves /api/chat locally
```

## Updating the wiki

The embed script has no de-dup — re-embed clean:

```bash
# 1. edit files in wiki/
# 2. clear the wiki_chunks table in Supabase
# 3. re-embed
npm run embed
```
