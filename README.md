# Helium

Helium answers questions about me. It's a little AI rep I built into my portfolio —
a chat sidebar that recruiters can ask anything about my background, projects, and
goals, and it answers grounded only in a personal wiki I wrote. This repo is the
backend that powers it.

https://github.com/user-attachments/assets/bd5283cb-95b7-4be2-9dd0-912331de60fa

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

> **On the wiki:** the personal content Helium speaks from lives in a private sibling
> repo (`personal-wiki`), not here — same reason my portfolio stays private. A local
> build step (`scripts/build-wiki.js`) reads that repo, substitutes a redacted
> override for anything under NDA or unpublished, and writes a sanitized copy into
> `helium_wiki/` (also gitignored). `scripts/embed.js` embeds *that* copy into
> Supabase. The deployed function never touches any of this — at runtime it only
> reads the already-embedded chunks.

If you want to see the knowledge layout without private content, use
`wiki-template/`.

## Layout

- `api/chat.js` — the serverless endpoint (agent loop + RAG). Deployed as a Vercel function.
- `wiki-template/` — public scaffold of the wiki schema and folder structure.
- `scripts/build-wiki.js` — generates `helium_wiki/` from the private wiki + redactions. Local-only inputs and output, both gitignored.
- `scripts/embed.js` — truncates and re-embeds `helium_wiki/` into Supabase. Run after `build-wiki.js`.
- `wiki-redactions/` — deliberately vague overrides for anything under NDA or unpublished (currently: Matter Lab). Local-only / gitignored.

## Wiki structure template

The repo includes a safe template at `wiki-template/` that mirrors the structure
Helium expects:

```text
wiki/
  identity.md
  education.md
  skills.md
  goals.md
  experience/
    one-file-per-role.md
  projects/
    one-file-per-project.md
```

This structure is inspired by my work at Matter Lab on agentic memory systems,
adapted here into a much smaller and simplified portfolio-scale setup. The key
idea is still the same: break knowledge into focused, retrievable units.

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

```bash
npm run build:wiki   # regenerate helium_wiki/ from the private wiki + redactions
npm run embed         # truncate wiki_chunks, re-embed everything, re-insert
```

`embed.js` truncates before inserting, so this is safe to re-run any time — a page
removed or redacted upstream actually stops being served, instead of leaving a stale
row behind.

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
