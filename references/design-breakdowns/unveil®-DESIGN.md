---
version: alpha
name: "Unveil Monochrome Glass"
description: "UNVEIL® is an art/creative studio portfolio with a dramatically minimal monochrome shell. near-white (#fafafa) background, pure black (#000000) text and borders. that recedes entirely to let a cinematic 3D-stacked card gallery dominate the viewport. Navigation is rendered in ultra-small uppercase tracking type (10.5px NB International Pro), and the only structural UI element is a 6px-radius pill-style nav button. The design language is deliberately invisible: no shadows, no fills, no decorative color. only the artwork imagery provides visual richness."
colors:
  off-white-surface: "#fafafa"
  white: "#ffffff"
  black: "#000000"
typography:
  nav-label:
    fontFamily: "nb_international_proregular"
    fontSize: "10.5px"
    fontWeight: "400"
    lineHeight: "11.025px"
    letterSpacing: "0.1575px"
  nav-label-alt:
    fontFamily: "nb_international_proregular"
    fontSize: "10.5px"
    fontWeight: "400"
    lineHeight: "13px"
    letterSpacing: "0.1575px"
  body-ui-text:
    fontFamily: "nb_international_proregular"
    fontSize: "16px"
    fontWeight: "400"
    lineHeight: "24px"
  micro-label:
    fontFamily: "nb_international_proregular"
    fontSize: "8.4px"
    fontWeight: "400"
    lineHeight: "8.82px"
    letterSpacing: "0.1575px"
rounded:
  button-pill: "6px"
spacing:
  xs: "4px"
  sm: "7px"
  md: "10px"
  base: "14px"
  lg: "16px"
  xl: "40px"
  unit: "1.5px"
components:
  button:
    textColor: "{colors.black}"
    backgroundColor: "transparent"
    rounded: "{rounded.button-pill}"
    borderWidth: "0px"
    padding: "40px 10px 7px"
    fontSize: "10.5px"
    fontFamily: "nb_international_proregular"
    boxShadow: "none"
  gallery-glass-card:
    transform: "3D perspective rotation"
    opacity: "variable (glass effect)"
    rounded: "0px"
    boxShadow: "none"
    overflow: "hidden"
  hero-gallery-hero:
    backgroundColor: "transparent"
    textColor: "{colors.black}"
    padding: "0px"
    pointerEvents: "none"
    fontSize: "16px"
    boxShadow: "none"
  navigation-top-nav:
    textColor: "{colors.black}"
    backgroundColor: "transparent"
    rounded: "{rounded.button-pill}"
    fontSize: "10.5px"
    fontFamily: "nb_international_proregular"
    padding: "40px 10px 7px"
    boxShadow: "none"
    borderWidth: "0px"
  view-toggle-toggle-bar:
    backgroundColor: "{colors.off-white-surface}"
    textColor: "{colors.black}"
    rounded: "{rounded.button-pill}"
    fontSize: "10.5px"
    fontFamily: "nb_international_proregular"
---

## Overview

