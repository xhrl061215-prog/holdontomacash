# BudgetTracker

Multi-currency budget tracker for international students — the spreadsheet you
wish you had when you moved abroad, except it does the annoying work
automatically.

All three phases are complete: Add, Transactions and Overview are functional,
with real authentication, per-user data isolation, live currency conversion and
232 passing tests.

**Phase 1:** project setup, database, email authentication, user data
isolation, first-time onboarding, main navigation, the Add Transaction page,
and transaction persistence.

**Phase 2:** currency conversion, backfill of pending conversions, the
Transactions page (dense table, combinable filters, search, sort, edit, delete),
and a display-currency switcher.

**Phase 3:** Overview (four headline numbers, category donut, equal-period
month-over-month, Budget Consultant) and PWA installability.

Stack: React 19 + TypeScript + Vite 8 + Tailwind CSS v4.

## Quick start

```bash
npm install
npm run dev:all     # starts the API (:8787) and the web app (:5173)
```

Open http://localhost:5173 and sign up. No external accounts or configuration
needed — the database initialises itself on first run.

To run the two processes separately:

```bash
npm run dev:api     # backend on :8787
npm run dev         # frontend on :5173
```

## Architecture

```
Browser ──> Vite (:5173) ──/api-proxy──> Express API (:8787) ──> Postgres (PGlite)
                                                                  │
                                              supabase/migrations/ applied at boot
```

- `src/lib/supabaseClient.ts` is a **backend adapter**. It exposes the small
  slice of the Supabase client surface the pages use, so switching to hosted
  Supabase means replacing this one file — not rewriting the pages.
- `server/index.mjs` runs **real Postgres** (PGlite/WASM) and applies the exact
  migrations in `supabase/migrations/`, including the RLS policies.
- Every request sets `request.jwt.claim.sub` and runs as the `authenticated`
  role, so **Postgres RLS decides access**, not application code. This is the
  same enforcement model as hosted Supabase.

### Why not hosted Supabase?

Creating a Supabase project requires an account with email verification, which
could not be completed from the build environment. Rather than ship a preview
that cannot be used, the same schema and the same RLS policies run locally
against real Postgres. The security model under test is genuine; only the
hosting differs.

To move to hosted Supabase: create the project, run the three migration files
in the SQL Editor in order, install `@supabase/supabase-js`, and replace
`src/lib/supabaseClient.ts` with a real `createClient(...)`. The pages need no
changes.

## Database

| Table | Contents |
|---|---|
| `profiles` | One row per user — study country, local + home currency, optional monthly budget, `onboarded` flag |
| `categories` | Per-user expense/income categories, seeded on signup |
| `payment_methods` | Per-user payment methods, seeded on signup |
| `transactions` | The ledger — amount, currency, date, category, title, description, payment method |

Migrations in `supabase/migrations/`, applied in order:

| File | Purpose |
|---|---|
| `0001_schema.sql` | Tables, constraints, indexes, `updated_at` triggers |
| `0002_rls.sql` | Row Level Security policies |
| `0003_handle_new_user.sql` | Creates the profile and seeds 16 categories + 5 payment methods on signup |
| `0004_rate_provenance.sql` | `rate_date`, `rate_source`, `rate_is_approximate`; filter/search indexes |
| `0005_full_precision_conversion.sql` | Widens `converted_amount`/`exchange_rate` to unscaled `numeric` |
| `0006_budget_currency.sql` | Adds `profiles.budget_currency`, snapshotting the budget's basis |
| `0007_seed_brief_lists.sql` | Corrects seeded categories/payment methods to the brief's lists; backfills existing users |

Migrations are tracked in `schema_migrations` and applied idempotently on boot,
so an existing database picks up new ones on restart.

## Security model

- **Authentication** — email + password. Passwords are salted and hashed with
  scrypt. Sessions are opaque random tokens.
- **Isolation** — RLS is enabled on all four tables. Every policy is
  `auth.uid() = user_id` (`auth.uid() = id` for `profiles`), written per
  operation. No policy grants cross-user access, so the default is deny.
- **Write protection** — insert and update policies use `WITH CHECK`, so a
  client cannot create a row under another user's id or move one across users.
- **Ownership is enforced in the database**, not the browser. A tampered client
  cannot forge `user_id`.
- **Cascade** — deleting a user removes their rows.

