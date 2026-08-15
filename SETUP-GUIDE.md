# Setup, explained properly

You asked what connects to what. Fair question — my earlier instructions told you
which buttons to press without explaining the shape of the thing, so here's the
whole picture first. **Nothing below requires you to understand SQL.**

---

## What you're building: three pieces

Right now the app runs entirely inside my sandbox, which is why the link dies when
the sandbox stops. A durable version splits into three parts that live in
different places:

```
   Someone's phone or laptop
   ┌─────────────────────────┐
   │   the app's web pages   │   ← 2. Vercel serves these files
   │   (what a student sees) │      to anyone who opens your URL
   └───────────┬─────────────┘
               │  "save this £12 transaction"
               │  "who is signed in?"
               ▼
   ┌─────────────────────────┐
   │  Supabase               │   ← 1. Supabase holds the data
   │  • accounts & passwords │      and the accounts, permanently
   │  • everyone's spending  │
   └─────────────────────────┘

   3. The two keys are what tell the pages in (2)
      which Supabase project in (1) to talk to.
```

- **Supabase** is the filing cabinet: accounts, passwords, transactions. It runs
  Postgres, a real database, and it keeps everything even when nobody's using the
  app.
- **Vercel** is the shop window: it serves the app's pages to anyone with the URL.
  It holds no data.
- **The two keys** are the address and the doorkey — they tell the pages which
  Supabase project to connect to. That's the "connecting things" part.

They're separate because they do different jobs. Data needs to persist; web pages
need to be fast to serve everywhere. Both are free at your scale.

---

## Why the SQL step exists at all

A brand-new Supabase project is an **empty** filing cabinet. It has no idea what a
transaction is, or that a category has a name, or that one student must never see
another's spending.

The SQL step is you handing it the blueprint — once. It creates:

- the **tables** (profiles, transactions, categories, payment methods)
- the **security rules** that make each student's data invisible to everyone else
- the **starting categories** (Groceries, Eating Out, Subscription…) that each new
  account gets automatically
- one **calculation** the Overview page needs

After this you never touch SQL again. It's a one-time setup, not maintenance.

---

## Step 1 — Apply the blueprint (one paste)

I previously said "paste 8 files in order." Forget that — copying 8 things in the
right sequence is a job for a script, and I've now made it one.

**Use the attached `SETUP.sql`. It's all 8 combined, in the correct order.**

1. In Supabase, left sidebar → **SQL Editor**
2. Click **+ New query**
3. Open `SETUP.sql`, select all (**Ctrl/Cmd + A**), copy
4. Paste into the big empty editor box
5. Click **Run** (or Ctrl/Cmd + Enter)

**You should see:** `Success. No rows returned.`

That message is correct and means it worked. "No rows returned" sounds like nothing
happened, but it just means you asked it to *build* things rather than *look
something up* — there was nothing to display.

### Things that might worry you, but shouldn't

- **It's ~760 lines.** Normal. Most of it is comments explaining each part.
- **You pasted it twice by accident.** Harmless. It's written to be safely
  re-runnable, and I have a test that proves it: running it twice produces no
  duplicates.
- **Something failed half-way.** It can't leave a half-built database — the whole
  file runs as one transaction, so any error undoes everything and you can just
  fix and re-run.
- **You don't recognise any of the SQL.** You don't need to. It's the same
  blueprint the app has been using all along; I've verified it applies cleanly to
  a fresh database, and `npm run verify:setup-sql` checks that on every change.

### Confirming it worked

Left sidebar → **Table Editor**. You should see four tables: `profiles`,
`categories`, `payment_methods`, `transactions`.

They'll be **empty**, which is right — categories are created per-account when
someone signs up, not up front.

---

## Step 2 — Turn on email login

**Authentication** → **Providers** → **Email** → enable.

Leave **Confirm email** on: new users get a link to click, which stops people
signing up with addresses they don't own. The app tells them to check their inbox.

One limit worth knowing: Supabase's built-in email is capped at a few messages per
hour. Fine for you and early testers. If you're sharing it widely, add your own
mail provider under **Project Settings → Authentication → SMTP**.

---

## Step 3 — Copy the two keys

**Project Settings** (gear icon, bottom left) → **API**. You need two values:

| Supabase calls it | Paste it into Vercel as |
|---|---|
| **Project URL** | `VITE_SUPABASE_URL` |
| **anon public** | `VITE_SUPABASE_ANON_KEY` |

### The one thing to be careful about

On that page there is also a **`service_role`** key, usually hidden behind a
"reveal" button.

**Copy the `anon` key. Never the `service_role` key.**

Why it matters: the security rules you just installed check *who is asking* before
returning any row. The `anon` key can't bypass them — on its own it opens nothing,
which is why it's safe to ship inside a web page. The `service_role` key is a
master key that skips those checks entirely. In a web page, anyone could read it
and see every user's finances.

If you ever paste one and the app shows other people's data, that's the wrong key
— tell me and I'll help you rotate it.

---

## Step 4 — Put the app online

1. Get this repository onto GitHub if it isn't already.
2. **vercel.com** → sign in with GitHub → **Add New Project** → pick the repo.
3. It detects the setup automatically. Confirm build command `npm run build`,
   output directory `dist`.
4. **Environment Variables** → add the two from Step 3. Tick Production, Preview
   and Development.
5. **Deploy.**

You get a permanent URL. Every push to the repo redeploys it.

> **If you add the keys after deploying**, hit **Redeploy** — the keys get baked in
> at build time, so a build that ran without them won't pick them up.

---

## Step 5 — Check it properly before sharing

Do these in order, on the real URL:

1. **Sign up** with an email you can read; click the confirmation link.
2. Complete onboarding — study country, local currency, home currency, budget.
3. **Add a transaction.**
4. **Log out and back in.** Transaction still there.
5. **Close the tab completely, reopen the URL.** Still signed in.
6. **Open it on your phone.** Same account, same data.
7. **Sign up a second account** with a different email. It must see **none** of the
   first account's transactions.

Steps 4–6 are the durability you asked for. **Step 7 is the important one** —
that's the guarantee one student never sees another's money. It's enforced by the
database itself rather than by app code, and I have automated checks proving it
can't be bypassed, but check it yourself on the real thing.

---

## What I can and can't do for you

**Can't:** create the accounts. They need to be yours — billing, ownership,
password resets. And please don't paste keys into chat; anyone in the channel would
see them.

**Can, if you'd rather not:** once the Supabase project exists, invite me to it
(**Project Settings → Team → Invite**) and I'll apply the blueprint and verify it.
Same for Vercel. Your call — the steps above are genuinely 20 minutes, but there's
no prize for doing them yourself.

---

## If you get stuck

Tell me the exact message and which step. Common ones:

| What you see | What it means |
|---|---|
| `Success. No rows returned` | It worked. This is the expected result. |
| `relation "public.profiles" does not exist` | The SQL didn't run. Re-paste `SETUP.sql`. |
| `Invalid API key` | A key is missing, truncated, or has a stray space. Fix in Vercel, then **Redeploy**. |
| Sign-up works, no email | Check spam; then Authentication → Users. Account exists but unconfirmed = email limit. |
| Overview empty, transactions exist | The last part of the SQL didn't apply. Re-paste `SETUP.sql`. |
| You see another account's data | Wrong key — you used `service_role`. Tell me immediately. |

There's no question too basic here. If a step assumes something I forgot to
explain, that's a bug in my instructions, not in your understanding.
