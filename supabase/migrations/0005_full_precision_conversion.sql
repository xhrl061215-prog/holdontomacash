-- =====================================================================
-- Phase 2 fix: converted_amount must hold FULL precision.
--
-- The column was numeric(18,2), which silently rounded every converted value
-- to 2 decimals on write. That breaks the stated rule — full precision in
-- storage, rounding at display only — in two ways:
--
--   1. Zero-decimal currencies (KRW, JPY) and high-precision rates lose real
--      information at the moment of writing.
--   2. Rounding each row before summing accumulates error across a month's
--      totals, so Overview's figures would drift from the true sum.
--
-- numeric with no specified scale keeps whatever precision the value has.
-- `amount` stays numeric(18,2): it is a user-entered figure in a real currency,
-- and 2 decimals is correct for every currency we accept.
-- =====================================================================

alter table public.transactions
  alter column converted_amount type numeric;

-- Rates need more precision than money — a JPY->GBP rate is ~0.00465, and
-- 8 decimals is not enough headroom for very weak currency pairs
-- (e.g. VND->GBP is ~0.000028).
alter table public.transactions
  alter column exchange_rate type numeric;
