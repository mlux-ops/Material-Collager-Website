# Deploying Material Collager (Cloudflare Workers)

The site deploys to Cloudflare Workers from GitHub: **every push to `main`
auto-deploys** via `.github/workflows/deploy.yml` (build with Vite/vinext,
publish with `wrangler deploy`). The legacy OpenAI Sites hosting
(`*.chatgpt.site`, config in `.openai/hosting.json`) is no longer the deploy
target; its files are kept only so that path could be revived.

## One-time setup

### 1. Fill in your resource IDs — `wrangler.jsonc`

- **D1** (dashboard → Storage & Databases → D1, or `wrangler d1 list`):
  set `database_name` and `database_id`. Tables are created lazily by the app
  on first use — no migrations to run.
- **R2** (dashboard → R2, or `wrangler r2 bucket list`): set `bucket_name`.

### 2. GitHub repository secrets (Settings → Secrets and variables → Actions)

| Secret | Where to get it |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | Dashboard → Workers & Pages → right sidebar, or any dashboard URL |
| `CLOUDFLARE_API_TOKEN` | Dashboard → profile → API Tokens → Create Token → template **"Edit Cloudflare Workers"** (grant D1 + Workers R2 Storage edit for the account too) |

### 3. First deploy

Push to `main` (or run the **Deploy to Cloudflare** workflow manually from the
Actions tab). The worker `material-collager` appears under Workers & Pages.

### 4. Runtime secret

Dashboard → Workers & Pages → `material-collager` → Settings → Variables and
Secrets → add secret **`OPENAI_API_KEY`**. (Or locally:
`npx wrangler secret put OPENAI_API_KEY`.) Without it, generation only works
when a caller supplies a key in Settings on the generator page.

### 5. Domain

Workers & Pages → `material-collager` → Settings → Domains & Routes → add your
custom domain (must be a zone in this Cloudflare account). The default
`*.workers.dev` URL also works immediately.

### 6. Access control — IMPORTANT

The old chatgpt.site hosting sat behind ChatGPT sign-in. **On Cloudflare the
site is public by default**, and generation spends real OpenAI credit using
the server key. Unless the site is meant to be public, protect it:
Zero Trust → Access → Applications → add an application covering the domain
(free for up to 50 users, e.g. email one-time-PIN for your addresses).

## Notes

- Local dev is unchanged: `npm run dev` (Miniflare simulates D1/R2 locally;
  the placeholder `database_id` is fine for local work).
- Data does not migrate from the old hosting: the 30-day history/library
  starts empty on Cloudflare. Outputs expire after 30 days by design.
- Rollback: Workers & Pages → `material-collager` → Deployments → roll back,
  or `git revert` the offending commit and push.
- The OpenAI **Uploads API** (`POST /v1/uploads`) was blocked from the old
  chatgpt.site environment (which is why Economy Final rendering was
  disabled-in-practice there). On Cloudflare it may work — worth re-testing
  the Economy Final button after migrating.
