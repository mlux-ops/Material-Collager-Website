# Generator (`/generator`) — full-screen design concept

Status: **proposal, awaiting approval.** Nothing here is implemented.

`AGENTS.md` states the generator "needs a dedicated approved full-screen design
concept." This is that concept. Scope is `/generator` only. `/workbench` has its
own document (`docs/workbench-node-editor-design.md`) and is out of scope, per
the rule against redesigning two surfaces in one task.

## 1. What exists today (measured, not assumed)

The generator renders from `app/generator/page.tsx` (2,062 lines) styled entirely
from `app/globals.css` (3,428 lines) via hand-named semantic classes. There are
no CSS Modules and no Tailwind utilities in the page's JSX, though Tailwind is
imported as a base layer at `globals.css:1`.

Effective layout comes from `.generator-shell .workbench` (`globals.css:2957`),
which beats two earlier unscoped `.workbench` rules (`globals.css:141` and
`:1427`) on specificity. It is a fixed-height three-column app shell:

```
grid-template-columns: 232px minmax(590px, 1fr) minmax(455px, 540px);
height: calc(100dvh - 66px);
gap: 0;
```

**The generator has already been restyled monochrome.** A `--mono-*` token family
was added at `globals.css:2544-2548` — `#000000`, `#ffffff`, `#fafafa`, and two
translucent black rules — and is referenced 98 times. The older chromatic tokens
(teal `--accent` `#28685b`, `--blue` `#345f80`) survive underneath at 22
references. 122 `.generator-shell`-scoped rules sit on top of the original
system.

Two consequences follow, and both are things `AGENTS.md` explicitly warns about:

- **Separation is carried by hairlines.** `gap: 0` plus a comment at
  `globals.css:2959` stating that separation "comes from 1px rules on each
  surface." There are ~41 `border: 1px solid` declarations. This is the
  "excessive one-pixel boxes … undifferentiated panels" failure mode by name.
- **Two token systems coexist.** 98 monochrome references against 22 chromatic
  ones is not a palette; it is a half-finished migration.

### Typography is the most serious defect

Counting size declarations in `globals.css`, sub-12px text is not an accent —
it is the dominant size in the product:

| Size | Declarations |
|---|---|
| 10px | 34 |
| 11px | 22 |
| 9px | 19 |
| 12px | 12 |
| 8px | 5 |

That is 80 declarations below 12px against 12 at 12px. Larger sizes
(18–30px) appear only a handful of times. `AGENTS.md` names "tiny labels" as a
thing to avoid; this quantifies it.

There is a concrete mobile consequence. `AGENTS.md` requires the 390 × 844
viewport. iOS Safari auto-zooms the page when a focused input's font-size is
below 16px, so at 10–11px every text field in the generator will zoom-and-pan on
an iPhone. That is a functional bug, not only an aesthetic one.

### One accessibility defect

`globals.css:2614-2630` sets `outline: none` on `.site-navigation nav a` for
`:focus-visible`, substituting only a background/color swap. That is in the
shared `SiteNavigation` imported at `page.tsx:8`, so it affects every page, not
just the generator. Otherwise the markup is in good shape: 19 real `<label>`
elements, `aria-label` on icon-adjacent controls, no placeholder-only inputs, and
status pills that pair color with text rather than relying on color alone.

## 2. Design intelligence consulted, and what was rejected

The `ui-ux-pro-max` skill was queried for this concept. Most of its
product-level output does not fit and was **not** applied:

- **"Hero + Features + CTA + Footer"** page pattern — returned by both
  `--design-system` runs. The generator is a working tool, and `AGENTS.md`
  explicitly forbids inventing "a hero, feature grid, CTA strip." The skill has
  no application-workspace pattern; its aggregate always resolves to a landing
  page.
- **Claymorphism / Fredoka / Nunito / purple `#7C3AED`** — the first run's
  answer, profiled for "children's apps, playful, toy-like." Wrong register for a
  professional interior-design tool, and the Google Fonts CDN import conflicts
  with Inter being self-hosted from `app/fonts/`.
- **Swiss-minimal navy-and-slate** — the second run's answer. Appropriate in
  register, but it is functionally another near-monochrome system with `#E2E8F0`
  hairlines, which is the failure mode the generator is already in.

What the skill contributed usefully: its accessibility and forms guidance
(visible labels, focusable error summary linked to invalid fields, inline
validation on blur, loading-then-result feedback on submit) and its baseline
that body text below 12px is an anti-pattern. Those are folded in below.

