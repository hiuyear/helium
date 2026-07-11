# Helium Architecture

Helium is a retrieval-augmented chat backend for a portfolio site. It is designed to answer recruiter questions with grounded, high-signal responses sourced from a private wiki.

## Goals

- Keep answers factual and tied to source material
- Minimize latency and token cost for common recruiter questions
- Keep infrastructure simple enough to reason about and iterate quickly
- Separate private content authoring from public backend code

## System Overview

```
portfolio chat ui
  -> POST /api/chat
  -> api/chat.js
       1) rate limit request (Upstash Redis)
       2) call Claude with search_wiki tool
       3) on tool call: embed query (OpenAI)
       4) run hybrid retrieval in Supabase
       5) return retrieved context to Claude
       6) return final response to client
```

## Why RAG

Early versions injected all wiki content into the system prompt on every request. That approach increased cost, added irrelevant context, and made outputs less consistent.

RAG fixes this by retrieving only the most relevant chunks per question. The model stays grounded while the prompt remains compact.

## Retrieval Design

Helium uses **hybrid search** in Supabase:

- **Dense retrieval (pgvector):** semantic similarity on embeddings
- **Sparse retrieval (Postgres full-text):** exact term matching
- **Fusion (RRF):** combines both rankings into one result list

This combination improves recall for both paraphrased questions and exact tokens (company names, project names, course codes).

### Why this hybrid approach

- Vector search alone can miss precise keyword-heavy queries
- Keyword search alone misses semantic paraphrases
- RRF is robust because it fuses ranks instead of score scales

### Database choices

- Postgres + pgvector keeps vector and keyword retrieval in one store
- Generated `fts` column keeps full-text index maintenance in SQL, not app code
- A single RPC (`search_wiki`) encapsulates retrieval logic cleanly

## Agent Loop Design

`api/chat.js` runs a tool-use loop with Claude:

- The model decides when retrieval is needed
- The server executes retrieval through `search_wiki`
- The loop supports multiple tool calls in one turn
- Any non-tool stop reason returns the response immediately

This keeps policy and orchestration in one place and avoids brittle hardcoded retrieval on every single user message.

## Data Flow

### Offline indexing

- Source files live in `wiki/` (local/private)
- `scripts/embed.js` reads markdown files
- Each file is embedded once with OpenAI
- Rows are inserted into `wiki_chunks` in Supabase

### Online serving

- User query is embedded at request time
- `search_wiki` runs vector + full-text retrieval
- Top results are returned to Claude as tool output
- Claude generates the final response from retrieved context

## Security and Operations

- **Rate limiting:** Upstash sliding window per IP
- **Runtime boundary:** backend is deployable without shipping private wiki files
- **Feature switch:** `HELIUM_ENABLED` allows temporary offline mode
- **Serverless-friendly:** stateless handler, externalized state in Supabase/Redis

## Repository Boundary

- This repo contains backend logic (`api/`, `scripts/`, `supabase/`)
- Portfolio frontend remains separate and calls `/api/chat` through a Vercel rewrite
- Private wiki content is intentionally excluded from the public repo

## Key Tradeoffs

- Hybrid retrieval adds SQL complexity, but improves answer quality on real recruiter-style queries
- Sequential embed script is simpler and safer for rate limits than aggressive parallel writes
- Prompt constraints improve style consistency, but hard formatting guarantees should be enforced in code when required

## Current Stack

- Anthropic Claude (response generation + tool decisions)
- OpenAI `text-embedding-3-small` (embeddings)
- Supabase Postgres + pgvector + full-text search (retrieval)
- Upstash Redis + `@upstash/ratelimit` (abuse protection)
- Vercel Serverless Functions (deployment)