Session tokens are held in memory, so a server restart requires signing in
again. Data itself persists to disk in `.data/` (gitignored).

## Dates

`transaction_date` is a Postgres `DATE` — a calendar day, with no time and no
timezone — and the API returns it as a bare `YYYY-MM-DD` string.

This matters for correctness, not tidiness. A driver that parses `DATE` into a
JS `Date` serialises it to `2026-09-01T00:00:00.000Z`; a client anywhere west of
UTC reading that back gets **31 August**, so a 1st-of-month transaction lands in
the previous month's bucket. Month totals and month-over-month comparisons would
be quietly wrong for users outside UTC.

Two rules keep this safe:

- The server pins `DATE` to a string parser (`DATE_AS_STRING` in
  `server/index.mjs`). Timestamp columns such as `created_at` keep normal
  `Date` parsing, since those are genuine instants.
- Client code builds today's date from local parts (`src/lib/date.ts`) and
  buckets months by string slice (`date.slice(0, 7)`) — never via `new Date()`.

`src/__tests__/date-handling.test.ts` guards the contract, including the
month- and year-boundary cases.

## Currency conversion

Every transaction stores what was entered **and** what it converts to, so the
original figure is never lost or overwritten:

| Column | Meaning |
|---|---|
| `amount`, `currency` | Exactly what the user typed |
| `exchange_rate` | Rate used, full precision |
| `converted_amount` | `amount x rate`, full precision |
| `converted_currency` | Home currency **snapshotted at write time** |
| `rate_date` | Publication date of the rate actually used |
| `rate_source` | `frankfurter`, `er-api`, or `identity` |
| `rate_is_approximate` | True when a current rate stood in for a historical one |

`converted_currency` is snapshotted deliberately. Deriving it at read time would
silently re-denominate every historical row the moment someone changed their
home currency.

**Rate sources.** Frankfurter (ECB data, ~30 currencies, full history) is
authoritative. `open.er-api.com` (160+ currencies, current rates only) covers
pairs Frankfurter does not quote — VND, for instance — and stands in when
Frankfurter is unreachable.

**Same-currency transactions never call an API**: rate 1, converted equals
amount.

**The rate for the transaction date is used, not today's.** A receipt entered a
week late converts at that week's rate.

### Decision: weekend and holiday dates

The ECB publishes on TARGET weekdays only, so no rate exists for a Saturday,
Sunday or holiday. **A non-publication date resolves to the nearest prior
publication** — a Sunday transaction uses Friday's rate.

Frankfurter already behaves this way and reports the date it actually used, so
this project adopts that rather than inventing a second rule, and persists the
answer in `rate_date`. Every row therefore records which day's rate produced its
figure, and the outcome is deterministic and auditable rather than implicit.

Future-dated transactions use the latest known rate; there is nothing else to
use.

### Decision: backfill runs on read

A rate failure never blocks a save. The row is written with
`exchange_rate` and `converted_amount` null, displays as *rate pending*, and is
repaired later.

**Backfill runs when the Transactions page loads**, capped at 25 rows per
attempt and once per page mount, rather than on a background sweep. Reasons:

- This is a single-process app with no job runner. A "background sweep" would
  really be a timer in the web process — more moving parts, no more reliability.
- A pending value matters to the user exactly when they are looking at it.
- It self-limits: idle accounts do no work, and the cap stops one page load
  stalling behind a long provider outage.
- Editing a pending row also retries its conversion, so the common case fixes
  itself.

A row whose currency no provider quotes stays pending indefinitely rather than
being given a plausible-looking wrong number.

### Precision and rounding

`converted_amount` and `exchange_rate` are `numeric` with **no fixed scale** —
full precision in storage. Rounding happens only at display, using banker's
rounding (half to even), which avoids the upward bias half-up introduces when
totalling many rows.

Currency decimals are respected: KRW, JPY, VND, IDR, CLP, ISK and HUF display
with 0 decimals (`27,431`, never `27,431.00`); everything else uses 2.

### No JS arithmetic on the money path

**`converted_amount` is computed by Postgres, never in JavaScript.** The server
resolves a rate, renders it as an exact decimal string, and the INSERT computes
`amount * exchange_rate` in `numeric`.

