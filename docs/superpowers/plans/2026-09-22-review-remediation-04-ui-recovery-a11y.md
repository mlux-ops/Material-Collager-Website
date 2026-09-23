# Review Remediation — Phase 3: UI Recovery and Accessibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the verified UI defects without changing the approved art direction. That means R13 truthful reference messaging, R14 modal focus, R15 chunk-failure recovery, R16 field labels, R17 Cancel, R18 delete confirmation, R19 the library fetch deadline, R20 the clipped help bubble, and three one-line lab/list fixes.

**Architecture:** Surgical edits in four work packages, split by page as `AGENTS.md` requires. The generator is not redesigned in the same task as the landing interaction.
- **WP-3A:** Review boards.
- **WP-3B:** Workbench.
- **WP-3C:** Generator.
- **WP-3D:** Landing and labs.

One new hook, `useModalFocus`, handles modal keyboard containment. One pure helper, `compressedReferenceCount`, gets a unit test. No test in this repo renders a React component, so everything else is verified in the running app through the Browser preview.

**Tech Stack:** React 19, CSS in `app/globals.css` and CSS Modules, and the Browser preview tool (`preview_start {name: "material-collager-dev"}`, port 3000).

**Inherits:** every rule in `2026-09-22-review-remediation-00-overview.md → Global Constraints`, especially **UI fidelity**. Requires Phase 1's WP-1B before WP-3A, since both edit review-board components.

**Model routing:**

| WP | Model |
|---|---|
| WP-3A | Haiku 4.5 |
| WP-3B | Sonnet 5 (R14 needs judgment) |
| WP-3C | Sonnet 5 (CSS must be measured, not guessed) |
| WP-3D | Haiku 4.5 |

No Opus review is needed. Each WP's browser check is the gate, plus a Sonnet spec check.

## Global Constraints

- **Measure the running app.** Before and after any CSS-affecting change (WP-3C), record the computed styles named in the task with `javascript_tool`. They must match unless the task says otherwise. The `.generator-shell` block near the end of `globals.css` overrides earlier rules, so the source is not the source of truth.
- The live scale is 8.4px uppercase labels/buttons, 10px sub, 11px body/controls and 14px headings; nothing is above 14px. Chrome text is black or `#657069`; teal is reserved for state. Corners stay square.
- **Preview setup (once per session):** `.dev.vars` must blank `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` (see `.dev.vars.example`), or every page answers 403. Then run `preview_start {name: "material-collager-dev"}`. Prefer `read_page`, `find` and `javascript_tool` over screenshots, and take one screenshot per WP as proof.
- **Native dialogs** (`window.prompt`, `window.confirm`) can't be clicked in the preview. Stub them with `javascript_tool` before triggering, for example `window.confirm = () => false`.
- CSS-affecting changes (WP-3C) get the four-viewport check (1440×900, 1280×800, 1024×768, 390×844) via `resize_window`. Reset with `preset: "desktop"` afterwards, and append a dated entry to `docs/visual-qa.md` in that file's existing format.
- No paid calls. R13's wording is unit-tested; nobody runs a Final render to see it.

## File Structure

| File | WP | Change |
|---|---|---|
| `app/components/review-boards/ReviewBoards.tsx` | 3A | `remove` confirms first |
| `app/components/workbench/GraphManager.tsx` | 3B | Cancel returns early; the dialog uses `useModalFocus` |
| `app/workbench/page.tsx` | 3B | Explicit loading/failed state; Reload action |
| `app/components/workbench/useModalFocus.ts` (new) | 3B | Initial focus, Tab containment, optional Escape, focus restore |
| `app/components/workbench/WorkbenchApp.tsx` | 3B | `TemplateGallery` and `ExportDialog` use the hook |
| `app/components/workbench/Spotlight.tsx` | 3B | `role="listbox"` → `role="group"` |
| `app/generator/page.tsx` | 3C | `FieldLabel` + field markup (R16); the Final message (R13) |
| `app/globals.css` | 3C | Field-label styling by class; help-bubble placement |
| `app/lib/image-transport.ts` | 3C | `compressedReferenceCount` |
| `tests/image-transport-cache.test.mjs` | 3C | Append |
| `app/components/scene-wheel-v2/SceneWheelV2.tsx` | 3D | Library fetch deadline |
| `app/dither-lab/page.tsx` | 3D | Autoplay repeatable; duplicate grain removed |

---

## WP-3A — Review boards

### Task 3A.1: Deleting a project asks first and says what goes (R18)

**Files:**
- Modify: `app/components/review-boards/ReviewBoards.tsx:266-279` (`remove`)

The delete itself is already safe to retry. `deleteProject` removes photos, board state, renders and row edits first, all idempotent, and the project row last. So this task adds only the confirmation.

- [ ] **Step 1: Implement**

