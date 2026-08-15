-- =====================================================================
-- International Student Budget Tracker — Schema
-- Supabase / PostgreSQL migration 0001
--
-- Tables: profiles, categories, payment_methods, transactions, exchange_rates
-- RLS:    enabled on every user-data table (user_id = auth.uid())
-- Trigger: auto-create a profile row + seed defaults on new auth user
-- =====================================================================

-- ---------- profiles ----------
create table if not exists public.profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  study_country   text,
  local_currency  text,
  home_currency   text,
  display_currency text,
  monthly_budget  numeric(14,2),
  onboarded       boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ---------- categories ----------
create table if not exists public.categories (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  type        text not null check (type in ('expense','income')),
  is_default  boolean not null default false,
  sort_order  int  not null default 0,
  created_at  timestamptz not null default now(),
  unique (user_id, name, type)
);

-- ---------- payment_methods ----------
create table if not exists public.payment_methods (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  is_default  boolean not null default false,
  sort_order  int  not null default 0,
  created_at  timestamptz not null default now(),
  unique (user_id, name)
);

-- ---------- transactions ----------
create table if not exists public.transactions (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  transaction_type   text not null check (transaction_type in ('expense','income')),
  amount             numeric(18,2) not null check (amount >= 0),
  currency           text not null,
  converted_amount   numeric(18,2),
  converted_currency text,
  exchange_rate      numeric(18,8),
  transaction_date   date not null,
  category_id        uuid references public.categories(id) on delete set null,
  title              text not null,
  description        text,
  payment_method_id  uuid references public.payment_methods(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists transactions_user_date_idx
  on public.transactions(user_id, transaction_date desc);
create index if not exists transactions_user_category_idx
  on public.transactions(user_id, category_id);
create index if not exists transactions_user_type_idx
  on public.transactions(user_id, transaction_type);

-- ---------- updated_at trigger helper ----------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_updated_at on public.profiles;
create trigger profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

drop trigger if exists transactions_updated_at on public.transactions;
create trigger transactions_updated_at
  before update on public.transactions
  for each row execute function public.set_updated_at();
