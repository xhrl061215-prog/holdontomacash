-- =====================================================================
-- RLS policies — every user-data table enforces user_id = auth.uid()
-- =====================================================================

-- profiles: a user can only see/update their own profile row (id = auth.uid())
alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles for select
  using (auth.uid() = id);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
  on public.profiles for insert
  with check (auth.uid() = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- categories
alter table public.categories enable row level security;

drop policy if exists "categories_select_own" on public.categories;
create policy "categories_select_own"
  on public.categories for select
  using (auth.uid() = user_id);

drop policy if exists "categories_insert_own" on public.categories;
create policy "categories_insert_own"
  on public.categories for insert
  with check (auth.uid() = user_id);

drop policy if exists "categories_update_own" on public.categories;
create policy "categories_update_own"
  on public.categories for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "categories_delete_own" on public.categories;
create policy "categories_delete_own"
  on public.categories for delete
  using (auth.uid() = user_id);

-- payment_methods
alter table public.payment_methods enable row level security;

drop policy if exists "payment_methods_select_own" on public.payment_methods;
create policy "payment_methods_select_own"
  on public.payment_methods for select
  using (auth.uid() = user_id);

drop policy if exists "payment_methods_insert_own" on public.payment_methods;
create policy "payment_methods_insert_own"
  on public.payment_methods for insert
  with check (auth.uid() = user_id);

drop policy if exists "payment_methods_update_own" on public.payment_methods;
create policy "payment_methods_update_own"
  on public.payment_methods for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "payment_methods_delete_own" on public.payment_methods;
create policy "payment_methods_delete_own"
  on public.payment_methods for delete
  using (auth.uid() = user_id);

-- transactions
alter table public.transactions enable row level security;

drop policy if exists "transactions_select_own" on public.transactions;
create policy "transactions_select_own"
  on public.transactions for select
  using (auth.uid() = user_id);

drop policy if exists "transactions_insert_own" on public.transactions;
create policy "transactions_insert_own"
  on public.transactions for insert
  with check (auth.uid() = user_id);

drop policy if exists "transactions_update_own" on public.transactions;
create policy "transactions_update_own"
  on public.transactions for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "transactions_delete_own" on public.transactions;
create policy "transactions_delete_own"
  on public.transactions for delete
  using (auth.uid() = user_id);

-- Every table above is deny-by-default: RLS is enabled and no policy grants
-- access to another user's rows, so a leaked or malicious client cannot read
-- or write across users even though it holds a valid anon key.
