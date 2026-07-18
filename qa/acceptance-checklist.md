# Acceptance Checklist

## Landing — composition

- [ ] The first viewport reads as one spatial composition, not a webpage made of stacked sections.
- [ ] Multiple panels are visible at different apparent depths.
- [ ] The focal panel, secondary panels, and distant panels match approved geometry.
- [ ] No giant empty region exists unless it is present in the approved reference.
- [ ] No single static hero image substitutes for the scene.
- [ ] Fixed navigation and labels match placement and scale.

## Landing — motion

- [ ] Wheel input advances the scene.
- [ ] Trackpad input feels continuous and damped rather than stepping.
- [ ] Reverse scrolling reverses the scene cleanly.
- [ ] Touch movement works on mobile.
- [ ] Entry and exit paths match the recording.
- [ ] Scale, rotation, opacity, blur, and overlap change correctly through progress.
- [ ] The page does not appear non-scrollable or frozen.
- [ ] No scroll-jank, runaway velocity, or snapping occurs unless reference behavior requires it.

## Landing — fidelity

- [ ] Correct fonts load; computed styles confirm the intended families and weights.
- [ ] Image crops match.
- [ ] Background, border, and panel colors match.
- [ ] Transparency and blur match.
- [ ] QA-mode screenshots exist for all required viewports and progress values.
- [ ] `docs/visual-qa.md` contains no unresolved P0/P1 items.

## Landing — engineering

- [ ] No console errors.
- [ ] No failed asset requests.
- [ ] Textures/images are preloaded or progressively handled without severe layout shift.
- [ ] Resize behavior is stable.
- [ ] Reduced-motion mode exists.
- [ ] Links and focus states remain accessible.
- [ ] The generator route and behavior were not changed during landing implementation.

## Generator — design

- [ ] A complete concept was approved before implementation.
- [ ] The interface is not merely the old layout with more whitespace and less color.
- [ ] Visual hierarchy clearly separates setup, reference work, and review/output.
- [ ] Material imagery is prominent and legible.
- [ ] Controls have clear priority and states.
- [ ] Typography is readable at real working scale.
- [ ] Repeated borders and black buttons have been rationalized.
- [ ] Empty, loading, error, disabled, and success states are designed.

## Generator — function

- [ ] All pre-redesign behaviors are documented.
- [ ] Add/remove/replace reference flows work.
- [ ] Alternate views work.
- [ ] Image-analysis review works.
- [ ] Collage generation and preview work.
- [ ] Save/restore draft works.
- [ ] Responsive and keyboard behavior work.
- [ ] No data/state regression is introduced.

## Release

- [ ] Local production build passes.
- [ ] Approved screenshots are archived.
- [ ] A release commit exists.
- [ ] A Sites version was saved and reviewed before deployment.
- [ ] User explicitly approved deployment.
