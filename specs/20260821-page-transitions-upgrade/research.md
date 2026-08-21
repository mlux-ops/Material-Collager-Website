# Phase 0 Research — Page Transitions Upgrade

**Date started**: 2026-08-21
**Environment**: dev build (`npm run dev`, vinext/Vite on Miniflare), in-app Chromium browser

## T002 — API support matrix ✅

Feature detection, local engine (Chrome/148.0.7778.280):

| Capability | Probe | Result |
|---|---|---|
| `document.startViewTransition` | typeof | ✅ function |
| Object signature `{ update, types }` | live call + `skipTransition()` | ✅ accepted |
| `ViewTransition.types` (Set-like) | `vt.types.has('probe-a')` | ✅ true |
| `ViewTransition.transitionRoot` | in-check | ✅ present |
| `ViewTransition.waitUntil` | typeof | ✅ function |
| `:active-view-transition-type()` | `CSS.supports('selector(…)')` | ✅ |
| `:active-view-transition` | `CSS.supports` | ✅ |
| `view-transition-class` | `CSS.supports` | ✅ |
| `view-transition-group` (nested groups) | `CSS.supports('view-transition-group','nearest')` | ✅ |
| `@view-transition` at-rule | constructed-stylesheet parse | ✅ parses |
| Navigation API (`navigation`) | typeof | ✅ present |

**Degradation matrix** (local result + published support data from the *Page Transitions, 2026* research brief):

| Tier | Engines | Behavior we ship |
|---|---|---|
| Full (types + classes) | Chromium 125+, recent Safari/Firefox per Next docs; types Baseline Jan 2026 | Directional wipe via `types` + `:active-view-transition-type()` |
| API only, no types | older Safari 18.x / Firefox 133–143 range (verify per release) | Directional wipe via `html[data-nav-direction]` attribute selector |
| No `startViewTransition` | anything older | Plain navigation (existing guard) |

Caveat recorded: the Next.js guide notes "some animations may behave differently in Safari." Safari/Firefox rows above are from published data, not local testing — flag for the T016 QA pass on real devices where available.

## T001 — Route paint timings ✅

**Method**: headless Chrome (`--headless=new`, 1440×900, fresh profile) driven over raw CDP
([measure-transitions.mjs](file:///E:/Temp/claude/E--Games-Claude-Material-Collager-Website/4acba19e-3a76-47bc-9341-1bb7e3d143b6/scratchpad/measure-transitions.mjs) in session scratchpad);
headless composites offscreen, so FCP/rAF fire normally. Dev server (vinext/Miniflare), warm server.
The earlier in-app/visible-Chrome attempts were unmeasurable (tab `visibilityState: hidden` — minimized
window suspends paint), so headless is the recorded methodology.

**Document loads** (full page loads):

| Route | Pass | TTFB | FCP | Canvas first frame | Settled |
|---|---|---|---|---|---|
| `/` (Library) | cold | 42 | 288 | **688** | 696 |
| `/` (Library) | warm | 22 | 128 | **761** | 766 |
| `/generator` | cold | 206 | 312 | — | 618 |
| `/generator` | warm | 41 | 104 | — | 459 |
| `/workbench` | cold | 27 | 44 | — | 435 |
| `/workbench` | warm | 19 | 32 | — | 432 |

**SPA navigations** (client-side, warm session; ms from click):

| Journey | Path committed | Double-rAF settle | Canvas frame |
|---|---|---|---|
| `/` → `/generator` | 41 | 47 | — |
| `/generator` → `/workbench` | 22 | 26 | — |
| SPA → `/` (Library re-entry, ×3) | 10–23 | — | **32–60** |

**Conclusions**:
- The legacy ~790 ms figure is real but applies to the Library's *canvas init* (688–761 ms), which is **GL/texture-bound, not chunk-fetch-bound** — warm caches don't reduce it.
- SPA navigation is fast everywhere once the session is warm: routes commit in 10–41 ms and the Library re-enters with a painted canvas in **32–60 ms**. The flat 850 ms hold penalizes every warm navigation to protect one cold case.
- **`READY_BUDGET_MS` = 900** (worst measured canvas init 761 ms + margin). With the route-ready signal, warm cases settle in <100 ms and the budget only caps the first cold entry into the Library.

## T003 — Nav shared-element spike ✅ **GO**

Method: injected `view-transition-name: site-nav` on the nav + 3 s wipe duration, captured mid-transition screenshots headless (baseline vs exempt) — [spike-nav-exemption.mjs](file:///E:/Temp/claude/E--Games-Claude-Material-Collager-Website/4acba19e-3a76-47bc-9341-1bb7e3d143b6/scratchpad/spike-nav-exemption.mjs), PNGs in session scratchpad.

- **No flat-tree clipping glitch**: the exempted nav renders full-width above the clip-path wipe, no duplication, no offset.
- Behavior note: an exempted nav is still *snapshotted* (own group) — during the transition it shows a crossfade between old-active and new-active pill states rather than the live pill slide. Reads as a soft pill morph; acceptable for FR-003. Tuning the `::view-transition-group(site-nav)` duration to match the pill's own timing is Phase 2 CSS work.
- The nav element is `nav.nav-pill-track`, `position: relative` (inside fixed chrome) — the class hook for T013 exists already.

## T004 — Chunk-warming delta ✅ measured, **conclusion revised**

Cold vs warm document loads show canvas init is ~equal (688 vs 761 ms) → **chunk warming cannot close the Library's first-paint gap**; the cost is GL context + texture init, not module fetch. However, SPA re-entry (session-warm scene) paints in 32–60 ms, so the scene graph/GL work is the one-time cost.

**Plan amendment (per plan risk #3)**: keep intent-based warming only as a cheap assist for the *first* entry's module-fetch share; the real mechanism for FR-005/FR-008 is the **route-ready signal + 900 ms budget** — the transition holds until the canvas's first frame (readiness), capped. Pre-mounting the R3F canvas offscreen is explicitly out of scope (bigger change; would need a spec amendment).

## Environment notes (valuable beyond this feature)

1. **`npm run dev` fails out of the box in non-interactive envs**: the Cloudflare Vite plugin (1.47.0) establishes a *remote proxy session* at startup to service the `ai`/`images` bindings; the session handshake hits `material-collager.mlux-db1.workers.dev`, which is behind Cloudflare Access → `user access missing service token non interactive`, exit 1. Workaround used here: `remoteBindings: false` in `vite.config.ts` (temporary, comment marks it). A permanent fix candidate for the repo: gate `remoteBindings` on an env var, or provide Access service-token env vars in dev docs. Contradicts README's "no Cloudflare account needed" claim as of wrangler 4.92/plugin 1.47 — worth a docs/troubleshooting update.
2. **`.dev.vars` did not exist** in this checkout; without it, `worker/access.ts` enforces Access locally and every request 403s. Created with blank `CF_ACCESS_*` overrides (no API keys).
3. **Stale Vite dep cache after config change** produced a two-Reacts crash (`Invalid hook call`, mixed `?v=` hashes). Fix: delete `node_modules/.vite`, restart. Candidate troubleshooting-doc entry.
4. Installed wrangler resolves to 4.92.0 while `package.json` pins 4.114.0 — lockfile/install drift; not blocking, noted.
