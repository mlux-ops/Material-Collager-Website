# Private staging deployment checklist

This checklist prepares a review environment. It does not authorize deployment or resource creation.

## 1. Release candidate

- [ ] Record the exact Git commit in `artifacts/release-qa/<date>/release-candidate.json`.
- [ ] Confirm the working tree is clean before building.
- [ ] Run `npm ci` using Node 22.13 or newer.
- [ ] Run `npm run test:scene-lab`.
- [ ] Run `npm run test:release-readiness`.
- [ ] Run `npm run validate:rights`.
- [ ] Run `npm run lint`.
- [ ] Run `npm run build`.

## 2. Isolated Cloudflare resources

- [ ] Create a D1 database used only by Material Collager staging.
- [ ] Bind that database to the review deployment as `DB`.
- [ ] Create an R2 bucket used only by Material Collager staging.
- [ ] Bind that bucket to the review deployment as `OUTPUTS`.
- [ ] Confirm neither resource ID matches production.
- [ ] Give the review service account only the permissions required for these staging resources.
- [ ] Store resource IDs and secrets in the deployment control plane, not in committed files.

The generation service creates and upgrades `generation_jobs` lazily. Before release data is generated, confirm the staging D1 account permits table and index creation. If the deployment platform requires explicit migrations, capture the generated SQL and apply it to staging before testing.

## 3. Runtime configuration

- [ ] Configure `OPENAI_API_KEY` only in the staging secret store.
- [ ] Configure any required model or QA environment values without committing them.
- [ ] Confirm `.openai/hosting.json` still maps D1 to `DB` and R2 to `OUTPUTS`.
- [ ] Confirm the deployment's actual binding values override local placeholder resource names.
- [ ] Confirm image optimization and static assets work in the review environment.

## 4. Access and isolation

- [ ] Protect the review URL with Cloudflare Access, platform authentication, or an equivalent non-public control.
- [ ] Prevent indexing through access control; do not rely only on `robots.txt`.
- [ ] Confirm the review URL cannot access production D1 or R2 resources.
- [ ] Confirm staging output URLs are not embedded into production pages.

## 5. Binding verification before paid generation

1. Request `GET /api/library` from the review URL.
2. Confirm the response is produced by staging D1 rather than a local mock or fixture.
3. Create a disposable non-production record only when authorized.
4. Confirm its database row appears in staging D1 and nowhere in production.
5. Confirm its preview object appears in staging R2 and nowhere in production.
6. Remove the disposable record and object before the approved release dataset is generated.

Do not use a production record as a binding test.

## 6. Populate and validate release data

After rights approval and paid-generation authorization:

```powershell
npm run qa:scaffold -- --date YYYY-MM-DD --commit COMMIT_SHA --base-url https://PRIVATE-REVIEW-URL
npm run validate:rights -- --release
npm run validate:library -- --base-url https://PRIVATE-REVIEW-URL --release `
  --output artifacts/release-qa/YYYY-MM-DD/library-validation.json `
  --records-output artifacts/release-qa/YYYY-MM-DD/library-records.json
```

- [ ] Generate 8–10 distinct completed final collages.
- [ ] Confirm every source package appears in `docs/release-collage-rights.json` before generation.
- [ ] Confirm the Library validator passes all record, expiry, uniqueness, and preview checks.
- [ ] Run the populated-record checks in `docs/library-integration-qa.md`.

## 7. Rollback

- [ ] Keep the previous review deployment revision available.
- [ ] Record the previous and candidate commit identifiers.
- [ ] If application code fails, route the review hostname back to the previous revision.
- [ ] If staging data is invalid, stop generation, preserve evidence, and remove only the affected staging records and R2 objects.
- [ ] Do not copy staging data into production as a rollback mechanism.
- [ ] Revoke or rotate staging credentials if a binding or secret was exposed.