This is not stylistic. `20.00 * 1910.38` in binary floating point is
`38207.600000000006`, and since `converted_amount` is unscaled `numeric`,
Postgres faithfully stores that error. Only values whose products are not
binary-representable show it, so the defect is intermittent — which is exactly
what makes it dangerous. Overview sums this column, and per-row dust compounds
into monthly totals that do not reconcile.

Two bugs interacted here, and the order matters:

1. `converted_amount` was originally `numeric(18,2)`, silently rounding every
   conversion on write.
2. The multiply happened in JS float.

Fixing (1) alone **exposed** (2): the narrow column had been rounding the float
error away, so widening it to full precision made previously hidden dust
visible. `0005_full_precision_conversion.sql` fixes the column;
`server/currency.mjs` + the SQL expressions fix the arithmetic. Both are needed.

Float **is** used to round for display, which is safe: rounding a stored decimal
to 2 places only needs precision far coarser than a double provides. The rule is
narrower than "never use floats" — never *compute* money with them.

Assertions about money in the test suite use `src/lib/decimal.ts` (BigInt-backed
exact decimal arithmetic). Checking `converted == amount * rate` with JS numbers
is tautological when the server also used floats: both sides carry identical
error, agree, and pass while the stored value is wrong.

### One canonical amount

`amount` is `numeric(18,2)`, so Postgres rounds on write. If conversion then
multiplies the *raw submitted* value, the stored row contradicts itself:

```
submitted 2.675  ->  amount stored 2.68  (rounded)
                     converted_amount = 2.675 x rate
                     but 2.68 x rate is ~9 KRW different
```

`converted / rate` would return `2.675`, leaking a basis the row does not
otherwise record. One canonical amount must feed both storage and conversion.

**Amounts with more decimals than the currency supports are rejected with 400**
rather than silently normalised — quietly altering a figure someone typed is
worse than telling them. The limit is per-currency, so `0.5 KRW` is refused
because KRW has no minor unit. Zero is refused too: it is not a transaction, and
an input below the currency's precision (`0.001`) previously stored `0.00`
alongside a non-zero converted value.

`src/lib/money.ts` exports `validateAmount`, which mirrors the server rules
exactly (including check order) so the user gets inline feedback rather than a
round-trip error.

### Testing method: diff against the source document

A distinct failure mode from all of the above: **code correct, tests green,
requirements quietly substituted.** The seeded categories and payment methods
had drifted from the brief — plausible-sounding equivalents (`Food` for
`Eating Out`, `Education` for `Academic`), inventions (`Utilities`,
`Mobile Payment`), and outright omissions (`Subscription`, `Salary`, `Refund`,
`Global / Travel Card`).

Two of those were real losses, not cosmetic:

- **`Refund`** — the financial rules state a refund is recorded as income. With
  no Refund category, that rule had nowhere to land.
- **`Global / Travel Card`** — the target user "uses Wise/Revolut/global travel
  cards", and multi-currency spending is the product's differentiator.

Nothing about behaviour was wrong, so no behavioural test could find it. Four
rounds of review verified arithmetic and missed it entirely. The only thing that
catches this is diffing the app's content against the requirements document.

`src/__tests__/requirements-conformance.test.ts` transcribes the brief's lists
verbatim and asserts the seeded content equals them, in order, with each entry
named individually so a failure reports *which* requirement was dropped. It also
asserts nothing was invented, and that the structural cases actually work
(a refund recorded as income; a subscription charged to a travel card).

A related trap in the old e2e script: it asserted `categories.length === 16`. A
count passes while every name is wrong. Content assertions replaced it.

### Testing method: read the rendered output

A fourth failure class, distinct from the three below: **every layer correct and
the product still wrong, because the unit was wrong.** The budget-currency defect
had exact arithmetic, reachable inputs, and guards that failed when broken — and
displayed `965132.4% of your budget`. No internal-consistency check can catch
that.

The complement is asserting on what a user actually sees.
`src/__tests__/rendered-output.test.tsx` renders the real pages and checks that
every money figure carries a currency, that the entered budget is recognisable
on screen, that no percentage has four or more digits (a unit error, not a
spending habit), and that `NaN`, `Infinity`, `undefined` and `null` never reach
the DOM. Reintroducing the defect fails 3 of those tests.

### Testing method: adversarial inputs

Three defects in this area shared one shape — the assertion looked correct but
could not reach the broken path:

