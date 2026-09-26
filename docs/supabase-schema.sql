-- Subscriptions table used by backend/ (reconstructed from the queries in backend/src/index.js).
-- The Worker upserts on email with "Prefer: resolution=merge-duplicates", so email must be unique.
create table if not exists public.subscriptions (
  email                         text primary key,
  plan                          text not null default 'FREE',   -- 'FREE' | 'PRO'
  status                        text,                           -- Lemon Squeezy subscription status, e.g. 'active'
  lemonsqueezy_subscription_id  text,
  updated_at                    timestamptz not null default now()
);

-- Only the Worker (service role) touches this table; keep RLS on with no public policies.
alter table public.subscriptions enable row level security;
