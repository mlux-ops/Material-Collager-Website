# Material Collager — Frontend Fidelity Rules

Standing rules for frontend visual and interaction work. Build/test/deploy context
lives in `CLAUDE.md`.

## Standard

The landing page reproduces the approved spatial, scroll-driven reference behavior at
agency-level fidelity. The generator is a functional professional material-composition
workspace and must not be treated as a generic landing page. Both constraints hold for
any change, not just a rebuild.

## Source-of-truth order

When references conflict, use this order:

1. Approved screen recording and extracted frames in `references/`
2. Browser inspection of the live reference URL
3. Approved `docs/reference-spec.md`
4. Approved screenshots
5. Design breakdown files and design tokens
6. Existing application behavior and data requirements
7. Prompt prose

Never claim the live reference was inspected unless Browser actually opened it and the
inspection evidence is recorded.

## Verification workflow

For any change to the landing experience or generator UI:

1. Run the app locally and inspect it with Browser.
2. Capture deterministic screenshots and compare them with reference states.
3. Record discrepancies in `docs/visual-qa.md` and fix them.
4. Do not deploy until the user approves the local build.

## Exact-reference rules for the landing page

- Do not use ImageGen to reinterpret the landing page.
- Do not invent a hero, feature grid, CTA strip, testimonial section, statistics, badges, pills, or marketing copy.
- Do not replace the spatial panel field with one large static image, a carousel component, or ordinary cards.
- Do not use default Inter/system typography when the reference specifies another face.
- Do not substitute gradients for missing assets.
- Do not flatten depth into box shadows.
- Reproduce composition, camera/perspective, panel geometry, overlap, opacity, blur, crop, motion, easing, and fixed UI chrome.
- Use the real approved project imagery and fonts when licensing permits.
- Preserve a reduced-motion fallback without changing the normal reference behavior.

### Deterministic QA scene state

`app/hooks/useSceneLabQA.ts` implements the frozen-state contract used for visual
comparison. Preserve it and its parameter names:

| Param | Effect |
|---|---|
| `qa=1` | Enables QA mode; required by every other param |
| `progress=0..1` | Sets scroll progress, clamped |
| `anchor=<name>` | Jumps to a named anchor and **freezes** the scene |
| `render=world` | World-space debug rendering |
| `failTexture=<track>` | Forces a texture-load failure for fallback testing |

Example: `?qa=1&progress=0.35`.

## Rendering architecture (decided)

The panel field is **React Three Fiber / Three.js** on a full-viewport WebGL canvas,
with semantic React DOM for chrome, navigation, view controls, loading state,
accessible equivalents, focus management, and reduced-motion mode. Full rationale and
the WebGL rendering contract are in `docs/reference-spec.md` §9.

DOM + CSS 3D was evaluated and rejected for the field: a large continuously moving
transparent texture stack has less predictable depth sorting, crop, and depth softness,
and diverges from the observed renderer. Do not reopen this without evidence that
contradicts the recorded spike results — and do not migrate frameworks as a workaround
for an R3F problem; fall back to direct Three.js instead.

## Existing functionality

- Preserve all generator functions, state, uploads, reference items, review controls, draft behavior, and routes.
- The interaction inventory is `docs/workbench-interaction-inventory.md`. Consult it before changing the generator, keep it current, and write regression checks for anything you touch.
- Do not rewrite working state management or data logic solely for styling convenience.
- Do not redesign the generator in the same task as the landing interaction.

## Generator design rules

The Unveil reference is art direction, not an information architecture template for the
generator.

- The generator needs a dedicated approved full-screen design concept.
- Retain a clear setup rail, reference workspace, and review/output region only if usability analysis supports them.
- Create hierarchy using typography, grouping, proportion, imagery, restrained material color, and state treatment—not only black borders and whitespace.
- Avoid default browser controls where custom controls are needed, but preserve accessibility and keyboard behavior.
- Avoid excessive one-pixel boxes, tiny labels, undifferentiated panels, and repeated black buttons.
- Do not call a monochrome restyle a redesign.

## Browser and visual QA

Required viewports unless the approved spec states otherwise:

- 1440 × 900
- 1280 × 800
- 1024 × 768
- 390 × 844

Required landing scene states: progress 0.00, 0.20, 0.40, 0.60, 0.80, 1.00.

At each state, compare:

- panel count and visible depth layers
- panel bounding boxes and crop
- scale, rotation, opacity, blur, and z-order
- fixed navigation position
- typography metrics
- background and border colors
- scroll response and easing

A task may not be declared complete while any high-severity visual, interaction,
responsive, or functionality discrepancy remains.

## Completion report

Every implementation task must end with:

- files changed;
- commands run;
- local URL;
- Browser screenshots produced;
- discrepancies fixed;
- remaining known deviations;
- tests performed;
- confirmation that no deployment occurred unless explicitly requested.

If Browser, the live reference, a font, an asset, or the screen recording is
inaccessible, stop and report that specific blocker. Do not fabricate fidelity.
