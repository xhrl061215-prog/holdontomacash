-- =====================================================================
-- Phase 2: rate provenance on transactions
--
-- converted_amount / converted_currency / exchange_rate already exist
-- (reserved in 0001). This adds the columns needed to be honest about
-- WHICH rate was used and how much to trust it.
-- =====================================================================

alter table public.transactions
  -- The publication date of the rate actually used. ECB publishes on weekdays
  -- only, so a Saturday transaction resolves to Friday's rate; recording it
  -- makes that auditable rather than invisible.
  add column if not exists rate_date date,
  -- 'frankfurter' | 'er-api' | 'identity' (same-currency), null while pending.
  add column if not exists rate_source text,
  -- True when a CURRENT rate was applied to a PAST date because the historical
  -- rate was unavailable. Such rows are labelled approximate in the UI.
  add column if not exists rate_is_approximate boolean not null default false;

-- Finding rows that still need backfilling must stay cheap as the table grows.
create index if not exists transactions_pending_rate_idx
  on public.transactions(user_id)
  where converted_amount is null;

-- Filter/sort support for the Transactions page.
create index if not exists transactions_user_currency_idx
  on public.transactions(user_id, currency);

-- Case-insensitive text search across title + description.
create index if not exists transactions_search_idx
  on public.transactions
  using gin (to_tsvector('simple', title || ' ' || coalesce(description, '')));
