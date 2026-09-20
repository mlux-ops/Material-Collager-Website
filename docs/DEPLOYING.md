# Deploying Material Collager (Cloudflare Workers)

The site deploys to Cloudflare Workers from GitHub: **every push to `main`
auto-deploys** via `.github/workflows/deploy.yml` (build with Vite/vinext,
publish with `wrangler deploy`). The legacy OpenAI Sites hosting
(`*.chatgpt.site`, config in `.openai/hosting.json`) is no longer the deploy
target; its files are kept only so that path could be revived.

## One-time setup

### 1. Resource names — `wrangler.jsonc` (already configured)

- **D1**: `material-collager-db` — the workflow resolves the database id by
  name at deploy time, so no UUID needs to be committed. Tables are created
  lazily by the app on first use — no migrations to run.
- **R2**: `material-collager-outputs`.

If you ever rename the database or bucket, update `wrangler.jsonc`
(`database_name`, `bucket_name`) and the name in
`.github/workflows/deploy.yml`'s resolve step.

### 2. GitHub repository secrets (Settings → Secrets and variables → Actions)

| Secret | Where to get it |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | Dashboard → Workers & Pages → right sidebar, or any dashboard URL |
| `CLOUDFLARE_API_TOKEN` | Dashboard → profile → API Tokens → Create Token → template **"Edit Cloudflare Workers"** (grant D1 + Workers R2 Storage edit for the account too) |

### 3. First deploy

Push to `main` (or run the **Deploy to Cloudflare** workflow manually from the
Actions tab). The worker `material-collager` appears under Workers & Pages.

### 4. Runtime secrets

Dashboard → Workers & Pages → `material-collager` → Settings → Variables and
Secrets → **Add** → type **Secret** → `OPENAI_API_KEY` → then press **Deploy**
(an entry that is only saved is staged, not live). Or locally:
`npx wrangler secret put OPENAI_API_KEY`. Without it, generation only works
when a caller supplies a key in Settings on the generator page.

**`SMARTSHEET_ACCESS_TOKEN`** is different: it lives in the account-level
**Secrets Store** (Dashboard → Storage & databases → Secrets Store), and
`wrangler.jsonc` binds it to the Worker under `secrets_store_secrets` (store
id plus secret name). The Secrets Store is a separate product from a Worker's
own Variables and Secrets: an entry there reaches a Worker only through such a
binding, never by name alone, and `wrangler secret list` never shows it. The
entry needs the **Workers** scope. Rotating it is an edit in the store; the
Worker reads the current value on each request, so no deploy is needed.
Without it the board still works — projects can be seeded from a tracked
definition (`npm run autoboard:seed-web`) and photos uploaded by hand — but
**Read sheet** fails with a message saying which step failed: binding
missing, entry missing or unreadable, or value empty.

Locally, `.dev.vars` cannot supply this one — the binding name belongs to the
Secrets Store object, so a same-named line is ignored. Create a local copy in
Miniflare's emulated store once per machine instead (it lives under
`.wrangler/state`, git-ignored):

```bash
npx wrangler secrets-store secret create b3ae60f8f0d34d03ae7182deb77bbe76 \
  --name SMARTSHEET_ACCESS_TOKEN --scopes workers
```

It prompts for the value; without `--remote` nothing leaves the machine.

The deploy workflow's **List Worker secrets** step prints `wrangler secret list`
(names and types only) on every run, so the deploy log records what the live
Worker holds among its own secrets.

`wrangler.jsonc` sets `keep_vars: true` so a variable added in the dashboard
survives the next deploy. Without it wrangler treats the config file as the
whole truth for variables and deletes a dashboard entry of type **Text** on
every push to `main`; type **Secret** survives either way, and is the right
type for a token. `npx wrangler secret list` shows the secrets actually stored
on the Worker (names only — values are write-only).

### 5. Domain

Workers & Pages → `material-collager` → Settings → Domains & Routes → add your
custom domain (must be a zone in this Cloudflare account). The default
`*.workers.dev` URL also works immediately.

### 6. Access control — IMPORTANT

The old chatgpt.site hosting sat behind ChatGPT sign-in. **On Cloudflare the
site is public by default**, and generation spends real OpenAI credit using
the server key. Unless the site is meant to be public, protect it with
Cloudflare Access (free for up to 50 users):

1. Workers & Pages → `material-collager` → Settings → Domains & Routes →
   on the `workers.dev` row click **Enable Cloudflare Access**. (First-time
   Zero Trust use asks you to pick a team name, e.g. `shb-studio`.)
2. Click **Manage Cloudflare Access** and set the Allow policy to
   **Emails ending in `@shb.studio`** (or list individual addresses). The
   default one-time-PIN login needs no identity-provider setup.
3. **Turn on the Worker-side JWT check** (defense-in-depth — guarantees
   requests can't skip Access even if the app config changes later):
   uncomment the `vars` block in `wrangler.jsonc` and fill in:
   - `CF_ACCESS_TEAM_DOMAIN`: `<team>.cloudflareaccess.com`
   - `CF_ACCESS_AUD`: the application **Audience tag** from Zero Trust →
     Access → Applications → the auto-created app → Overview.
   Redeploy. The Worker (`worker/access.ts`) then rejects any request
   without a valid Access JWT. Do this only *after* step 1, or every
   request is denied. **Local dev is affected**: Miniflare reads the same
   `vars` block, so `npm run dev` answers 403 to every page until both are
   blanked in `.dev.vars` (see `.dev.vars.example`).
4. Validate: open the site in a private window → expect the Access login;
   a non-studio email should be denied. Zero Trust → Logs → Access shows
   each decision.

Rollback: disable the toggle from step 1 and re-comment the `vars` block.

## Notes

- Local dev is unchanged: `npm run dev` (Miniflare simulates D1/R2 locally;
  the placeholder `database_id` is fine for local work).
- Data does not migrate from the old hosting: the history/library starts empty
  on Cloudflare. Outputs expire after six months by design (`RETENTION_MS` in
  `app/lib/generation-jobs.ts`); expiry hard-deletes the D1 row *and* its R2
  object, with no backup, so raise that constant before it matters rather than
  after.
- Rollback: Workers & Pages → `material-collager` → Deployments → roll back,
  or `git revert` the offending commit and push.
- The OpenAI **Uploads API** (`POST /v1/uploads`) was blocked from the old
  chatgpt.site environment (which is why Economy Final rendering was
  disabled-in-practice there). On Cloudflare it may work — worth re-testing
  the Economy Final button after migrating.
