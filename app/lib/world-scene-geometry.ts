export type IntrinsicFrameSizeInput = {
  normalizedArea: number;
  sourceAspect: number;
  viewportHeight: number;
  viewportWidth: number;
  visibleHeight: number;
  visibleWidth: number;
};

/** Near-facing normal of the diagonal frame row; every overview frame shares it. */
export const WORLD_FRAME_NORMAL = [-0.72, -0.5, 0.48] as const;

export function shouldUseWorldSpaceRenderer(surface: "lab" | "library", qaWorldSpace: boolean) {
  return surface === "library" || qaWorldSpace;
}

export function getIntrinsicFrameSize({
  normalizedArea,
  sourceAspect,
  viewportHeight,
  viewportWidth,
  visibleHeight,
  visibleWidth,
}: IntrinsicFrameSizeInput) {
  const safeAspect = Math.max(0.01, sourceAspect);
  const safeArea = Math.max(0.0004, normalizedArea);
  const normalizedRatio = safeAspect * viewportHeight / Math.max(1, viewportWidth);
  const normalizedWidth = Math.sqrt(safeArea * normalizedRatio);
  const normalizedHeight = safeArea / normalizedWidth;
  return {
    height: normalizedHeight * visibleHeight,
    width: normalizedWidth * visibleWidth,
  };
}
