-- Tabwise: email sign-in codes, sessions and server-side usage limits.
-- Run once in the Supabase SQL editor before deploying the new Worker.

-- Lemon Squeezy keeps a cancelled subscription usable until ends_at.
alter table public.subscriptions add column if not exists ends_at timestamptz;

-- Normalise existing emails so lookups match the Worker's lower-cased input.
update public.subscriptions set email = lower(trim(email)) where email <> lower(trim(email));

create table if not exists public.login_codes (
  id          bigint generated always as identity primary key,
  email       text not null,
  code_hash   text not null,
  attempts    int not null default 0,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists login_codes_email_created_idx on public.login_codes (email, created_at desc);

create table if not exists public.sessions (
  token_hash  text primary key,
  email       text not null,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);
create index if not exists sessions_email_idx on public.sessions (email);

create table if not exists public.usage_counters (
  key    text not null,
  day    date not null,
  count  int not null default 0,
  primary key (key, day)
);

-- Atomic "increment and return" so parallel requests can't bypass the limit.
create or replace function public.increment_usage(p_key text, p_day date)
returns int
language sql
security definer
set search_path = public
as $$
  insert into public.usage_counters (key, day, count)
  values (p_key, p_day, 1)
  on conflict (key, day) do update set count = public.usage_counters.count + 1
  returning count;
$$;

-- Only the Worker (service_role) may touch these. RLS on, no public policies.
alter table public.subscriptions  enable row level security;
alter table public.login_codes    enable row level security;
alter table public.sessions       enable row level security;
alter table public.usage_counters enable row level security;

revoke all on function public.increment_usage(text, date) from public, anon, authenticated;
grant execute on function public.increment_usage(text, date) to service_role;

-- Optional housekeeping (run periodically or via pg_cron):
-- delete from public.login_codes where created_at < now() - interval '1 day';
-- delete from public.sessions where expires_at < now();
-- delete from public.usage_counters where day < current_date - 30;
