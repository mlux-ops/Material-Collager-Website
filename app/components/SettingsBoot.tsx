"use client";

/**
 * SettingsBoot
 * ------------
 * Mounted once in the root layout. Two jobs:
 *
 *  1. Push the stored settings onto <html> as early as the client can, so the
 *     reduce-motion / potato attributes and --wipe-dur are in place before
 *     the first interaction.
 *  2. Honor the landing-page preference: a FRESH visit to "/" redirects to
 *     the chosen surface. Deliberately narrow — it fires only on a real
 *     document load (not client navigation, not history traversal) and only
 *     once per tab, so clicking LIBRARY afterward still reaches the library
 *     instead of bouncing straight back out.
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { applySettings, getSettings } from "@/app/lib/site-settings";

const LANDED_KEY = "mc:landed";

export function SettingsBoot() {
  const router = useRouter();

  useEffect(() => {
    applySettings();

    let landed = "1";
    try {
      landed = window.sessionStorage.getItem(LANDED_KEY) ?? "";
      window.sessionStorage.setItem(LANDED_KEY, "1");
    } catch {
      landed = "1"; // no sessionStorage: never redirect rather than loop
    }
    if (landed) return; // already landed in this tab

    const [entry] = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
    if (entry && entry.type === "back_forward") return;

    const { landing } = getSettings();
    if (landing === "/" || window.location.pathname !== "/") return;
    router.replace(landing);
  }, [router]);

  return null;
}

export default SettingsBoot;
