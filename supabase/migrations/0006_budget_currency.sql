-- =====================================================================
-- Phase 3 fix: the monthly budget needs its own currency.
--
-- `monthly_budget` was a bare number with no currency recorded. A student in
-- London types 1500 meaning GBP 1,500; Overview compared it against totals
-- denominated in the HOME currency (KRW), producing arithmetically correct
-- nonsense — "1,600,183 KRW over your 1,500 KRW budget (106778.9% of it)".
--
-- The budget is denominated in the LOCAL spending currency: that is what a
-- student thinks in when they set it. It is snapshotted at write time for the
-- same reason as transactions.converted_currency — changing local_currency
-- later must not silently re-denominate an existing budget.
-- =====================================================================

alter table public.profiles
  add column if not exists budget_currency text;

-- Backfill existing rows with the local currency, which is the intended basis.
-- Rows with a budget but no local currency are left null and treated as
-- "unknown basis" by the application rather than guessed at.
update public.profiles
   set budget_currency = local_currency
 where budget_currency is null
   and monthly_budget is not null
   and local_currency is not null;
