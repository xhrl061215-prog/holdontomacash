# Vercel, explained — and connecting the two keys

You got Supabase done, which was the harder half. This part is shorter.

---

## What Vercel is

**Vercel is a web host.** That's all. It takes the app's files and serves them to
anyone who opens your URL.

Right now those files only exist inside my sandbox, which is why the link dies when
the sandbox stops. Vercel puts them somewhere permanent, on machines that stay up
whether or not I'm running.

Two things Vercel does *not* do, which is where the confusion usually is:

- **It does not store your data.** Not one transaction. Every account and every
  transaction lives in Supabase. Vercel could be wiped and rebuilt and nobody would
  lose a thing.
- **It does not run your database.** When a student adds a transaction, the page in
  their browser talks *directly* to Supabase. Vercel isn't in the middle.

So:

```
  Vercel  →  ships the pages to people
  Supabase → keeps the accounts and the money data
  The 2 keys → tell the pages which Supabase project to talk to
```

That last line is the whole "connecting the API" step. There's no wiring to
configure, no endpoints to register. You paste two values into Vercel's settings,
and the app knows where to find your database.

---

## Why the app needs the keys at *build* time

This part explains a mistake that's easy to hit.

Vercel doesn't just copy your files — it **builds** them first: it runs
`npm run build`, which turns the source code into the optimised files a browser
loads. Your two Supabase keys get written *into* those files during that build.

**Consequence: if you add the keys after deploying, the already-built files don't
have them.** You have to click **Redeploy** so it builds again, this time with the
keys present.

If you skip that, the app loads but can't reach Supabase, and sign-up fails with
something like "Invalid API key" or "Failed to fetch". That isn't a broken setup —
it's a build that happened before the keys existed.

**So: add the keys, then deploy. Or if you already deployed, add them and hit
Redeploy.**

---

## Steps

You need the code in GitHub first — see `IMPORT-TO-GITHUB.md`, about two minutes.

### 1. Sign in

**vercel.com** → **Sign Up** / **Log In** → **Continue with GitHub**. Authorise it
when GitHub asks. Signing in with GitHub is what lets Vercel see your repositories.

### 2. Import the repository

- **Add New…** → **Project**
- Your repositories appear. Find `budget-tracker` → **Import**
- If it isn't listed: **Adjust GitHub App Permissions** → grant access to that
  repo, then come back

### 3. Check the build settings

Vercel detects Vite and fills these in. Confirm they say:

| Field | Value |
|---|---|
| Framework Preset | Vite |
| Build Command | `npm run build` |
| Output Directory | `dist` |
| Install Command | `npm install` |

If Framework Preset says "Other", set it to **Vite** manually.

### 4. Add the two keys — *before* you deploy

Expand **Environment Variables**. Add both:

| Name | Value |
|---|---|
| `VITE_SUPABASE_URL` | your Project URL from Supabase |
| `VITE_SUPABASE_ANON_KEY` | your **anon public** key from Supabase |

Where to find them: Supabase → **Project Settings** (gear, bottom left) → **API**.

Four things worth checking, because each is a real failure I'd rather you avoid:

- **Names must match exactly**, including the `VITE_` prefix. `SUPABASE_URL`
  without it will be ignored — the prefix is what marks a variable as safe to
  include in the browser build.
- **No quotes, no trailing space.** Paste the raw value. A trailing space produces
  "Invalid API key".
- **Tick all three environments** (Production, Preview, Development) so previews
  work too.
- **Use the `anon` key, never `service_role`.** The `anon` key can't bypass your
  security rules, which is why it's safe in a browser. `service_role` skips them
  entirely — in a web page, anyone could read it and see every user's finances.

### 5. Deploy

Click **Deploy** and wait ~1 minute. You get a URL like
`budget-tracker-abc123.vercel.app`. That's your app, live, permanently.

From now on every push to GitHub redeploys automatically.

---

## Check it works

On the real URL, in this order:

1. **Sign up** with an email you can read → click the confirmation link
2. Complete onboarding — study country, local currency, home currency, budget
3. **Add a transaction**
4. **Log out, log back in** — the transaction is still there
5. **Close the tab entirely, reopen the URL** — you're still signed in
6. **Open it on your phone** — same account, same data
7. **Sign up a second account** with a different email — it must see **none** of
   the first account's transactions

Steps 4–6 are the durability you asked for; they're the part the sandbox version
could never do. **Step 7 is the one to take seriously** — that's the guarantee one
student never sees another's money. The database enforces it, not the app code, and
I have automated checks proving it can't be bypassed. Verify it anyway.

---

## Optional: a nicer address

**Project → Settings → Domains.** You can rename the free
`something.vercel.app` subdomain, or point a domain you own at it. Neither is
required and neither affects how anything works.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Invalid API key` / `Failed to fetch` on sign-up | Keys missing, misspelled, or added after the build. Check names and values, then **Redeploy**. |
| Build fails: `Missing script: build` | The repo has an extra nested folder, so `package.json` isn't at the top. Re-upload the *contents*, not the containing folder. |
| Blank white page | Open the browser console (F12). Usually a missing `VITE_` prefix on a variable name. |
| Refreshing `/transactions` shows 404 | `vercel.json` didn't make it into the repo. It's in the archive — check it's at the top level. |
| Sign-up works but no email arrives | Supabase's built-in mail is rate-limited. Check spam, then Supabase → Authentication → Users: the account will be there, unconfirmed. |
| You can see another account's data | Wrong key — `service_role` instead of `anon`. Tell me immediately; that needs rotating. |

---

## What I can't do, and what I can

**Can't:** create your GitHub repo, sign in to Vercel, or hold your keys. Those
need accounts in your name, and keys shouldn't be pasted into a chat channel where
everyone in it can read them.

**Can:** once the repo exists, add me as a collaborator and I'll handle the Vercel
import and verification. Or send me the deployment URL when it's up and I'll run
the full check sequence against it — including the two-account isolation test —
and tell you exactly what I find.

Any step that assumes something I didn't explain is a bug in my instructions. Tell
me the exact message and which step, and I'll fix it.
