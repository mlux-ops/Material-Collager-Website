@Browser @Build Web Apps

Read `AGENTS.md`. The landing page must already be approved before this task begins.

This is a SEPARATE product-interface redesign for the generator. The Unveil reference supplies art direction and shared brand language, not the generator's information architecture.

## Phase 1 — behavior inventory, no styling changes

Inspect the existing generator and document every function in `docs/generator-behavior-inventory.md`, including:

- navigation and routes;
- board setup controls;
- reference item add/remove/replace flows;
- primary/alternate views;
- image analysis review;
- item details;
- collage preview;
- quick draft and review prompt;
- save/restore behavior;
- loading, error, empty, and disabled states;
- responsive behavior;
- keyboard and accessibility behavior.

Do not edit code during this phase.

## Phase 2 — approved full-screen design concept

Create one complete desktop concept and one mobile/tablet concept for the entire generator, not just a header or a few cards. ImageGen may be used for this redesign only, because this is not an exact copy task. The concept must preserve all documented functions.

Design goals:

- professional architectural/material-specification workspace;
- strong hierarchy and clear zones;
- restrained warm material palette rather than pure black-and-white;
- generous but efficient density;
- readable typography at working scale;
- references treated as visual material samples, not generic cards;
- clear primary actions and states;
- minimal one-pixel boxing;
- no repeated black-button treatment for every action;
- no generic SaaS dashboard look.

Stop and request user approval of the complete concepts before implementation.

## Phase 3 — implementation after approval

After explicit approval, implement the accepted concept without changing business logic. Run browser regression checks for every item in `docs/generator-behavior-inventory.md`. Capture screenshots at 1440×900, 1280×800, 1024×768, and 390×844. Record all results in `docs/generator-qa.md`.

Do not deploy in this task.
