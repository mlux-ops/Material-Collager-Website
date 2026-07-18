# Material Collager — Frontend Fidelity Rules

## Binding objective

Rebuild the Material Collager frontend with agency-level visual and interaction fidelity. The landing page must reproduce the approved spatial, scroll-driven reference behavior. The generator must remain a functional professional material-composition workspace and must not be treated as a generic landing page.

## Source-of-truth order

When references conflict, use this order:

1. Approved screen recording and extracted frames in `references/`
2. Browser inspection of the live reference URL
3. Approved `docs/reference-spec.md`
4. Approved screenshots
5. Design breakdown files and design tokens
6. Existing application behavior and data requirements
7. Prompt prose

Never claim the live reference was inspected unless Browser actually opened it and the inspection evidence is recorded.

## Mandatory workflow

1. Analyze first. Do not edit application code during the reference-audit task.
2. Produce `docs/reference-spec.md` and obtain user approval.
3. Implement the landing experience as a vertical slice before redesigning the generator.
4. Run the app locally and inspect it with Browser.
5. Capture deterministic screenshots and compare them with reference states.
6. Record discrepancies in `docs/visual-qa.md` and fix them.
7. Do not deploy until the user approves the local build.

## Exact-reference rules for the landing page

- Do not use ImageGen to reinterpret the landing page.
- Do not invent a hero, feature grid, CTA strip, testimonial section, statistics, badges, pills, or marketing copy.
- Do not replace the spatial panel field with one large static image, a carousel component, or ordinary cards.
- Do not use default Inter/system typography when the reference specifies another face.
- Do not substitute gradients for missing assets.
- Do not flatten depth into box shadows.
- Reproduce composition, camera/perspective, panel geometry, overlap, opacity, blur, crop, motion, easing, and fixed UI chrome.
- Use the real approved project imagery and fonts when licensing permits.
- Add a development-only deterministic scene state, such as `?qa=1&progress=0.35`, so visual comparisons can be frozen at exact positions.
- Preserve a reduced-motion fallback without changing the normal reference behavior.

## Architecture decision

Do not choose a rendering stack from habit. In `docs/reference-spec.md`, explicitly choose and justify one of:

- DOM + CSS 3D transforms
- React Three Fiber / Three.js
- another approach supported by evidence

Use CSS 3D when panels need normal DOM semantics and the effect can be reproduced with perspective transforms. Use WebGL when the recording shows texture-plane behavior, depth compositing, shader-like blur/distortion, or camera motion that CSS cannot faithfully reproduce.

## Existing functionality

- Preserve all generator functions, state, uploads, reference items, review controls, draft behavior, and routes.
- Before changing the generator, inventory all existing interactions and write regression checks.
- Do not rewrite working state management or data logic solely for styling convenience.
- Do not redesign the generator in the same task as the landing interaction.

## Generator design rules

The Unveil reference is art direction, not an information architecture template for the generator.

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

Required landing scene states:

- progress 0.00
- progress 0.20
- progress 0.40
- progress 0.60
- progress 0.80
- progress 1.00

At each state, compare:

- panel count and visible depth layers
- panel bounding boxes and crop
- scale, rotation, opacity, blur, and z-order
- fixed navigation position
- typography metrics
- background and border colors
- scroll response and easing

A task may not be declared complete while any high-severity visual, interaction, responsive, or functionality discrepancy remains.

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

If Browser, the live reference, a font, an asset, or the screen recording is inaccessible, stop and report that specific blocker. Do not fabricate fidelity.
