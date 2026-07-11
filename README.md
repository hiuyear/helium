# Helium

Helium answers questions about me. It's a little AI rep I built into my portfolio —
a chat sidebar that recruiters can ask anything about my background, projects, and
goals, and it answers grounded only in a personal wiki I wrote. This repo is the
backend that powers it.

I originally built Helium inside my portfolio repo, which I keep private. I pulled
the backend out into its own repo so I can keep building it in the open without
exposing the rest of my site — so what you're looking at here is Helium's engine,
minus the personal content it draws from (more on that below).

## Architecture

For a deeper technical breakdown of Helium's retrieval pipeline, system design, and engineering tradeoffs, see [`ARCHITECTURE.md`](./ARCHITECTURE.md).

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
      │        - hybrid search over the wiki (Supabase):      │
      │            vector similarity + full-text (RRF)      │
      │     ...handles MULTIPLE parallel tool calls per turn  │
      │  4. feed results back, loop until Claude answers      │
      ▼                                                       │
   { content: "..." }  ◀──────────────────────────────────────┘
```

The knowledge base is a set of markdown files. `scripts/embed.js` embeds each file
into a Supabase table (`wiki_chunks`) that `search_wiki` queries at runtime — this
is retrieval-augmented generation (RAG): the model only answers from the wiki.

> **On the wiki:** the `wiki/` markdown is the personal content Helium speaks from,
> so I keep it out of this repo (gitignored) — same reason my portfolio stays private.
> The deployed function never needs it: at runtime it reads the already-embedded
> chunks from Supabase. The markdown only lives on my machine, where I use it to
> (re)build those embeddings with `scripts/embed.js`.

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
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | vector + full-text store (`wiki_chunks` + `search_wiki` RPC) |
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

## Hybrid search migration

Search combines **vector similarity** (semantic) with **Postgres full-text search**
(keyword/exact matches) using reciprocal rank fusion. Run the migration once in
Supabase before deploying an updated `api/chat.js`:

```bash
# paste supabase/migrations/001_hybrid_search.sql into the Supabase SQL editor
# or, if you use the Supabase CLI:
supabase db push
```

The migration adds a generated `fts` column on `wiki_chunks` and replaces the
`search_wiki` RPC to accept both `query_embedding` and `query_text`. No re-embed
is required — existing rows pick up the full-text index automatically.
