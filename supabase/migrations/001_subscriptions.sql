-- Whiparound: one row per account with its Stripe subscription state.
-- Run this once in Supabase → SQL Editor (or with the Supabase CLI).

create table if not exists public.subscriptions (
  user_id                uuid primary key references auth.users (id) on delete cascade,
  stripe_customer_id     text unique,
  stripe_subscription_id text unique,
  status                 text,          -- trialing | active | past_due | canceled | unpaid | incomplete | paused ...
  price_id               text,
  interval               text,          -- month | year
  trial_end              timestamptz,
  current_period_end     timestamptz,
  cancel_at_period_end   boolean not null default false,
  had_trial              boolean not null default false,  -- one free trial per account
  updated_at             timestamptz not null default now()
);

alter table public.subscriptions enable row level security;

-- People can read their own row. Nobody can write from the browser: only the server,
-- using the secret key (which bypasses row level security), changes subscriptions.
drop policy if exists "Read own subscription" on public.subscriptions;
create policy "Read own subscription"
  on public.subscriptions for select
  to authenticated
  using ((select auth.uid()) = user_id);

revoke insert, update, delete on public.subscriptions from anon, authenticated;