Replace:
```tsx
  const remove = useCallback(async () => {
    if (!activeId) return;
    setBusy("deleting");
```
with:
```tsx
  const remove = useCallback(async () => {
    if (!activeId) return;
    // Everything collected for the project goes with it, and none of it comes
    // back: say what, and let Cancel do nothing at all. The sheet itself is
    // never written by a delete (see autoboard-projects.ts deleteProject).
    const name = shown?.name ? `"${shown.name}"` : "this project";
    if (!window.confirm(`Delete ${name}? Its collected photos, board notes, renders and row edits are removed for good. The Smartsheet is not changed.`)) return;
    setBusy("deleting");
```
and change the `remove` dependency list from `}, [activeId, loadProjects]);` to `}, [activeId, loadProjects, shown]);`. Only the `remove` callback's list changes. It is the one directly above `const reloadPhotos = useCallback(`. (`shown` is `ProjectDetail | null`, line 204, and `ProjectDetail` extends `Project`, which has `name: string`.)

- [ ] **Step 2: Lint and the gate**

Run: `npx eslint app/components/review-boards/ReviewBoards.tsx && node scripts/typecheck-baseline.mjs`

Expected: no new errors; the gate exits 0.

- [ ] **Step 3: Browser check (free)**

Open `http://localhost:3000/review-boards` and select any project. If none exists, create a blank one from the page; that costs nothing. Then:
- Run `window.confirm = () => false` via `javascript_tool` and click **Delete**. The project is still listed and the network log shows no `DELETE /api/autoboard/projects/…`.
- Run `window.__asked = ""; window.confirm = (m) => { window.__asked = m; return false; }`, click **Delete** again, and read `window.__asked`. It names the project.

- [ ] **Step 4: Commit**

```bash
git add app/components/review-boards/ReviewBoards.tsx
git commit -m "fix(review-boards): confirm before deleting a project

Delete removed the project's photos, notes, renders and row edits on one
click. Ask first, naming the project and what goes with it; Cancel does
nothing.

Co-Authored-By: <model trailer>"
```

---

## WP-3B — Workbench

### Task 3B.1: Cancel creates nothing (R17)

**Files:**
- Modify: `app/components/workbench/GraphManager.tsx:115-125` (`handleCreate`)

- [ ] **Step 1: Implement**

Replace:
```tsx
  const handleCreate = async () => {
    setBusy(true);
    try {
      const name = window.prompt("Name this workbench", "New workbench") || "New workbench";
      const graphId = await createGraph(name);
      refresh();
      await doSwitch(graphId);
    } finally {
      setBusy(false);
    }
  };
```
with:
```tsx
  const handleCreate = async () => {
    const answer = window.prompt("Name this workbench", "New workbench");
    // null is Cancel: create, save and switch nothing. An accepted empty name
    // still gets the default.
    if (answer === null) return;
    setBusy(true);
    try {
      const graphId = await createGraph(answer.trim() || "New workbench");
      refresh();
      await doSwitch(graphId);
    } finally {
      setBusy(false);
    }
  };
```

- [ ] **Step 2: Browser check**

On `/workbench`, open the graph manager and count the listed workbenches with `find` or `read_page`. Run `window.prompt = () => null` via `javascript_tool`, then click the control that creates a new workbench. The count is unchanged, there was no reload, and the active graph is unchanged.

- [ ] **Step 3: Commit** (after Task 3B.2, which touches the same component; or commit separately)

```bash
git add app/components/workbench/GraphManager.tsx
git commit -m "fix(workbench): Cancel on the new-workbench prompt creates nothing

window.prompt's null was turned into the default name by ||, so Cancel
still created and switched to a graph.

Co-Authored-By: <model trailer>"
```

### Task 3B.2: Workbench dialogs contain keyboard focus (R14)

**Files:**
- Create: `app/components/workbench/useModalFocus.ts`
- Modify: `app/components/workbench/WorkbenchApp.tsx` (`TemplateGallery`, lines ~90–116; `ExportDialog`, ~118+)
- Modify: `app/components/workbench/GraphManager.tsx` (its `role="dialog"` element, ~170)

**Interfaces:**
- Produces: `useModalFocus(container: RefObject<HTMLElement | null>, options?: { initialFocus?: RefObject<HTMLElement | null>; onEscape?: () => void; restoreFocus?: boolean }): void`

**Why a Tab trap and not `inert` or native `<dialog>`:** The landing lightbox (`SceneWheelV2.tsx:199-225`, `:374`) contains focus by marking its background `<section>` `inert`. It can do that because the background is a sibling. A Workbench dialog renders *inside* the app shell next to the canvas and nav, so there is no one sibling to mark. Native `<dialog>.showModal()` would also work. But it needs UA-style resets and imperative open/close around `useModalDismiss`'s 150 ms exit animation, which is more change than this defect needs.

- [ ] **Step 1: Write the hook**

