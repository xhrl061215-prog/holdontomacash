-- =====================================================================
-- Overview aggregation as a Postgres function, for the hosted deployment.
--
-- The preview backend computes this in server/overview.mjs. Hosted Supabase has
-- no application server, so the same aggregation runs here, called via RPC.
--
-- Ported deliberately, preserving the properties the tests pin down:
--   * every sum is numeric in SQL — never JS float, never a capped page
--   * month bucketing compares date strings, never constructs a timestamp
--   * converted_amount IS NULL rows are EXCLUDED from totals and counted
--     separately; treating them as 0 would make a total quietly wrong
--   * the budget is converted from its own currency before comparison, and the
--     comparison is SUPPRESSED (null) when no rate is available
--
-- SECURITY INVOKER, so RLS applies to the caller: this function cannot read
-- another user's rows even if called with a forged argument.
-- =====================================================================

create or replace function public.overview_for_month(p_month text)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_month_start date;
  v_month_end   date;      -- exclusive
  v_day int;
  v_prior_month text;
  v_prior_start date;
  v_prior_end   date;      -- inclusive bound for the equal period
  v_current_through date;
  v_clamped boolean := false;

  v_expense numeric := 0;
  v_income  numeric := 0;
  v_prior_expense numeric := 0;
  v_prior_income  numeric := 0;

  v_pending int := 0;
  v_approximate int := 0;

  v_home text;
  v_budget_raw numeric;
  v_budget_currency text;
  v_budget_converted numeric;
  v_budget_was_converted boolean := false;
  v_budget_basis_unknown boolean := false;
  v_rate numeric;

  v_categories jsonb := '[]'::jsonb;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  if p_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'invalid month: %', p_month;
  end if;

  v_month_start := (p_month || '-01')::date;
  v_month_end   := (v_month_start + interval '1 month')::date;

  -- Equal-period comparison: 1..today of this month vs 1..the same day of the
  -- prior month, clamped when the prior month is shorter.
  v_day := least(
    extract(day from current_date)::int,
    extract(day from (v_month_end - interval '1 day'))::int
  );
  if p_month <> to_char(current_date, 'YYYY-MM') then
    -- A past month is complete: compare the whole month.
    v_day := extract(day from (v_month_end - interval '1 day'))::int;
  end if;
  v_current_through := v_month_start + (v_day - 1);

  v_prior_month := to_char(v_month_start - interval '1 month', 'YYYY-MM');
  v_prior_start := (v_prior_month || '-01')::date;
  if v_day > extract(day from ((v_prior_start + interval '1 month') - interval '1 day'))::int then
    v_clamped := true;
    v_prior_end := (v_prior_start + interval '1 month') - interval '1 day';
  else
    v_prior_end := v_prior_start + (v_day - 1);
  end if;

  -- ---- current window totals (NULL conversions excluded) ----
  select
    coalesce(sum(converted_amount) filter (where transaction_type = 'expense'), 0),
    coalesce(sum(converted_amount) filter (where transaction_type = 'income'), 0)
  into v_expense, v_income
  from public.transactions
  where transaction_date >= v_month_start
    and transaction_date < v_month_end
    and converted_amount is not null;

  select
    count(*) filter (where converted_amount is null),
    count(*) filter (where rate_is_approximate)
  into v_pending, v_approximate
  from public.transactions
  where transaction_date >= v_month_start
    and transaction_date < v_month_end;

  -- ---- equal-period prior window ----
  select
    coalesce(sum(converted_amount) filter (where transaction_type = 'expense'), 0),
    coalesce(sum(converted_amount) filter (where transaction_type = 'income'), 0)
  into v_prior_expense, v_prior_income
  from public.transactions
  where transaction_date >= v_prior_start
    and transaction_date <= v_prior_end
    and converted_amount is not null;

  -- ---- category breakdown ----
  select coalesce(jsonb_agg(row_to_json(x)::jsonb order by x.total desc), '[]'::jsonb)
  into v_categories
  from (
    select
      t.category_id,
      coalesce(c.name, 'Uncategorised') as category_name,
      sum(t.converted_amount)::text as total,
      count(*)::int as tx_count
    from public.transactions t
    left join public.categories c on c.id = t.category_id
    where t.transaction_date >= v_month_start
      and t.transaction_date < v_month_end
      and t.transaction_type = 'expense'
      and t.converted_amount is not null
    group by t.category_id, c.name
  ) x;

  -- ---- budget, converted from its own currency ----
  select home_currency, monthly_budget, budget_currency
    into v_home, v_budget_raw, v_budget_currency
  from public.profiles where id = v_uid;

  if v_budget_raw is not null then
    v_budget_currency := coalesce(v_budget_currency, v_home);
    if v_budget_currency = v_home then
      v_budget_converted := v_budget_raw;
    else
      -- Freshest rate for the pair, taken from the user's own converted rows.
      -- There is no exchange_rates table: rates are stored per transaction with
      -- their provenance (0004_rate_provenance). Using a rate the user's own
      -- data already demonstrates keeps the budget comparison consistent with
      -- the totals it is compared against.
      select t.exchange_rate into v_rate
      from public.transactions t
      where t.currency = v_budget_currency
        and t.converted_currency = v_home
        and t.exchange_rate is not null
      order by t.rate_date desc nulls last, t.created_at desc
      limit 1;

      if v_rate is null then
        v_budget_converted := null;
        v_budget_basis_unknown := true;
      else
        v_budget_converted := v_budget_raw * v_rate;
        v_budget_was_converted := true;
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'month', p_month,
    'totals', jsonb_build_object(
      'expense', v_expense::text,
      'income',  v_income::text,
      'net',     (v_income - v_expense)::text,
      'monthly_budget', case when v_budget_converted is null
                             then null else v_budget_converted::text end,
      'budget_original', case when v_budget_raw is null
                              then null else v_budget_raw::text end,
      'budget_currency', v_budget_currency,
      'budget_converted', v_budget_was_converted,
      'budget_basis_unknown', v_budget_basis_unknown,
      'budget_remaining', case when v_budget_converted is null
                               then null else (v_budget_converted - v_expense)::text end,
      'display_currency', v_home
    ),
    'categories', v_categories,
    'comparison', jsonb_build_object(
      'prior_month', v_prior_month,
      'current_through_day', v_day,
      'prior_through_day', extract(day from v_prior_end)::int,
      'clamped', v_clamped,
      'prior_expense', v_prior_expense::text,
      'prior_income',  v_prior_income::text,
      'comparable', (v_prior_expense > 0 or v_prior_income > 0)
    ),
    'flags', jsonb_build_object(
      'pending_count', v_pending,
      'approximate_count', v_approximate
    )
  );
end;
$$;

comment on function public.overview_for_month(text) is
  'Monthly overview aggregation. SECURITY INVOKER so RLS restricts rows to the '
  'caller. All arithmetic is SQL numeric; NULL conversions are excluded from '
  'totals and reported via flags.pending_count.';

revoke all on function public.overview_for_month(text) from public;

-- Supabase always has the `authenticated` role. Guard the grant so this
-- migration also applies to a plain Postgres (local dev, CI, the preview
-- backend) instead of aborting on a missing role.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.overview_for_month(text) to authenticated';
  end if;
end $$;
