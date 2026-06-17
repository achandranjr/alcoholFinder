# Deployment guide (free tier)

This deploys the whole system on free tiers with **no always-on server**:

| Piece | Host | Cost |
| --- | --- | --- |
| Database | **Supabase** Postgres | Free |
| Dashboard + API | **Vercel** (Hobby) | Free |
| Discovery (the long job) | **GitHub Actions** cron, 2×/day | Free |

Discovery does **not** run on Vercel. Vercel only serves the dashboard and a thin
read/enqueue API; the actual ~10-min pipeline runs in a scheduled GitHub Actions
job (`.github/workflows/discover.yml`) via `npm run discover`, which writes its
results to Supabase. The dashboard is a read-only monitor of those runs.

> **Assumption:** the `alcohol-discovery/` folder is your **git repo root** (the
> same thing Vercel deploys). If you instead push the parent folder, see the
> "Parent-folder layout" note at the very end.

---

## 1. Supabase (database)

1. Create a project at <https://supabase.com> → **New project**. Pick a region
   near you and set a database password (save it).
2. **Create the tables.** Open **SQL Editor**, paste the contents of
   [`db/schema.sql`](db/schema.sql), and run it. (Or locally:
   `psql "$DATABASE_URL" -f db/schema.sql`.)
3. **Get the connection string.** Click the **Connect** button in the top bar of
   the dashboard (next to the project name) to open the connection dialog. Under
   **Connection string**, pick the **Transaction pooler** (port **6543**) — this
   is the one for serverless/CI, *not* the Direct connection (port 5432). Copy it;
   it looks like:

   ```
   postgresql://postgres.<ref>:[YOUR-PASSWORD]@aws-0-<region>.pooler.supabase.com:6543/postgres
   ```

   Replace `[YOUR-PASSWORD]` with the database password you set when creating the
   project (you can reset it under **Settings → Database → Database password**).
   The finished string — with the real password — is your `DATABASE_URL`.

> The 2×/day discovery job also keeps the project active, so Supabase's free-tier
> "pause after 7 days idle" never triggers.

---

## 2. GitHub (repo + scheduled discovery)

1. **Push the repo.** From the `alcohol-discovery/` folder:

   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   gh repo create alcohol-discovery --private --source=. --push
   # or create the repo in the GitHub UI and push manually
   ```

   `.env` is gitignored, so no secrets are committed — good. Confirm with
   `git status` that `.env` is **not** staged.

2. **Add the secrets the cron needs.** Repo **Settings → Secrets and variables →
   Actions → New repository secret**:

   | Secret | Required? | Notes |
   | --- | --- | --- |
   | `DATABASE_URL` | **Yes** | The Supabase pooler URL from step 1. |
   | `ANTHROPIC_API_KEY` | Optional | Enables the agentic web-discovery source. Without it that source is skipped. |
   | `COLACLOUD_API_KEY` | Optional | The primary TTB/COLA feed. Without it that source is skipped. |

3. **Confirm the schedule.** `.github/workflows/discover.yml` runs at **8 AM and
   8 PM US Central**. GitHub cron is UTC-only and ignores DST, so it's currently
   set for CDT (`0 13` / `0 1` UTC). When CT switches to standard time in early
   November, bump both an hour (`0 14` / `0 2`) per the comment in the file.

4. **Trigger a run now to test:** **Actions → Discovery → Run workflow**
   (`workflow_dispatch`). Watch the logs; on success you'll see
   `status=done ... new=<n>`.

---

## 3. Vercel (dashboard + API)

1. Import the GitHub repo at <https://vercel.com/new>.
   - **Root Directory:** leave as the repo root (where `vercel.json` lives).
   - **Framework Preset:** *Other*. `vercel.json` already defines the build
     (`npm run build:vercel`) and output (`public/`) and routes `/api/*` to the
     function — don't override these.
2. **Environment Variables** (Project → Settings → Environment Variables, scope
   *Production*):

   | Variable | Required? | Notes |
   | --- | --- | --- |
   | `DATABASE_URL` | **Yes** | Same Supabase pooler URL. |
   | `ANTHROPIC_API_KEY` | Optional | Only needed for the dashboard's **Add source → Analyze** feature. |
   | `COLACLOUD_API_KEY` | Optional | Not used by the web layer; harmless to set. |

3. **(Optional) Harden the install** for supply-chain hygiene: set
   **Settings → Build & Deployment → Install Command** to
   `npm ci --include=dev --ignore-scripts`. The `--include=dev` is important —
   without it Vercel's `NODE_ENV=production` would drop `typescript`/`tsx` and the
   build would fail. The default `npm install` also works fine if you skip this.
4. **Deploy.** You'll get a `https://<project>.vercel.app` URL. The dashboard is
   at `/`; the API is at `/api/*`.

> `vercel.json` sets the source-analyzer function's `maxDuration` to **300s**.
> That's allowed on Hobby with **Fluid compute** (the default for new projects);
> if you ever see `FUNCTION_INVOCATION_TIMEOUT` on **Add source → Analyze**,
> check that Fluid compute is enabled (Project → Settings → Functions).

---

## 4. Verify end to end

1. Open the Vercel URL → the dashboard loads. "Recent runs" is empty until the
   first discovery completes.
2. Run the workflow once (step 2.4 above) if you haven't.
3. Back on the dashboard, click **↻ Refresh**. The completed run appears in
   "Recent runs"; selecting it shows candidate/new/known stats, the activity log,
   and any new products. The **Sources** panel lists each connector as
   *enabled* (has its key) or *disabled* (missing key).

That's it — from here it runs itself at 8 AM and 8 PM CT.

---

## Optional source keys

- **COLA Cloud** (primary new-product feed): sign up at <https://colacloud.us>,
  then set `COLACLOUD_API_KEY` as a **GitHub Actions secret** (and on Vercel if
  you like). This is the highest-signal source.
- **Anthropic** (agentic long-tail discovery + the dashboard analyzer): get a key
  at <https://console.anthropic.com>, set `ANTHROPIC_API_KEY`.
- **Open Brewery DB**: no key, always on.

**Cost note:** Supabase, Vercel Hobby, and GitHub Actions are free for this
workload. The only metered costs are your Anthropic API usage (the agentic source
defaults to `claude-opus-4-8`, running twice daily — set an `ANTHROPIC_MODEL`
GitHub secret to a cheaper model to trim it) and any COLA Cloud subscription.

---

## Things that intentionally don't exist here

- **No always-on worker.** Discovery is the scheduled GitHub job, full stop.
- **No on-demand "Run" buttons** on the dashboard — those required a worker to
  claim queued runs. The dashboard is now read-only. To run discovery off-schedule,
  use **Actions → Discovery → Run workflow**, or run `npm run discover` locally.

If you later want on-demand runs from the dashboard, the path is: have the Vercel
API call GitHub's `workflow_dispatch` endpoint, and have the workflow claim the
queued run (`claimNextRun`) instead of starting a fresh one.

---

## Parent-folder layout (only if you didn't push `alcohol-discovery/` as root)

If your git repo root is the **parent** of `alcohol-discovery/`:

- **Vercel:** set **Root Directory** to `alcohol-discovery`.
- **GitHub Actions:** the workflow must `cd` into the subfolder. Add to the job:

  ```yaml
  defaults:
    run:
      working-directory: alcohol-discovery
  ```

  and point the npm cache at it in the `setup-node` step:

  ```yaml
  with:
    node-version: 22
    cache: npm
    cache-dependency-path: alcohol-discovery/package-lock.json
  ```