UNVEIL® is an art/creative studio portfolio with a dramatically minimal monochrome shell. near-white (#fafafa) background, pure black (#000000) text and borders. that recedes entirely to let a cinematic 3D-stacked card gallery dominate the viewport. Navigation is rendered in ultra-small uppercase tracking type (10.5px NB International Pro), and the only structural UI element is a 6px-radius pill-style nav button. The design language is deliberately invisible: no shadows, no fills, no decorative color. only the artwork imagery provides visual richness.

**Signature traits:**
- Tight geometric corners: Near-square geometry with corner radii capped around 6px.
- Monochrome palette: Relies entirely on neutral tones with no chromatic accent.

## Colors

The palette uses 3 validated color tokens across 1 theme profile. Semantic roles stay attached to observed usage so generation agents can choose accents without inventing new color meaning.

**Semantic naming:**
- **action-text** maps to `black`: Role "text" is grounded by usage context "All text, nav labels, button borders, link color — the sole foreground color across the entire UI".
- **surface-background** maps to `white`: Role "background" is grounded by usage context "Primary surface and page background".

### Text Scale
- **Black** (#000000): All text, nav labels, button borders, link color — the sole foreground color across the entire UI. Role: text. {authored: rgb(0, 0, 0), space: rgb}

### Surface & Shadows
- **Off-White Surface** (#fafafa): Secondary surface tone used in header/nav area, near-white canvas. Role: background. {authored: rgb(250, 250, 250), space: rgb}
- **White** (#ffffff): Primary surface and page background. Role: background. {authored: rgba(255, 255, 255, 0.7), space: rgb, alpha: 0.7}

## Typography

Typography uses nb_international_proregular across extracted hierarchy roles. Keep hierarchy mapped to these token rows before adding decorative type styles.

Uses nb_international_proregular throughout for a uniform feel. Sizes range from 8.4px to 16px.

### Font Roles
- **Headline Font**: nb_international_proregular
- **Body Font**: nb_international_proregular

### Type Scale Evidence
| Role | Font | Size | Weight | Line Height | Letter Spacing | Stack / Features | Notes |
|------|------|------|--------|-------------|----------------|------------------|-------|
| Primary navigation and button labels — uppercase micro-type with tracked letter-spacing | nb_international_proregular | 10.5px | 400 | 11.025px | 0.1575px | nb_international_proregular | Extracted token |
| Alternate nav label line-height variant | nb_international_proregular | 10.5px | 400 | 13px | 0.1575px | nb_international_proregular | Extracted token |
| General UI text, nav container, list items, hero section text | nb_international_proregular | 16px | 400 | 24px | normal | nb_international_proregular | Extracted token |
| Smallest label tier — metadata or fine-print annotations | nb_international_proregular | 8.4px | 400 | 8.82px | 0.1575px | nb_international_proregular | Extracted token |

## Layout

Responsive system uses 2 breakpoint tier(s): tablet, desktop.

This system uses a 4px base grid with scale values 1.5, 4, 7, 10, 14, 16, 40.

### Responsive Strategy
- **tablet (>= 640px)**: Increase spacing and column structure for medium-width viewports.
- **desktop (Unknown)**: Expand layout density and horizontal composition for wide viewports.

### Spacing System
| Token | Value | Px | Notes |
|------|-------|----|-------|
| unit | 1.5px | 1.5 | Extracted spacing token |
| xs | 4px | 4 | Extracted spacing token |
| sm | 7px | 7 | Extracted spacing token |
| md | 10px | 10 | Extracted spacing token |
| base | 14px | 14 | Extracted spacing token |
| lg | 16px | 16 | Extracted spacing token |
| xl | 40px | 40 | Extracted spacing token |

## Elevation & Depth

Keep depth flat unless validated shadow or interaction evidence appears in the extraction payload. Do not invent shadows beyond this evidence boundary.

### Shadow Evidence
| Shadow Token | Layers | Details |
|--------------|--------|---------|
| n/a | 0 | No validated shadow payload |

### Interaction Signals
| Theme | Signal | Evidence |
|-------|--------|----------|
| Light | backdrop-filter | blur(24px) ; blur(40px) |
| Light | outline-color | rgb(0, 0, 0) |
| Light | outline-width | 3px |
| Light | outline-offset | 0px |

## Shapes

Shape language maps directly to rounded tokens. Keep component corners consistent with the role mapping below before introducing bespoke geometry.

### Radius Roles
| Token | Value | Px | Role Mapping |
|------|-------|----|--------------|
| Button / Pill | 6px | 6 | Subtle corner |

### Geometry Evidence
| Radius Token | Shape | Units |
|--------------|-------|-------|
| Button / Pill | 6px | px |

## Components

Components should be recreated from token references first, then tuned with variant notes and probe-backed state guidance.
- **Navigation Bar**: Horizontal top nav with brand mark on the left and section links (RESEARCH, STUDIO, CONTACT) rendered as pill-shaped button links. All items use 10.5px NB International Pro uppercase tracking type with transparent background and 6px border-radius.
- **Project Card Stack**: 3D-perspective stacked image cards arranged in a diagonal cascade across the viewport. Cards appear as semi-transparent glass panels layered in depth, each containing full-bleed artwork imagery. No visible text overlays on cards.
- **Nav Button / Link**: Pill-shaped navigation links used for both anchor tags and button elements. Transparent fill, black text, 6px border-radius, generous top padding (40px) creating a tab-like hit area.
- **Hero Section**: Full-viewport hero section containing the 3D card gallery. pointer-events-none on the section element suggests the gallery is purely visual/decorative with interaction handled by overlaid elements.
- **Overview / Index Toggle**: Bottom-right toggle control with two states: OVERVIEW and INDEX. Rendered as a small pill/tab bar with black text on near-white background, 6px radius.

### Button

**Default**
- textColor: #000000
- backgroundColor: transparent
- rounded: 6px
- borderWidth: 0px
- padding: 40px 10px 7px
- fontSize: 10.5px
- fontFamily: nb_international_proregular
- boxShadow: none
- State guidance: Probe-confirmed via button.button and a.button selectors. Padding asymmetry (40px top, 7px bottom) suggests tab-style underline or drop-zone interaction area.

### Gallery

**Glass Card**
- transform: 3D perspective rotation
- opacity: variable (glass effect)
- rounded: 0px
- boxShadow: none
- overflow: hidden
- State guidance: Visually confirmed from screenshot — stacked translucent panels with artwork. No probe-backed computed styles for card elements directly.

### Hero

**Gallery Hero**
- backgroundColor: transparent
- textColor: #000000
- padding: 0px
- pointerEvents: none
- fontSize: 16px
- boxShadow: none
- State guidance: Probe-confirmed via section.pointer-events-none. The gallery imagery provides all visual richness; the section shell is invisible.

### Navigation

**Top Nav**
- textColor: #000000
- backgroundColor: transparent
- rounded: 6px
- fontSize: 10.5px
- fontFamily: nb_international_proregular
- padding: 40px 10px 7px
- boxShadow: none
- borderWidth: 0px
- State guidance: Probe-confirmed: nav.flex and nav.text-11 both show transparent bg, black text, 0 border-width. Button/link elements share 6px radius and 40px 10px 7px padding.

### View Toggle

**Toggle Bar**
- backgroundColor: #fafafa
- textColor: #000000
- rounded: 6px
- fontSize: 10.5px
- fontFamily: nb_international_proregular
- State guidance: Visually confirmed from screenshot bottom-right. Background matches #fafafa surface token.

## Do's and Don'ts

Guardrails protect Tight geometric corners, Monochrome palette without adding unsupported visual claims.

| Do | Don't |
|----|---------|
| Do maintain consistent spacing using the base grid | Don't make unsupported claims about absent visual features |
| Do maintain WCAG AA contrast ratios (4.5:1 for normal text) | Don't mix rounded and sharp corners in the same view |
| Do use the primary color only for the single most important action per screen |  |
| Do verify evidence before writing new design-system guidance |  |

## Responsive Evidence

### Breakpoints
| Name | Width | Key Changes |
|------|-------|-------------|
| Mobile | >= 640px | (min-width: 640px) |
| Tablet | >= 768px | (min-width: 768px) |
| Breakpoint 3 | Unknown | (hover: hover) |

## Agent Prompt Guide

### Example Component Prompts
- Create Hero Section variant that preserves Full-viewport hero section containing the 3D card gallery. pointer-events-none on the section element suggests the gallery is purely visual/decorative with interaction handled by overlaid elements..
- Create Nav Button / Link variant that preserves Pill-shaped navigation links used for both anchor tags and button elements. Transparent fill, black text, 6px border-radius, generous top padding (40px) creating a tab-like hit area..
- Create Navigation Bar variant that preserves Horizontal top nav with brand mark on the left and section links (RESEARCH, STUDIO, CONTACT) rendered as pill-shaped button links. All items use 10.5px NB International Pro uppercase tracking type with transparent background and 6px border-radius..

### Iteration Guide
1. Start with extracted palette and typography roles only.
2. Map spacing and radius directly from token tables before visual polish.
3. Apply component patterns one section at a time and compare against source intent.
4. Keep elevation claims tied to explicit evidence in output.
5. Iterate with smallest diffs and re-check section hierarchy after each change.