Create `app/components/workbench/useModalFocus.ts`:
```ts
// Keyboard containment for an in-page modal: focus moves into it when it
// opens, Tab and Shift+Tab cycle inside it instead of reaching the page
// behind, Escape can close it, and focus goes back where it was when it
// unmounts. aria-modal="true" tells assistive tech the page behind is inert,
// but it does not stop Tab — that part is this hook's. (useModalDismiss only
// times the exit animation.) The landing lightbox does the same job with
// `inert` on its background section (SceneWheelV2); a Workbench dialog sits
// inside the app shell with no single sibling to mark, so it contains Tab
// itself.
import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function useModalFocus(
  container: RefObject<HTMLElement | null>,
  options: { initialFocus?: RefObject<HTMLElement | null>; onEscape?: () => void; restoreFocus?: boolean } = {},
) {
  // Held in a ref so a new onEscape identity on every render does not re-run
  // the effect below, which would pull focus back to the first control.
  const onEscape = useRef(options.onEscape);
  useEffect(() => {
    onEscape.current = options.onEscape;
  });
  const { initialFocus, restoreFocus = true } = options;

  useEffect(() => {
    const root = container.current;
    if (!root) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () =>
      Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) => element.getClientRects().length > 0);
    const frame = window.requestAnimationFrame(() => {
      (initialFocus?.current ?? focusable()[0] ?? root).focus({ preventScroll: true });
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && onEscape.current) {
        event.preventDefault();
        onEscape.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) {
        event.preventDefault();
        root.focus({ preventScroll: true });
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !root.contains(active)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (active === first || active === root)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKeyDown, true);
      if (restoreFocus && previouslyFocused?.isConnected && previouslyFocused !== document.body) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, [container, initialFocus, restoreFocus]);
}
```

- [ ] **Step 2: Apply it to the startup template chooser**

