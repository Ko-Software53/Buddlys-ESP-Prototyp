create extension if not exists vector;

create table if not exists global_knowledge (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  content text not null,
  embedding vector(1024),
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- NOTE: no ANN index on purpose. Klexikon is ~966 articles (~a few thousand
-- chunks). An exact cosine scan over that is sub-millisecond and gives perfect
-- recall. An ivfflat index at this size would only HURT recall (with lists=100
-- and the default probes=1 you'd scan ~1% of rows). Add ivfflat only if this
-- table ever grows past ~100k rows, sized lists ≈ rows/1000, built AFTER load:
--   create index on global_knowledge using ivfflat (embedding vector_cosine_ops)
--     with (lists = <rows/1000>);

-- Function to match global knowledge
create or replace function match_global_knowledge (
  query_embedding vector(1024),
  match_threshold float,
  match_count int
)
returns table (
  id uuid,
  title text,
  content text,
  similarity float
)
language sql
stable
as $$
  select
    global_knowledge.id,
    global_knowledge.title,
    global_knowledge.content,
    1 - (global_knowledge.embedding <=> query_embedding) as similarity
  from global_knowledge
  where 1 - (global_knowledge.embedding <=> query_embedding) > match_threshold
  order by similarity desc
  limit match_count;
$$;