## 3. Principles

`AGENTS.md` requires hierarchy from "typography, grouping, proportion, imagery,
restrained material color, and state treatment — not only black borders and
whitespace." That is the whole brief, and it is currently inverted.

1. **The material imagery is the color.** Tile, stone, metal, and timber
   references supply the chroma. Chrome stays near-neutral so it never competes
   with the work — but near-neutral means a warm low-chroma neutral, not
   `#000000` hairlines on `#fafafa`.
2. **Separate surfaces tonally, not with hairlines.** Three tonal steps plus
   spacing replace most of the 41 borders. Reserve a rule for genuine dividers
   where two surfaces genuinely abut.
3. **Type carries hierarchy.** Weight, size, and letterspacing do the work that
   boxes currently do.
4. **Color is reserved for state.** Ready, running, stale, failed. Because the
   chrome is neutral, a small amount of chroma reads instantly.
5. **Dense, not cramped.** This is a professional control surface. Density is
   correct; 9px text is not.

## 4. Proposed type scale

Floor of 11px, and only for true micro-labels. Nothing below it.

| Role | Size / weight | Notes |
|---|---|---|
| Micro label, kicker | 11px / 600, +0.06em, uppercase | Replaces all 8–10px use |
| Secondary, meta | 12px / 450 | |
| Body, controls | 14px / 450 | |
| **Form inputs** | **16px** | Non-negotiable: prevents iOS zoom-on-focus |
| Section heading | 18px / 600 | |
| Board title | 24px / 600 | |

Migrating 80 sub-12px declarations is the single highest-impact change and can
ship independently of everything else.

## 5. Proposed surfaces

Replace the mono set with a warm neutral ramp. Indicative values, to be tuned
against real board imagery:

| Token | Value | Use |
|---|---|---|
| `--surface-base` | `#F4F3F0` | App background |
| `--surface-raised` | `#FBFAF8` | Rail, output panel |
| `--surface-inset` | `#EDEBE6` | Wells, drop targets, empty states |
| `--rule` | `rgba(28,26,22,0.10)` | Genuine dividers only |
| `--ink` | `#1C1A16` | Primary text — warm near-black, not `#000` |
| `--ink-muted` | `#6B665C` | Secondary text |

State colors stay restrained and must each clear 4.5:1 on `--surface-raised`:
ready/success, running/working, stale, failed. The existing teal `#28685b` is a
reasonable starting point for the accent and already has equity in the product.

## 6. Layout

The three-column shell (rail / workspace / output) is sound and should stay —
it matches the mental model of setup, compose, review. Changes:

- Give the columns real gutters instead of `gap: 0`, letting `--surface-base`
  show through as the separator that the current comment at `globals.css:2959`
  explicitly rejected. That comment describes a symptom of a black background
  bleeding through; with a warm neutral base it is no longer a "black void."
- Keep `height: calc(100dvh - 66px)` and independent column scrolling.
- Preserve the existing responsive collapse; verify the 1041–1080px band, where
  the two-column minimums (590 + 455) plus gutters may exceed the viewport
  before the collapse breakpoint fires.

## 7. Consolidate the two token systems

Whichever palette is approved, the `--mono-*` family and the older chromatic
tokens must not both survive. 122 `.generator-shell` rules are the migration
surface. This is the change that makes the result a redesign rather than another
restyle.

## 8. Sequencing

1. Type scale, including 16px inputs. Independent, highest impact, low risk.
2. Restore the focus ring in `SiteNavigation` (`globals.css:2614-2630`).
3. Surface ramp and token consolidation.
4. Gutters and layout refinements.
5. Forms pass: focusable error summary linked to invalid fields, validation on
   blur, explicit loading-then-result feedback on generate.

## 9. Verification required before this is called done

Per `AGENTS.md`: run locally, inspect with Browser, capture screenshots at
1440×900, 1280×800, 1024×768, and 390×844, record discrepancies in
`docs/visual-qa.md`, and confirm `npm run test:workbench` still passes. The 390
× 844 pass must specifically confirm that focusing a text input no longer zooms.

## 10. Open questions for approval

1. Warm neutral ramp as proposed, or a cooler one?
2. Keep teal `#28685b` as the state accent, or choose a new one?
3. Is 11px an acceptable micro-label floor, or should it be 12px?
4. Should this ship incrementally by the sequencing above, or land as one change?
