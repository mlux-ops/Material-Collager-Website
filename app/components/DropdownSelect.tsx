"use client";

// Custom listbox replacing native <select> fields so opening/closing can
// animate (transitions-dev 05-menu-dropdown; native select popups are
// OS-rendered and can't be styled or transitioned). The menu is fixed-
// positioned from the trigger's rect so it escapes scrollable panels like
// .controls-surface, and flips upward when there's no room below.

import { useCallback, useEffect, useRef, useState } from "react";

export type DropdownOption = { value: string; label: string };

// Mirrors --dropdown-close-dur in app/motion-tokens.css.
const CLOSE_MS = 150;
// Estimated max menu height used only for the flip-up decision.
const FLIP_PROBE_PX = 280;

export function DropdownSelect({
  value,
  options,
  onChange,
  disabled = false,
}: {
  value: string;
  options: DropdownOption[];
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(false); // drives .is-open one frame after mount
  const [closing, setClosing] = useState(false);
  const [rect, setRect] = useState<{ left: number; width: number; top?: number; bottom?: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | null>(null);

  const selected = options.find((option) => option.value === value);
  const flippedUp = rect?.bottom !== undefined;

  const openMenu = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    setClosing(false);
    const r = trigger.getBoundingClientRect();
    const flipUp = window.innerHeight - r.bottom < FLIP_PROBE_PX && r.top > window.innerHeight - r.bottom;
    setRect(
      flipUp
        ? { left: r.left, width: r.width, bottom: window.innerHeight - r.top + 4 }
        : { left: r.left, width: r.width, top: r.bottom + 4 }
    );
    setOpen(true);
  }, []);

  const closeMenu = useCallback((focusTrigger = false) => {
    setOpen(false);
    setShown(false);
    setClosing(true);
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      setClosing(false);
      setRect(null);
    }, CLOSE_MS);
    if (focusTrigger) triggerRef.current?.focus();
  }, []);

  // The menu mounts in the recipe's pre-open state (scale 0.97, opacity 0);
  // .is-open lands two frames later so the open transition actually plays.
  useEffect(() => {
    if (!open) return;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setShown(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [open]);

  // Focus the selected option once visible, for keyboard flow.
  useEffect(() => {
    if (!shown) return;
    const target =
      menuRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]') ??
      menuRef.current?.querySelector<HTMLButtonElement>("[role='option']");
    target?.focus({ preventScroll: true });
  }, [shown]);

  // Outside interaction + scroll/resize dismiss while open.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      closeMenu();
    };
    const onScroll = (event: Event) => {
      if (menuRef.current && event.target instanceof Node && menuRef.current.contains(event.target)) return;
      closeMenu();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, closeMenu]);

  useEffect(() => () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
  }, []);

  const onMenuKeyDown = (event: React.KeyboardEvent) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role='option']") ?? []);
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu(true);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      items[Math.min(index + 1, items.length - 1)]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      items[Math.max(index - 1, 0)]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      items[items.length - 1]?.focus();
    } else if (event.key === "Tab") {
      closeMenu();
    }
  };

  const pick = (next: string) => {
    onChange(next);
    closeMenu(true);
  };

  return (
    <span className="dropdown-field">
      <button
        ref={triggerRef}
        type="button"
        className="dropdown-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? closeMenu() : openMenu())}
        onKeyDown={(event) => {
          if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            openMenu();
          }
        }}
      >
        <span className="dropdown-value">{selected?.label ?? ""}</span>
      </button>
      {rect && (
        <div
          ref={menuRef}
          className={`t-dropdown dropdown-menu${shown ? " is-open" : ""}${closing ? " is-closing" : ""}`}
          data-origin={flippedUp ? "bottom-left" : "top-left"}
          role="listbox"
          style={{ left: rect.left, width: rect.width, top: rect.top, bottom: rect.bottom }}
          onKeyDown={onMenuKeyDown}
        >
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className="dropdown-option"
              onClick={() => pick(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
