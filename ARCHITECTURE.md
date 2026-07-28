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

- Source files live in a private sibling repo (`personal-wiki/wiki/`), not this one
- `scripts/build-wiki.js` copies each file into `helium_wiki/`, substituting a
  redacted override from `wiki-redactions/` where one exists (currently: Matter Lab,
  which is under NDA and pre-publication)
- `scripts/embed.js` truncates `wiki_chunks`, then embeds and re-inserts every file
  in `helium_wiki/` — a full rebuild each run, not an incremental upsert, so a page
  removed or newly redacted upstream actually stops being retrievable

### Online serving

- User query is embedded at request time
- `search_wiki` runs vector + full-text retrieval
- Top results are returned to Claude as tool output
- Claude generates the final response from retrieved context

## Knowledge Structure

Helium's knowledge base uses one markdown file per topic/role/project, with YAML
frontmatter for type and metadata. This keeps chunks cohesive for retrieval and
easy to maintain over time.

The public repo includes `wiki-template/` as a reference schema. The production
content lives in a private sibling repo and passes through a redaction layer before
being embedded into Supabase — see "Wiki Source Separation" below.

This design is inspired by my work at Matter Lab on agentic memory, implemented
here at a smaller and intentionally simplified scope for a personal portfolio
assistant.

## Wiki Source Separation

The private wiki also backs resume tailoring, which needs far more detail — and
occasionally NDA-covered specifics — than a public chatbot should ever surface. Two
failure modes shaped this design:

- **A single hand-maintained "safe" copy drifts.** Early on, the sanitized wiki was
  a manually edited duplicate of the private one. It silently lost an entire project
  page and a contact line — nothing enforced that the copy stayed in sync.
- **Redacting at embed time leaves nothing to inspect.** Applying redactions inline,
  with no intermediate artifact, means there's no diff to eyeball before anything
  reaches a public database.

The fix: the private wiki (`personal-wiki/wiki/`, a separate repo) is the only place
content gets edited. `scripts/build-wiki.js` regenerates `helium_wiki/` from it on
every run, substituting a local override from `wiki-redactions/` for any page that
needs one — currently just Matter Lab. The output directory is wiped and rebuilt
from scratch each run, so a file deleted or newly excluded upstream actually
disappears downstream instead of lingering — the same reasoning `scripts/embed.js`
applies at the database layer (truncate before re-insert, not upsert).
`wiki-redactions/` stays gitignored even though its content is already public-safe:
nothing wiki-shaped lives in this repo at all.

## Security and Operations

- **Rate limiting:** Upstash sliding window per IP
- **Runtime boundary:** backend is deployable without shipping private wiki files
- **Feature switch:** `HELIUM_ENABLED` allows temporary offline mode
- **Serverless-friendly:** stateless handler, externalized state in Supabase/Redis

## Repository Boundary

- This repo contains backend logic (`api/`, `scripts/`, `supabase/`)
- Portfolio frontend remains separate and calls `/api/chat` through a Vercel rewrite
- Private wiki content lives in its own repo (`personal-wiki`) and is intentionally
  excluded from this one, along with the redaction overrides that sanitize it
  (see "Wiki Source Separation")

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