In `app/components/workbench/WorkbenchApp.tsx`, add `import { useModalFocus } from "./useModalFocus";` next to the existing `useModalDismiss` import. Then replace:
```tsx
function TemplateGallery({ onPick, onClose }: { onPick: (id: TemplateId) => void; onClose: () => void }) {
  const { closing, requestClose } = useModalDismiss(onClose);
  return (
    <div className={`${styles.templateOverlay} ${closing ? styles.overlayClosing : ""}`} role="dialog" aria-modal="true" aria-label="Choose a starting template">
```
with:
```tsx
function TemplateGallery({ onPick, onClose }: { onPick: (id: TemplateId) => void; onClose: () => void }) {
  const { closing, requestClose } = useModalDismiss(onClose);
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(dialogRef, { onEscape: requestClose });
  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      className={`${styles.templateOverlay} ${closing ? styles.overlayClosing : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="Choose a starting template"
    >
```
Before passing `onEscape`, grep for an existing Escape handler that already closes this gallery: `grep -n "Escape" app/components/workbench/WorkbenchApp.tsx app/components/workbench/useModalDismiss.ts`. If one exists, drop the `onEscape` option, so one keypress doesn't close twice.

- [ ] **Step 3: Apply it to the other component-level dialogs**

Apply the same three-part change (a `useRef`, the `useModalFocus(ref, …)` call, and `ref` + `tabIndex={-1}` on the `role="dialog"` element) to:
- `ExportDialog` in `WorkbenchApp.tsx`, passing `onEscape` with its dismiss function (`requestClose` if it uses `useModalDismiss`) unless it already handles Escape;
- the `role="dialog"` element in `GraphManager.tsx`, the same way.

Then run `grep -n 'role="dialog"\|role="alertdialog"' app/components/workbench/*.tsx`. For each remaining match not covered above:
- **Rendered by its own function component** (not inline in `WorkbenchApp`'s body): apply the same change.
- **Inline in `WorkbenchApp`'s render** (the wire-connect dialog near line 811, and the non-dismissable restore-error alertdialog near line 1161): leave it. Hooks can't be called conditionally, and extracting these is a larger change the review didn't verify. Record both in `docs/visual-qa.md` as known gaps. The restore-error one must stay non-dismissable in any later change.

- [ ] **Step 4: Lint and the gate**

Run: `npx eslint app/components/workbench && node scripts/typecheck-baseline.mjs`

Expected: no new errors; the gate exits 0.

- [ ] **Step 5: Browser check**

Clear the Workbench canvas so the template chooser shows; it appears on an empty canvas. You can use a fresh graph, or `indexedDB.deleteDatabase("material-collager-workbench")` followed by a reload. Nothing of the user's is on this dev origin, but ask before deleting if unsure. Then:
1. After the chooser opens: `document.activeElement.closest('[role="dialog"]') !== null`. Expected: `true`.
2. Press `Tab` ten times with `computer {action:"key", text:"Tab", repeat: 10}`. Focus is still inside the dialog, checked as in 1.
3. `Shift+Tab` from the first control lands on the last control.
4. `Escape`, or **Skip**, closes it, and focus is no longer on `<body>` inside a removed node.

Repeat 1–2 for the Export dialog.

- [ ] **Step 6: Commit**

```bash
git add app/components/workbench/useModalFocus.ts app/components/workbench/WorkbenchApp.tsx app/components/workbench/GraphManager.tsx docs/visual-qa.md
git commit -m "fix(workbench): keep keyboard focus inside Workbench dialogs

The template chooser declared aria-modal but focus started on the body
and Tab reached the navigation behind it. useModalFocus moves focus in,
contains Tab/Shift+Tab, supports Escape and restores focus on close.

Co-Authored-By: <model trailer>"
```

### Task 3B.3: A failed Workbench chunk says so and offers a reload (R15)

**Files:**
- Modify: `app/workbench/page.tsx` (`WorkbenchVeil`; the load effect and render in `WorkbenchPage`)

**Why reload rather than re-`import()`:** Chromium caches a failed dynamic import for the document's lifetime, so calling `import()` again fails again. Saved workbenches live in IndexedDB (`app/components/workbench/persistence.ts`, `material-collager-workbench`), so a reload loses nothing.

- [ ] **Step 1: Implement**

Replace `function WorkbenchVeil() {` and its body with:
```tsx
function WorkbenchVeil({ failed = false }: { failed?: boolean }) {
  return (
    <div style={{ height: "100dvh", paddingTop: 58, background: "var(--mono-off-white, #fafafa)", overflow: "hidden" }}>
      <SiteNavigation active="workbench" className="generator-navigation" />
      <div
        aria-busy={failed ? undefined : "true"}
        style={{
          height: "100%",
          display: "grid",
          placeItems: "center",
          backgroundImage: "radial-gradient(#d0d0d0 1.4px, transparent 1.4px)",
          backgroundSize: "22px 22px",
        }}
      >
        {failed ? (
          <div role="alert" style={{ display: "grid", gap: 10, justifyItems: "center", textAlign: "center" }}>
            <p style={{ fontSize: 11, color: "#000000", margin: 0 }}>
              The workbench could not load. Your saved workbenches are safe on this device.
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                fontSize: 8.4,
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                color: "#000000",
                background: "transparent",
                border: "1px solid #000000",
                borderRadius: 0,
                padding: "6px 12px",
                cursor: "pointer",
              }}
            >
              Reload
            </button>
          </div>
        ) : (
          <p style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "rgb(0 0 0 / 45%)" }}>
            Loading workbench…
          </p>
        )}
      </div>
    </div>
  );
}
```
In `WorkbenchPage`, replace:
```tsx
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    void import("@/app/components/workbench/WorkbenchApp")
      .then(() => {
        if (alive) setLoaded(true);
      })
      .catch(() => {
        // Chunk failure: leave the veil; the budget releases the wipe.
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!loaded) return <WorkbenchVeil />;
```
with:
```tsx
  const [chunk, setChunk] = useState<"loading" | "loaded" | "failed">("loading");
  useEffect(() => {
    let alive = true;
    void import("@/app/components/workbench/WorkbenchApp")
      .then(() => {
        if (alive) setChunk("loaded");
      })
      .catch(() => {
        // Chunk failure (offline, or a deploy replaced the chunk): say so and
        // offer a reload instead of a veil that never lifts. The readiness
        // budget still releases the wipe onto this screen.
        if (alive) setChunk("failed");
      });
    return () => {
      alive = false;
    };
  }, []);

  if (chunk === "failed") return <WorkbenchVeil failed />;
  if (chunk !== "loaded") return <WorkbenchVeil />;
```

- [ ] **Step 2: Lint, the gate, and a regression check**

Run: `npx eslint app/workbench/page.tsx && node scripts/typecheck-baseline.mjs`.

Then load `/workbench` in the preview. It reaches the app as before: `read_page` shows the canvas, not "Loading workbench…".

The failed branch can't be triggered in the preview without editing code, so its check is the reviewer reading it. Its visual rules are 11px black body text and an 8.4px uppercase square-cornered button, per `CLAUDE.md`.

- [ ] **Step 3: Commit**

```bash
git add app/workbench/page.tsx
git commit -m "fix(workbench): show a reload action when the app chunk fails to load

The dynamic import's failure was swallowed, leaving 'Loading workbench…'
up forever. Track loading/loaded/failed and offer a reload; saved
workbenches are in IndexedDB, so nothing is lost.

Co-Authored-By: <model trailer>"
```

### Task 3B.4: The node picker stops claiming listbox semantics

**Files:**
- Modify: `app/components/workbench/Spotlight.tsx:59`

The list is plain `<button>`s with no `role="option"`, arrow keys or active descendant, so `role="listbox"` promises behaviour that isn't there. The honest fix is an ordinary group of buttons; the buttons are already tabbable.

- [ ] **Step 1: Implement**

Replace:
```tsx
      <div className={styles.spotlightList} role="listbox" aria-label="Node types">
```
with:
```tsx
      <div className={styles.spotlightList} role="group" aria-label="Node types">
```

- [ ] **Step 2: Commit**

```bash
git add app/components/workbench/Spotlight.tsx
git commit -m "fix(workbench): describe the node picker as a group of buttons

It declared role=listbox without options or arrow-key behaviour.

Co-Authored-By: <model trailer>"
```

---

## WP-3C — Generator

### Task 3C.1: Each item field gets its own visible label (R16)

**Files:**
- Modify: `app/generator/page.tsx:258-268` (`FieldLabel`) and `:1906-1927` (the five item fields)
- Modify: `app/globals.css` (add rules directly after the `.field-label { … }` block, around line 217)

**Why the wrapper changes:** a `<label>` may hold only one labelable element (its control). With the help `<button>` first inside it, the button became the label's control. The input and textarea got no label, and clicking the text focused nothing. So the wrapper becomes a `<div class="item-field">`, the text gets its own `<label htmlFor>`, and the help text is tied to the input with `aria-describedby`. The CSS that styled `label > span` must now reach `.field-label` by class.

- [ ] **Step 1: Measure before changing anything**

In the preview, open `/generator`. Make sure at least one item exists and its **Item details** is open. If the page starts empty, add a reference image through the page's file input, which costs nothing. The Browser tools can't pick files, so hand the input a generated file:
```js
(async () => {
  const canvas = Object.assign(document.createElement("canvas"), { width: 8, height: 8 });
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  const input = document.querySelector('input[type="file"]');
  const transfer = new DataTransfer();
  transfer.items.add(new File([blob], "fixture.png", { type: "image/png" }));
  input.files = transfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
})()
```
Then run this and save the output:
```js
(() => {
  const field = document.querySelector(".item-fields > *");
  const label = field.querySelector(".field-label");
  const input = field.querySelector("input, textarea");
  const s = getComputedStyle(label);
  return {
    label: { fontSize: s.fontSize, fontWeight: s.fontWeight, color: s.color, marginBottom: s.marginBottom, display: s.display, gap: s.gap },
    fieldBox: field.getBoundingClientRect().toJSON(),
    inputBox: input.getBoundingClientRect().toJSON(),
    inputLabels: input.labels ? Array.from(input.labels, (l) => l.textContent.trim()) : null,
  };
})()
```
Expected before the fix: `inputLabels` is `[]`, which is the defect.

- [ ] **Step 2: Implement the markup**

Replace `FieldLabel`:
```tsx
function FieldLabel({ text, help }: { text: string; help: string }) {
  return (
    <span className="field-label">
      {text}
      <span className="help-wrap">
        <button type="button" className="help-button" aria-label={`${text}: ${help}`}>?</button>
        <span className="field-help" role="tooltip">{help}</span>
      </span>
    </span>
  );
}
```
with:
```tsx
// The visible text is the field's <label>; the help button sits beside it,
// not inside it (a <label> may hold only its own control), and the help text
// is the input's description.
function FieldLabel({ text, help, htmlFor }: { text: string; help: string; htmlFor: string }) {
  return (
    <span className="field-label">
      <label htmlFor={htmlFor}>{text}</label>
      <span className="help-wrap">
        <button type="button" className="help-button" aria-label={`${text}: ${help}`}>?</button>
        <span className="field-help" role="tooltip" id={`${htmlFor}-help`}>{help}</span>
      </span>
    </span>
  );
}
```
Replace the five fields inside `<div className="item-fields">`, from the first `<label>` through the last `</label>`, with:
```tsx
                    <div className="item-field">
                      <FieldLabel htmlFor={`${item.uiKey}-role`} text="Item type" help="What this object contributes to the collage, such as main bathroom tile, vanity faucet, or countertop stone." />
                      <input id={`${item.uiKey}-role`} aria-describedby={`${item.uiKey}-role-help`} value={item.role} onChange={(event) => updateItem(item.uiKey, { role: event.target.value })} />
                    </div>
                    <div className="item-field">
                      <FieldLabel htmlFor={`${item.uiKey}-name`} text="Product / model" help="The exact collection, model number, or SKU when known. Leave blank when the image does not prove it." />
                      <input id={`${item.uiKey}-name`} aria-describedby={`${item.uiKey}-name-help`} value={item.name || ""} onChange={(event) => updateItem(item.uiKey, { name: event.target.value })} />
                    </div>
                    <div className="item-field">
                      <FieldLabel htmlFor={`${item.uiKey}-brand`} text="Brand" help="The manufacturer name, not the retailer or showroom." />
                      <input id={`${item.uiKey}-brand`} aria-describedby={`${item.uiKey}-brand-help`} value={item.brand || ""} onChange={(event) => updateItem(item.uiKey, { brand: event.target.value })} />
                    </div>
                    <div className="item-field wide-field">
                      <FieldLabel htmlFor={`${item.uiKey}-finish`} text="Finish / color" help="Use the manufacturer finish name when known, or describe the visible material color and sheen." />
                      <input id={`${item.uiKey}-finish`} aria-describedby={`${item.uiKey}-finish-help`} value={item.finish || ""} onChange={(event) => updateItem(item.uiKey, { finish: event.target.value })} />
                    </div>
                    <div className="item-field wide-field">
                      <FieldLabel htmlFor={`${item.uiKey}-notes`} text="Generation notes" help="Add exceptions the image cannot communicate, such as which face to show, details to preserve, or objects that must not appear." />
                      <textarea id={`${item.uiKey}-notes`} aria-describedby={`${item.uiKey}-notes-help`} value={item.notes || ""} onChange={(event) => updateItem(item.uiKey, { notes: event.target.value })} />
                    </div>
```
`item.uiKey` is minted once per item (`createUiKey()`, line ~248), so the ids stay unique and stable when items are reordered. `useId()` can't be used here: `FieldLabel` doesn't render the input, and a hook inside `.map()` is illegal.

- [ ] **Step 3: Carry the styling over by class**

In `app/globals.css`, directly after the `.field-label { align-items: center; display: flex; gap: 6px; }` block, add:
```css
/* Generator item fields: the wrapper is a <div> (a <label> may hold only its
   own control, not also the help <button>), so what `label > span` used to
   give the label row is applied by class, and the grid item keeps the
   min-width a <label> wrapper had. */
.item-field {
  min-width: 0;
}

.item-field > .field-label {
  color: var(--muted);
  font-size: 11px;
  font-weight: 650;
  margin-bottom: 5px;
}
```

- [ ] **Step 4: Measure after, and compare**

Reload `/generator`, reopen **Item details**, and run the Step 1 snippet again. Expected:
- `label` values are identical to before.
- `fieldBox` and `inputBox` are identical, within 0.5px.
- `inputLabels` is `["Item type"]`.

Then:
- Click the "Item type" text. `document.activeElement` is that input.
- Click the "?" button. Focus moves to the button, not the input, and the bubble shows.
- Reorder or remove an item if the UI allows it. Ids remain unique: `new Set([...document.querySelectorAll('.item-fields [id]')].map(e => e.id)).size === document.querySelectorAll('.item-fields [id]').length`.

- [ ] **Step 5: Commit** (with Task 3C.2 if done in the same session; otherwise now)

```bash
git add app/generator/page.tsx app/globals.css
git commit -m "fix(generator): give each item field its own visible label

The help button sat first inside each implicit <label>, so the button
became the labelled control and the inputs had no label. Label the
text explicitly, move the button beside it, and describe the input with
the help text; styling carried over by class.

Co-Authored-By: <model trailer>"
```

### Task 3C.2: The help bubble stays inside its card (R20)

**Files:**
- Modify: `app/globals.css:1786-1791` (the unconditional `.field-help` override)

**Why:** that override makes every bubble grow **leftward** 210px from its button. The first column's cards sit at the reference tray's left edge, and `.references-surface { overflow: auto }` clips the bubble there. Growing rightward from the button would clip the last column instead. Anchoring to the label's own left edge and growing upward keeps the bubble inside the card, and so inside the tray, in every column. The narrow-viewport rule (`.generator-shell .field-help { position: fixed … }`, ~line 3298) comes later in the file and still wins on phones.

- [ ] **Step 1: Measure the clipping before**

At 1440×900, open item 1's **Item details**, focus its first help button with `find` plus a click, and run:
```js
(() => {
  const bubble = document.querySelector(".help-wrap:focus-within .field-help");
  const tray = document.querySelector(".references-surface").getBoundingClientRect();
  const b = bubble.getBoundingClientRect();
  return { inside: b.left >= tray.left && b.right <= tray.right && b.top >= tray.top && b.bottom <= tray.bottom, bubble: b.toJSON(), tray: tray.toJSON() };
})()
```
Expected before: `inside: false` for the first column.

- [ ] **Step 2: Implement**

Replace:
```css
.field-help {
  left: auto;
  right: 20px;
  top: -7px;
  transform-origin: 100% 14px;
  width: 210px;
}
```
with:
```css
/* Help bubbles in an item card grow up and to the right from the label's own
   left edge, so they stay inside the card and so inside the scrolling
   reference tray, whose overflow clipped a bubble that grew leftward out of
   the first column's card. (Phones keep the fixed bubble set in the
   .generator-shell media block further down.) */
.item-fields .field-label {
  position: relative;
}

.item-fields .help-wrap {
  position: static;
}

.item-fields .field-help {
  bottom: calc(100% + 6px);
  left: 0;
  right: auto;
  top: auto;
  transform-origin: 0 100%;
  width: min(210px, 100%);
}
```

- [ ] **Step 3: Verify at four viewports**

For each of 1440×900, 1280×800, 1024×768 (via `resize_window`) and 390×844 (`preset: "mobile"`, then reload):
- Focus the help buttons of the first field and the last field (Generation notes) of the first card and of the last visible card, and run the Step 1 snippet for each. Expected: `inside: true`.
- On 390×844 the bubble is the existing fixed one. Record that it still renders as before.

If any case is still clipped, record the numbers in `docs/visual-qa.md` and stop; don't iterate placement blind. Reset with `preset: "desktop"`.

- [ ] **Step 4: Record and commit**

Append a dated entry to `docs/visual-qa.md` in its existing format. It lists R16's before/after computed-style match and R20's inside/outside results per viewport, plus the two known-gap dialogs from Task 3B.2 if that ran.

```bash
git add app/globals.css docs/visual-qa.md
git commit -m "fix(generator): keep item help bubbles inside their card

An unconditional override grew every bubble 210px to the left, so the
first column's bubbles were clipped by the reference tray. Anchor them
to the label's left edge and grow upward; phones keep their fixed bubble.

Co-Authored-By: <model trailer>"
```

### Task 3C.3: The Final message says whether references were compressed (R13)

**Files:**
- Modify: `app/lib/image-transport.ts` (add `compressedReferenceCount`)
- Modify: `app/generator/page.tsx:1290-1297` (the `setPanelText` call after an immediate Final)
- Test: `tests/image-transport-cache.test.mjs` (append)

**Interfaces:**
- Produces: `compressedReferenceCount(originals: File[], sent: File[]): number`. It counts positions where the sent File isn't the original object. `optimizeReferenceForTransport` returns the same File when a reference fits its budget untouched and a new, re-encoded one when it doesn't.

- [ ] **Step 1: Write the failing test**

Append to `tests/image-transport-cache.test.mjs`, and add `compressedReferenceCount` to that file's import from `../app/lib/image-transport.ts`:
```js
test("compressedReferenceCount counts the references that were replaced by a re-encoded copy", () => {
  const a = new File([new Uint8Array([1])], "a.png", { type: "image/png" });
  const b = new File([new Uint8Array([2])], "b.png", { type: "image/png" });
  const bCompressed = new File([new Uint8Array([2])], "b-optimized.jpg", { type: "image/jpeg" });
  assert.equal(compressedReferenceCount([a, b], [a, b]), 0);
  assert.equal(compressedReferenceCount([a, b], [a, bCompressed]), 1);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --experimental-strip-types --test tests/image-transport-cache.test.mjs`

Expected: FAIL; the export is missing.

- [ ] **Step 3: Implement the helper**

In `app/lib/image-transport.ts`, directly after `optimizeReferencesForTransport`, add:
```ts
// How many references went out as a re-encoded copy. optimizeReferenceForTransport
// returns the very same File when a reference fit its budget untouched and a new
// one when it had to be resized or re-encoded (and flattened onto white), so
// identity says which ones the model received at full quality.
export function compressedReferenceCount(originals: File[], sent: File[]): number {
  return sent.filter((file, index) => file !== originals[index]).length;
}
```
Add `compressedReferenceCount` to the generator page's existing import from `@/app/lib/image-transport`.

- [ ] **Step 4: Use it in the message**

In `app/generator/page.tsx`, replace:
```tsx
      setPanelText([
        `Final ${finalFormat} render complete${response.notice ? "" : ` at ${finalSizeLabel}`}. Full-quality product references were used.`,
        costMessage,
        response.notice,
      ].filter(Boolean).join("\n\n"));
```
with:
```tsx
      // Only claim full quality when every product reference went out untouched.
      const compressed = compressedReferenceCount(productFiles, transportFiles);
      const referenceNote = compressed === 0
        ? "Full-quality product references were used."
        : `${compressed} of ${productFiles.length} product references were compressed to fit this request's size limit, so their finest detail and any transparency may be reduced. The Economy final render uploads each reference at full quality.`;
      setPanelText([
        `Final ${finalFormat} render complete${response.notice ? "" : ` at ${finalSizeLabel}`}. ${referenceNote}`,
        costMessage,
        response.notice,
      ].filter(Boolean).join("\n\n"));
```

- [ ] **Step 5: Tests, lint and the gate**

Run: `node --experimental-strip-types --test tests/image-transport-cache.test.mjs && npx eslint app/generator/page.tsx app/lib/image-transport.ts && node scripts/typecheck-baseline.mjs`

Expected: all pass, no new errors, and the gate exits 0.

- [ ] **Step 6: Commit**

```bash
git add app/lib/image-transport.ts app/generator/page.tsx tests/image-transport-cache.test.mjs
git commit -m "fix(generator): say when Final had to compress product references

The Final message always claimed full-quality references, even when
references over the request budget were resized and re-encoded. Count
the re-encoded ones and say so, pointing to Economy for full quality.

Co-Authored-By: <model trailer>"
```

---

## WP-3D — Landing and labs

### Task 3D.1: A hung library request can't hold the landing veil forever (R19)

**Files:**
- Modify: `app/components/scene-wheel-v2/SceneWheelV2.tsx:175-197` (the library fetch effect)

- [ ] **Step 1: Implement**

Add, next to `PRELOAD_TIMEOUT_MS` near line 39:
```tsx
// The library request's own deadline. PRELOAD_TIMEOUT_MS only starts once
// this request settles, so without one a hung /api/library held the loading
// veil at 0% forever.
const LIBRARY_FETCH_TIMEOUT_MS = 8000;
```
Replace the whole library fetch effect:
```tsx
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await fetch("/api/library", { cache: "no-store", signal: controller.signal });
```
through its closing `  }, []);` (the effect ending with `return () => controller.abort();`) with:
```tsx
  useEffect(() => {
    const controller = new AbortController();
    let unmounted = false;
    // Past the deadline the scene falls back to the lab fixtures, exactly as
    // for any other failed fetch.
    const deadline = window.setTimeout(
      () => controller.abort(new DOMException("The library took too long to answer.", "TimeoutError")),
      LIBRARY_FETCH_TIMEOUT_MS,
    );
    const load = async () => {
      try {
        const response = await fetch("/api/library", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const parsed = parseLibraryPayload(await response.json());
        if (!parsed.valid) throw new Error(parsed.message);
        const normalized = normalizeLibraryCollageRecords(parsed.records);
        loadTargetRef.current = Math.max(loadTargetRef.current, FETCH_SHARE);
        setRecords(normalized);
        setLibraryState(normalized.length > 0 ? "ready" : "fallback");
      } catch (error) {
        // Unmounting aborts too; only a live component falls back.
        if (unmounted) return;
        console.warn("Scene Wheel V2 is using the lab collage fixtures.", error);
        loadTargetRef.current = Math.max(loadTargetRef.current, FETCH_SHARE);
        setRecords([]);
        setLibraryState("fallback");
      } finally {
        window.clearTimeout(deadline);
      }
    };
    void load();
    return () => {
      unmounted = true;
      window.clearTimeout(deadline);
      controller.abort();
    };
  }, []);
```

- [ ] **Step 2: Lint, the gate, and a regression check**

Run: `npx eslint app/components/scene-wheel-v2/SceneWheelV2.tsx && node scripts/typecheck-baseline.mjs`

Load `/` in the preview. The veil lifts and the scene renders as before; check `read_page` and the console for errors. The hang itself can't be produced in the preview without editing the route, so the reviewer checks that branch by reading it.

- [ ] **Step 3: Commit**

```bash
git add app/components/scene-wheel-v2/SceneWheelV2.tsx
git commit -m "fix(landing): give the library request its own deadline

The fetch had no timeout and the image preload deadline only starts
after it settles, so a hung /api/library kept the veil up forever.
Abort after 8 s and use the existing fixture fallback.

Co-Authored-By: <model trailer>"
```

### Task 3D.2: Dither Lab autoplay repeats, and the lab's grain matches production

**Files:**
- Modify: `app/dither-lab/page.tsx:57-61` (the interval callback) and `:81` (the extra grain overlay)

- [ ] **Step 1: Implement**

Replace:
```tsx
      if (i >= stages.length) {
        clearInterval(id);
        return;
      }
```
with:
```tsx
      if (i >= stages.length) {
        clearInterval(id);
        // Done: release the toggle so the next click replays from the start.
        setAutoPlay(false);
        return;
      }
```
Delete the line:
```tsx
      <div className="grain-overlay" aria-hidden />
```
The root layout (`app/layout.tsx`) already renders one on every page, so the lab was showing two stacked grain layers.

- [ ] **Step 2: Browser check**

On `/dither-lab`:
- `document.querySelectorAll(".grain-overlay").length === 1`.
- Click **autoplay discrete jumps** and wait about 6 s for the four 1.4 s stages. Click it again: progress goes back to 0 and replays. Check the progress readout or the `DitherReveal` state with `read_page`.

- [ ] **Step 3: Commit**

```bash
git add app/dither-lab/page.tsx
git commit -m "fix(dither-lab): make autoplay repeatable and drop the duplicate grain

Autoplay never reset its flag, so the button could not replay; the lab
also rendered a second grain overlay on top of the layout's own.

Co-Authored-By: <model trailer>"
```

---

## Phase 3 exit criteria

- [ ] `node --experimental-strip-types --test --test-reporter=dot tests/*.test.mjs`: 0 failures.
- [ ] `npm run lint`: no new errors. `node scripts/typecheck-baseline.mjs` exits 0.
- [ ] `docs/visual-qa.md` has the dated WP-3C entry (and the WP-3B known gaps).
- [ ] One screenshot per WP attached to the phase summary as proof.
- [ ] Sonnet phase review of the combined diff. No Opus needed unless a browser check failed and was worked around.