| Defect | Why the test missed it |
|---|---|
| Date returned as a timestamp | Correct in storage, wrong at serialisation |
| Float multiply | Both sides of the assertion carried the same error |
| Basis mismatch | Every test input was already <=2dp, where stored == submitted |

Reverting a fix to watch its guard fail catches the second kind. It cannot catch
the third, because the guard genuinely does fail when its code breaks — the
inputs simply never reach the defect. The complement is asking **what input would
have to arrive for this to break, and whether any test sends it.**

`src/__tests__/adversarial-input.test.ts` does that: excess decimals,
zero-decimal currencies given decimals, zero in every spelling (`0`, `00`,
`0.00`), malformed and non-string values, overflow, the smallest and largest
valid amounts, and edits re-validated on the same rules. Its central assertion is
that every stored row is **internally consistent** —
`converted_amount == amount * exchange_rate` using the row's own stored values —
which is the invariant the basis mismatch violated.

## Transactions page

Columns: Date, Title, Category, Details, Payment Method, Original Amount,
Currency, Rate, Home Value.

- A real HTML `<table>` at every width — dense, zebra-striped, never cards.
  Narrow screens scroll horizontally and a row can be tapped to expand its
  details.
- The original amount and currency are always visible. The converted value sits
  in its own column and never replaces them.
- Filters — month, category, payment method, currency, expense/income, plus text
  search across title and description — all combine, with one reset control.
- Filtering, search, sorting and paging happen **in SQL**, so the page does not
  degrade at a few thousand rows.
- Editing amount, currency or date **re-runs conversion**, because a stale rate
  on an edited row is a silently wrong number. Editing only the title or
  category leaves the conversion untouched.
- Approximate conversions are marked with `≈` and explain themselves on hover
  rather than being presented as exact.
- Edit and delete are owner-scoped by RLS: another user's row is simply not
  found.

## Overview

Reads a **dedicated `/api/overview` endpoint**, not the transactions list.
Summing the list in the client would mean summing a page capped at 500 rows —
silently under-reporting for exactly the heaviest users, while looking correct in
any small test. Every total is computed by Postgres as `numeric`.

Month bucketing uses `to_char(transaction_date, 'YYYY-MM')`, never a JS `Date`,
so a transaction cannot land in the wrong month for a user outside UTC.

### Pending rows are excluded and counted

Rows awaiting an exchange rate (`converted_amount IS NULL`) are left out of every
total, and the count is shown: *"2 transactions pending an exchange rate are not
included in these totals."* Treating them as zero would make a total quietly
wrong.

Worth noting for anyone changing this: Postgres `sum()` already ignores NULLs, so
a total looks correct even if the exclusion is removed. The observable difference
is whether a pending row is treated as **contributing** — a category whose only
rows are pending must be absent from the breakdown, not present with a zero
total. That is what the test asserts, because the sum alone cannot distinguish
the two.

### Four numbers

Spent, Income, Net, Budget Remaining — whole-month figures, in home currency.

`budget_remaining` is `null`, never `0`, when no budget is set, and the card
offers to set one instead of showing a misleading zero. Overspending shows a
negative figure rather than clamping.

### Seeded categories and payment methods

Seeded on signup, transcribed from the brief and in its order:

**Expense** — Groceries · Eating Out · Academic · Entertainment / Nightlife ·
Transport · Phone / Internet · Housing / Living · Shopping · Health · Travel ·
Subscription · Other

**Income** — Allowance · Salary · Scholarship · Refund · Other

**Payment methods** — Debit Card *(default)* · Credit Card ·
Global / Travel Card · Cash · Bank Transfer · Other

Migration `0007` backfills existing accounts with anything they were missing and
**deletes nothing that has transactions against it** — an invented category a
user has already filed spending under is their data now, not our mistake to
erase. Only untouched invented defaults are removed. It also normalises the
default payment method to exactly one, since the original seed marked every
method as default. `npm run verify:seed` asserts all of this against real
Postgres, including that re-running the migration creates no duplicates.

### The budget has its own currency

**The budget is denominated in the local spending currency** — what a student
actually thinks in when setting it — and is converted to home currency before
any comparison against totals.

This was a real defect. The budget was stored as a bare number and compared
against home-currency totals, so a London student entering `1500` for £1,500 had
it read as ₩1,500:

> "…1,600,183 KRW over your 1,500 KRW budget (**106778.9%** of it)."

