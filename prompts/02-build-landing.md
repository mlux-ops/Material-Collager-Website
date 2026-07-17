@Browser @Build Web Apps

Read `AGENTS.md` and the user-approved `docs/reference-spec.md` completely.

Implement ONLY the landing/library experience and its scroll-driven spatial panel field. Preserve the generator route and all generator behavior unchanged in this task.

## Non-negotiable rules

- The approved reference spec is binding.
- Do not use ImageGen.
- Do not create a conventional hero or ordinary card carousel.
- Do not substitute a single static image for the scene.
- Use the approved real assets and fonts.
- Use the architecture selected in `docs/reference-spec.md`.
- Keep the implementation deterministic and testable.
- Do not deploy.

## Required implementation characteristics

1. A full-viewport stage with fixed UI chrome matching the reference.
2. Multiple simultaneously visible media panels distributed through depth.
3. Wheel and trackpad input mapped to normalized scene progress with the approved damping/easing behavior.
4. Touch behavior matching the approved mobile reference.
5. Correct panel entry, exit, scale, overlap, opacity, blur, crop, and render order.
6. Asset preloading and a stable first frame without layout shift.
7. `prefers-reduced-motion` fallback.
8. A development-only deterministic QA mode:

```text
/?qa=1&progress=0.00
/?qa=1&progress=0.20
/?qa=1&progress=0.40
/?qa=1&progress=0.60
/?qa=1&progress=0.80
/?qa=1&progress=1.00
```

The QA mode must freeze the scene at the requested progress so screenshots are repeatable. It must not affect production behavior.

## Verification before stopping

- Start the local development server.
- Use Browser to inspect the implementation at 1440×900, 1280×800, 1024×768, and 390×844.
- Verify normal scrolling as well as every deterministic QA URL.
- Check console errors, network asset failures, resize behavior, and reduced motion.
- Capture implementation screenshots into `artifacts/local/landing-initial/`.
- Write `docs/landing-build-report.md` with the local URL, architecture used, files changed, tests run, screenshot paths, and remaining deviations.

Do not say this matches the reference perfectly. The next task is the dedicated visual-difference loop.
