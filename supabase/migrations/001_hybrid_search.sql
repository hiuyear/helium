-- Hybrid search: combine pgvector similarity with Postgres full-text search.
-- Run this in the Supabase SQL editor (or via supabase db push) before deploying
-- the updated api/chat.js handler.

-- Full-text index over filename + content. Generated column stays in sync automatically.
alter table wiki_chunks
  add column if not exists fts tsvector
  generated always as (
    to_tsvector('english', coalesce(filename, '') || ' ' || coalesce(content, ''))
  ) stored;

create index if not exists wiki_chunks_fts_idx on wiki_chunks using gin (fts);

-- Reciprocal rank fusion (RRF) merges vector and keyword results.
-- query_text drives keyword search; query_embedding drives vector search.
create or replace function search_wiki(
  query_embedding vector(1536),
  query_text text,
  match_count int default 3
)
returns table (
  filename text,
  content text,
  similarity float
)
language sql
as $$
  with vector_search as (
    select
      wc.id,
      wc.filename,
      wc.content,
      row_number() over (order by wc.embedding <=> query_embedding) as rank
    from wiki_chunks wc
    order by wc.embedding <=> query_embedding
    limit greatest(match_count * 4, 12)
  ),
  keyword_search as (
    select
      wc.id,
      wc.filename,
      wc.content,
      row_number() over (
        order by ts_rank(wc.fts, websearch_to_tsquery('english', query_text)) desc
      ) as rank
    from wiki_chunks wc
    where query_text <> ''
      and wc.fts @@ websearch_to_tsquery('english', query_text)
    order by ts_rank(wc.fts, websearch_to_tsquery('english', query_text)) desc
    limit greatest(match_count * 4, 12)
  ),
  rrf as (
    select
      coalesce(v.id, k.id) as id,
      coalesce(v.filename, k.filename) as filename,
      coalesce(v.content, k.content) as content,
      coalesce(1.0 / (60 + v.rank), 0.0) + coalesce(1.0 / (60 + k.rank), 0.0) as score
    from vector_search v
    full outer join keyword_search k using (id)
  )
  select r.filename, r.content, r.score as similarity
  from rrf r
  order by r.score desc
  limit match_count;
$$;