Every figure there is arithmetically correct. The output is still nonsense,
because the *unit* was wrong.

Three things prevent a repeat:

- `profiles.budget_currency` snapshots the basis at write time, so changing local
  currency later cannot silently re-denominate an existing budget — the same
  reasoning as `transactions.converted_currency`.
- The onboarding input **names its currency** in the label and as a field prefix,
  and explains the conversion. An unlabelled money input is a bug regardless of
  what sits behind it.
- The budget card shows the figure as entered (`budget set as 1,500.00 GBP`)
  alongside its converted equivalent, so the number the user typed is always
  recognisable on screen.

If no rate is available to convert the budget, the comparison is **suppressed**
rather than performed across currencies. A wrong budget figure is worse than an
absent one.

### Equal-period comparison

1st→today against 1st→the same day of the prior month, labelled explicitly
(*"Comparing 1–15 August with 1–15 July"*) so it cannot be misread as a
whole-month comparison.

Two edge cases are handled rather than allowed to mislead:

- **Prior month shorter than today's day-of-month** (31 March vs February): the
  range clamps to the prior month's last day and the label says so.
- **Prior period had no spend**: reports *"No comparison available"*. Never `0%`,
  never `Infinity`, never a bogus 100%.

### Budget Consultant

Five deterministic rules, at most three emitted, highest signal first, each
citing real figures. No LLM: the same inputs always produce the same output,
which is what makes them verifiable.

| Rule | Fires when |
|---|---|
| Budget pace projection | A budget is set, there is spend, and it is **day 7 or later** |
| Category share | There is spend in at least one category |
| Category swing | A category moved >15% against the equal prior period |
| Outlier | A category is >=25% of spending from <=3 transactions |
| No-spend streak | >=2 consecutive days without an expense, in a month with activity |

Rules suppress themselves on insufficient data rather than hedging. The pace
projection is gated to day 7 because projecting a month from two days is noise
dressed as insight, and it always labels itself a projection.

Tone is enforced by test: every insight must contain a figure, must not exceed
260 characters, and must not match a list of moralising or motivational phrases.
A student's spending category is not a character flaw.

The rules live in `server/consultant.mjs` as pure functions over aggregated
figures, and are tested directly in `src/__tests__/consultant-rules.test.ts`.
That separation matters: testing the day-7 gate through the live endpoint would
only exercise whichever day it happens to be, so a conditional assertion would
silently test nothing for most of the month.

### Donut: 6 slices plus Other

The long tail groups into `Other` beyond six slices, matching the Designer
spec's existing cap rather than introducing a second, contradictory rule. The
grouped slice names its count (`Other (4)`) so it is never mistaken for a single
category. Clicking a slice opens Transactions with that category, month and type
filtered.

## PWA

`public/manifest.webmanifest` plus `public/sw.js`, registered in production only.

The service worker caches the **app shell only**. API and auth responses are
never cached: a budget tool showing stale totals as if they were current is the
exact failure this project has spent three review rounds guarding against.
Offline shows the shell and the app's own network error, not yesterday's numbers.

## Verification

```bash
npm test              # 232 tests
npm run verify:seed        # seed migration is data-safe on existing accounts
npm run verify:reconcile  # independent exact reconciliation of Overview totals
npm run verify:db   # applies all 3 migrations to real Postgres, asserts RLS
npm run verify:e2e  # the full journey over HTTP (needs dev:all running)
npm run build       # typecheck + production build
```

The suite includes a regression guard for date handling. `verify:db` proves cross-user SELECT, INSERT, UPDATE and DELETE are all
blocked. `verify:e2e` walks signup → onboarding → add → sign out → sign in →
data still present, plus constraint rejections and cross-user isolation.

The test suite includes `src/__tests__/live-journey.test.tsx`, which drives the
**real UI with no mocks** against the running API.

## Deployment

Two paths. The preview backend is the fast one; hosted Supabase is the durable one.

### Path A — preview backend (what the live URL runs)

Postgres runs in-process via PGlite. Genuine Postgres, same migrations, same RLS
policies, no external service to provision.

```bash
npm ci
npm run dev:all          # API on :8787, web on :5173
```

For a static host, build the frontend and run the API anywhere Node 22+ runs:

```bash
npm run build            # -> dist/
node server/index.mjs    # serves the API; set PORT to override 8787
```

