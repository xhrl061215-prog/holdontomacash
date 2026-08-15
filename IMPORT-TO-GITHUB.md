# Getting this code into your own GitHub repository

The archive contains the complete project. Two ways to get it into GitHub —
the first needs no software installed.

## Option A — browser upload (~2 minutes, nothing to install)

1. Go to **github.com/new**
2. **Repository name:** `budget-tracker`
3. Choose **Private** (you can make it public later; private is the safe default
   for anything touching your own data)
4. **Do not** tick "Add a README" or add a .gitignore — the archive already has
   both, and pre-adding them causes a conflict
5. Click **Create repository**
6. On the empty repo page, click **uploading an existing file**
7. Unzip `budget-tracker.zip` on your computer, then drag **the contents** of the
   unzipped folder into the browser — the files themselves, not the folder
8. Commit message: `Initial import` → **Commit changes**

That's it. Vercel can now import this repository.

> Drag the *contents*, not the containing folder. If GitHub ends up showing a
> single `budget-tracker` folder, the app is one level too deep and Vercel won't
> find `package.json`. Delete and re-upload the inner files if so.

## Option B — command line (if you have git installed)

```bash
unzip budget-tracker.zip -d budget-tracker
cd budget-tracker
git init
git add -A
git commit -m "Initial import"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/budget-tracker.git
git push -u origin main
```

Create the empty repository on github.com/new first, without a README.

## What's in the archive

Everything needed to build and deploy:

- `src/` — the app itself (React + TypeScript)
- `server/` — the preview backend, used only for local development
- `supabase/` — database blueprint, including `SETUP.sql`
- `src/__tests__/` — 232 tests
- `SETUP-GUIDE.md`, `DEPLOYMENT.md`, `README.md` — the documentation
- `vercel.json` — hosting configuration

## What's deliberately NOT in it

- **No `.env` file and no keys.** Nothing secret is in the archive, so it is safe
  to upload. You add your two Supabase keys in Vercel's settings, never in the
  code.
- **No `node_modules`.** That folder is ~200 MB of downloadable dependencies;
  Vercel installs them itself. Never commit it.
- **No `.data`.** That's the local preview database, which is throwaway.
- **No git history.** This is a clean first commit under your name.
