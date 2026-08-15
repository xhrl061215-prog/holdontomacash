-- =====================================================================
-- Correct the seeded categories and payment methods to the brief's lists.
--
-- The original seed substituted plausible equivalents and invented entries
-- while dropping requested ones. Requirements, not suggestions:
--
--   Expense: Subscription was missing; Utilities was invented. Several names
--            were paraphrased (Food/Eating Out, Education/Academic).
--   Income:  Salary and Refund were missing. Refund matters structurally —
--            a refund is recorded as income, so the rule had nowhere to land.
--   Payment: Global / Travel Card and Other were missing; Mobile Payment was
--            invented. The target user "uses Wise/Revolut/global travel cards".
--
-- This migration:
--   1. Replaces the signup trigger so NEW users get the brief's lists.
--   2. Backfills EXISTING users with the missing entries.
--   3. Deletes nothing that has transactions against it — an invented category
--      a user has already filed spending under is now their data, not our
--      mistake to erase. Unused invented defaults are removed.
-- =====================================================================

-- ---------- 1. new users ----------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, onboarded)
  values (new.id, false)
  on conflict (id) do nothing;

  -- Expense categories, in the brief's order.
  insert into public.categories (user_id, name, type, is_default, sort_order)
  select new.id, name, 'expense', true, sort_order
  from (values
    ('Groceries', 1), ('Eating Out', 2), ('Academic', 3),
    ('Entertainment / Nightlife', 4), ('Transport', 5), ('Phone / Internet', 6),
    ('Housing / Living', 7), ('Shopping', 8), ('Health', 9), ('Travel', 10),
    ('Subscription', 11), ('Other', 12)
  ) as v(name, sort_order)
  on conflict (user_id, name, type) do nothing;

  -- Income categories, in the brief's order.
  insert into public.categories (user_id, name, type, is_default, sort_order)
  select new.id, name, 'income', true, sort_order
  from (values
    ('Allowance', 1), ('Salary', 2), ('Scholarship', 3), ('Refund', 4), ('Other', 5)
  ) as v(name, sort_order)
  on conflict (user_id, name, type) do nothing;

  -- Payment methods, in the brief's order.
  insert into public.payment_methods (user_id, name, is_default, sort_order)
  select new.id, name, is_default, sort_order
  from (values
    ('Debit Card', true, 1), ('Credit Card', false, 2),
    ('Global / Travel Card', false, 3), ('Cash', false, 4),
    ('Bank Transfer', false, 5), ('Other', false, 6)
  ) as v(name, is_default, sort_order)
  on conflict (user_id, name) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- 2. backfill existing users ----------
-- Every existing profile gets any of the brief's entries it is missing.
insert into public.categories (user_id, name, type, is_default, sort_order)
select p.id, v.name, 'expense', true, v.sort_order
from public.profiles p
cross join (values
  ('Groceries', 1), ('Eating Out', 2), ('Academic', 3),
  ('Entertainment / Nightlife', 4), ('Transport', 5), ('Phone / Internet', 6),
  ('Housing / Living', 7), ('Shopping', 8), ('Health', 9), ('Travel', 10),
  ('Subscription', 11), ('Other', 12)
) as v(name, sort_order)
on conflict (user_id, name, type) do nothing;

insert into public.categories (user_id, name, type, is_default, sort_order)
select p.id, v.name, 'income', true, v.sort_order
from public.profiles p
cross join (values
  ('Allowance', 1), ('Salary', 2), ('Scholarship', 3), ('Refund', 4), ('Other', 5)
) as v(name, sort_order)
on conflict (user_id, name, type) do nothing;

insert into public.payment_methods (user_id, name, is_default, sort_order)
select p.id, v.name, v.is_default, v.sort_order
from public.profiles p
cross join (values
  ('Debit Card', true, 1), ('Credit Card', false, 2),
  ('Global / Travel Card', false, 3), ('Cash', false, 4),
  ('Bank Transfer', false, 5), ('Other', false, 6)
) as v(name, is_default, sort_order)
on conflict (user_id, name) do nothing;

-- ---------- 3. remove UNUSED invented defaults only ----------
-- Anything a user has already filed a transaction against is their data now.
-- Only untouched, invented, still-default rows are removed.
delete from public.categories c
 where c.is_default = true
   and c.name in ('Food', 'Utilities', 'Education', 'Entertainment', 'Housing',
                  'Phone & Internet', 'Part-time Job')
   and not exists (
     select 1 from public.transactions t where t.category_id = c.id
   );

delete from public.payment_methods pm
 where pm.is_default = true
   and pm.name in ('Mobile Payment')
   and not exists (
     select 1 from public.transactions t where t.payment_method_id = pm.id
   );

-- ---------- 4. exactly one default payment method per user ----------
-- The original seed marked EVERY payment method is_default, which left existing
-- users with several "defaults" — the Add page then picks arbitrarily. Normalise
-- to exactly one: Debit Card, which leads the brief's list.
update public.payment_methods set is_default = false where is_default = true;

update public.payment_methods
   set is_default = true
 where name = 'Debit Card';

-- Any user without a Debit Card row (only possible if they deleted it) falls
-- back to their lowest-sorted method, so nobody is left with no default.
update public.payment_methods pm
   set is_default = true
 where pm.id in (
   select distinct on (user_id) id
     from public.payment_methods
    where user_id in (
      select user_id from public.payment_methods
      group by user_id
      having count(*) filter (where is_default) = 0
    )
    order by user_id, sort_order, name
 );