Set `VITE_API_URL` at build time if the API is not reachable at the same origin.
Data lives in `.data/`; back that directory up or the database is ephemeral.

### Path B — hosted Supabase (recommended for real users)

**Walkthroughs:** [SETUP-GUIDE.md](SETUP-GUIDE.md) (database) and
[VERCEL-GUIDE.md](VERCEL-GUIDE.md) (hosting + connecting the keys) explain the
architecture and
every click for a non-database audience; [DEPLOYMENT.md](DEPLOYMENT.md) is the
condensed version. Apply `supabase/SETUP.sql` (generated: `npm run
build:setup-sql`) rather than the individual migrations.

The migrations were written against Supabase conventions (`auth.users`,
`auth.uid()`, RLS) and apply unchanged.

1. Create a project at supabase.com.
2. Apply the migrations **in order** — `0001` through `0007` — via the SQL editor
   or `supabase db push`. Order matters: `0003` and `0007` both define the signup
   trigger, and `0007` must win.
3. Enable **Email** auth in Authentication → Providers. Turn on email confirmation
   for production.
4. Copy `.env.example` to `.env.local` and fill `VITE_SUPABASE_URL` and
   `VITE_SUPABASE_ANON_KEY` from Project Settings → API.

   The anon key belongs in a browser build — RLS denies everything until a policy
   matches the caller. The **`service_role` key must never** appear in frontend
   env, client code, or the repository.
5. `npm run build` and deploy `dist/` to any static host.

`src/lib/supabaseClient.ts` is an adapter: it targets the preview API when no
Supabase URL is configured and the Supabase client when one is. No page or
component changes when you switch.

### Verifying a deployment

```bash
npm run verify:db        # every migration applies cleanly, RLS blocks cross-user reads
npm run verify:seed      # seeding is correct and data-safe on existing accounts
npm run verify:e2e       # the brief's full user journey against a running API
npm run verify:reconcile # every stored conversion reconciles exactly
```

Run `verify:db` and `verify:seed` before pointing real users at a new database.
Both are self-contained and need no running server.

## Known limitations

Every claim below is asserted by `npm run verify:limitations`, so a fix that
removes a limitation fails that check until this list is updated.

This exists because three entries here were false. Each was true when written and
silently falsified by a later fix — "Overview is a stub" after Phase 3 shipped,
"No PWA" after the service worker landed, and "Amount is not currency-aware"
after per-currency validation was added in `45bfb03`. Prose has no test that can
fail, so it rots. A limitations list is what a reader trusts when deciding whether
the product fits, and an understated one misleads exactly as much as an overstated
one.

- **Rates depend on third-party providers.** With both unreachable, new rows save
  with a pending conversion and fill in later.
- **`open.er-api.com` has no history**, so a past-dated transaction in a currency
  Frankfurter does not quote converts at a current rate and is flagged
  approximate rather than silently presented as exact.
- **Backfill is read-triggered and capped** at 25 rows per page load, so a large
  backlog takes several visits to clear.
- **The rate cache is per-process**, so restarting the API re-fetches rates.
- **No pagination controls yet** — the list returns up to 500 rows per query.
  Overview is unaffected: it aggregates in SQL over all rows.
- **Consultant rules are fixed** — no user configuration of thresholds.
- **The service worker caches the shell only**, so the app opens offline but
  shows no data without a connection. This is deliberate.
- **Unknown query parameters are rejected** with 400 rather than ignored, so a
  typo'd filter fails loudly instead of returning an unfiltered list.
- **Categories and payment methods are fixed** at the seeded defaults; there is
  no UI to add, rename or reorder them.
- **Onboarding answers cannot be changed** afterwards — no settings page yet.
- **Session tokens live in memory**, so restarting the API signs everyone out.
- **The bundled backend is a preview backend.** It runs Postgres in-process via
  PGlite, which is genuine Postgres and enforces the same RLS policies, but it is
  intended for evaluation. For production, point the app at hosted Supabase: the
  migrations in `supabase/migrations/` apply unchanged.
- **The preview instance is sandbox-hosted**, so the public URL and its data last
  only as long as the sandbox. The repository is the durable artifact.
- **Rates come from free API tiers with no SLA.** Frankfurter publishes ECB rates
  once per working day, so intraday movement is not reflected and no rate is
  "live". This is stated in the UI rather than implied away.
