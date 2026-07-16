export type SceneLabDragState = {
  id: number;
  lastY: number;
  moved: boolean;
  startY: number;
};

export type PointerFinishReason = "pointerup" | "pointercancel" | "lostpointercapture";

export const IDLE_DRAG_STATE: SceneLabDragState = Object.freeze({ id: -1, lastY: 0, moved: false, startY: 0 });

export function beginPointerDrag(pointerId: number, clientY: number): SceneLabDragState {
  return { id: pointerId, lastY: clientY, moved: false, startY: clientY };
}

export function movePointerDrag(current: SceneLabDragState, pointerId: number, clientY: number) {
  if (current.id !== pointerId) return { delta: 0, drag: current, handled: false };
  const moved = current.moved || Math.abs(clientY - current.startY) >= 10;
  return {
    delta: moved ? current.lastY - clientY : 0,
    drag: { ...current, lastY: clientY, moved },
    handled: true,
  };
}

export function finishPointerDrag(
  current: SceneLabDragState,
  pointerId: number,
  reason: PointerFinishReason,
) {
  if (current.id !== pointerId) {
    return { drag: current, finished: false, reason, suppressClick: false };
  }
  return {
    drag: IDLE_DRAG_STATE,
    finished: true,
    reason,
    suppressClick: current.moved,
  };
}

