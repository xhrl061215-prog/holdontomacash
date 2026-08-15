-- =====================================================================
-- Auto-create profile + seed default categories & payment methods
-- on new auth user signup.
--
-- Runs server-side via a trigger on auth.users — works even when email
-- confirmation is enabled (fires on confirmed signup).
-- =====================================================================

-- Default categories seed array
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  -- 1. Create profile row
  insert into public.profiles (id, onboarded)
  values (new.id, false)
  on conflict (id) do nothing;

  -- 2. Seed default expense categories
  insert into public.categories (user_id, name, type, is_default, sort_order)
  select
    new.id, name, 'expense', true, sort_order
  from (values
    ('Food', 1), ('Groceries', 2), ('Transport', 3), ('Housing', 4),
    ('Utilities', 5), ('Phone & Internet', 6), ('Shopping', 7),
    ('Entertainment', 8), ('Health', 9), ('Education', 10),
    ('Travel', 11), ('Other', 12)
  ) as v(name, sort_order)
  on conflict (user_id, name, type) do nothing;

  -- 3. Seed default income categories
  insert into public.categories (user_id, name, type, is_default, sort_order)
  select
    new.id, name, 'income', true, sort_order
  from (values
    ('Allowance', 1), ('Part-time Job', 2), ('Scholarship', 3), ('Other', 4)
  ) as v(name, sort_order)
  on conflict (user_id, name, type) do nothing;

  -- 4. Seed default payment methods
  insert into public.payment_methods (user_id, name, is_default, sort_order)
  select
    new.id, name, true, sort_order
  from (values
    ('Cash', 1), ('Debit Card', 2), ('Credit Card', 3),
    ('Bank Transfer', 4), ('Mobile Payment', 5)
  ) as v(name, sort_order)
  on conflict (user_id, name) do nothing;

  return new;
end;
$$;

-- Drop + recreate the trigger
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
