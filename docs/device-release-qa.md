# Device and browser release QA

Status: **prepared; execution pending on the private staging release candidate.**

Use the exact release-candidate commit and a populated staging Library. Store evidence under `artifacts/release-qa/<YYYY-MM-DD>/`.

## Common evidence

Record for every run:

- tester and date;
- release-candidate commit;
- private staging URL;
- device model and available memory/storage context;
- operating-system and browser versions;
- portrait/landscape or viewport dimensions;
- reduced-motion setting;
- pass, fail, or blocked result for every check;
- screenshots or a short recording for failures and recovery behavior.

## iPhone Safari — required physical-device gate

A physical iPhone is available. Record:

- iPhone model;
- iOS version;
- Safari version shown by the iOS build;
- network type and whether the run is cold-cache or warm-cache.

Run this matrix:

| Area | Checks |
|---|---|
| Library | Populated Library count and order; image load; preview; download; removal permission/error; 30-second polling; no fixture promotion |
| Scene | Scene/Index toggle; tap; drag; selection; deselection; direct preview; Close; no accidental page zoom or browser gesture conflict |
| Orientation | Portrait start; rotate to landscape; rotate back; safe-area and fixed controls remain usable |
| Navigation | Reload; hard reload where available; back/forward history; background Safari and restore it |
| Accessibility | VoiceOver labels where practical; 44px touch targets; reduced motion; text remains legible with larger text settings |
| Resilience | Slow network; broken preview; background/foreground restoration; memory-pressure return; WebGL loss/recovery where testable |
| Evidence | Screenshots or short recording; notes for console inspection through a connected Mac if available |

A failure that loses textures, freezes input, makes controls unreachable, or cannot recover after returning to Safari blocks release.

## Android Chrome — final gate pending

No physical Android device is currently available. Close this gate using either:

1. a borrowed physical Android phone; or
2. a cloud-hosted **real Android device** with Chrome.

An emulator may be used for preliminary layout and interaction checks, but emulator-only evidence is not final acceptance.

Record:

- physical, cloud real-device, or emulator classification;
- device model;
- Android version;
- Chrome version;
- GPU/WebGL renderer if the service exposes it.

Run the same Library, Scene, orientation, navigation, reduced-motion, broken-preview, memory, and context-recovery matrix used for iPhone. Explicitly verify Chrome's back gesture, address-bar resize behavior, and background-tab restoration.

## Desktop Chrome on Windows

Record:

- Windows version;
- Chrome version;
- GPU renderer from `chrome://gpu` or equivalent evidence;
- monitor resolution and scaling;
- release-candidate commit and staging URL.

Required checks:

| Area | Checks |
|---|---|
| Populated data | Library count/order, preview, download, removal, polling, reload, back/forward |
| Interaction | Mouse drag, trackpad wheel, keyboard navigation, Scene/Index, selection and Close |
| Zoom | 100%, 125%, and 150%; fixed controls remain reachable and text does not overlap |
| Accessibility | Reduced motion; forced colors; keyboard focus; semantic collection; error and loading announcements |
| Resilience | Slow API/image; broken preview; WebGL context loss and restore; resize; hard reload |
| Performance | Three separate 10-second warm-cache motion runs with long tasks, frame timing, and GPU data captured |

## Three.js and driver warnings

During context loss and restoration, record whether the two previously observed texture-upload warnings return.

The warning becomes a code-fix blocker when any of the following is true:

- a texture remains missing after restoration;
- the scene stops moving or accepting input;
- the fallback UI does not appear during loss;
- restoration requires a page reload;
- warnings increase across repeated restore cycles;
- memory or GPU use continues growing after the scene stabilizes.

A warning with complete visual and interaction recovery remains documented evidence, not an automatic pass. Final GPU acceptance still requires the release-candidate run.

## Acceptance summary

Public release requires:

- physical iPhone Safari pass;
- physical or cloud real-device Android Chrome pass;
- desktop Chrome pass, including three performance runs;
- no unresolved S0/S1 failure;
- a populated Library validation report that passes in release mode.
