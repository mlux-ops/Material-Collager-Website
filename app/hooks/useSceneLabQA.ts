"use client";

import { useMemo } from "react";
import { anchorToProgress, isSceneAnchor, type SceneAnchor } from "@/app/lib/scene-lab-geometry";

export type SceneLabQAState = {
  anchor: SceneAnchor | null;
  enabled: boolean;
  failedTextureTrack: string | null;
  frozen: boolean;
  progress: number;
};

export function useSceneLabQA(): SceneLabQAState {
  return useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    const enabled = params.get("qa") === "1";
    const anchorValue = params.get("anchor");
    const anchor = isSceneAnchor(anchorValue) ? anchorValue : null;
    const developmentProgress = Number.parseFloat(params.get("progress") ?? "");
    const failedTextureValue = params.get("failTexture");
    const failedTextureTrack = /^track-\d{2}$/.test(failedTextureValue ?? "") ? failedTextureValue : null;
    const progress = anchor
      ? anchorToProgress(anchor)
      : Number.isFinite(developmentProgress)
        ? Math.max(0, Math.min(1, developmentProgress))
        : 0;
    return { anchor, enabled, failedTextureTrack, frozen: enabled && anchor !== null, progress };
  }, []);
}
