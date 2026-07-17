"use client";

import { useEffect, useMemo, useRef, type MutableRefObject } from "react";

export type VirtualProgressController = {
  frozen: boolean;
  impulse: (deltaPixels: number, viewportHeight: number) => void;
  jumpTo: (progress: number) => void;
  rendered: MutableRefObject<number>;
  step: (deltaSeconds: number) => number;
  target: MutableRefObject<number>;
  velocity: MutableRefObject<number>;
};

type Options = {
  frozen: boolean;
  initialProgress: number;
  reducedMotion: boolean;
};

export function useVirtualProgress({ frozen, initialProgress, reducedMotion }: Options): VirtualProgressController {
  const target = useRef(initialProgress);
  const rendered = useRef(initialProgress);
  const velocity = useRef(0);
  const frozenRef = useRef(frozen);
  const reducedRef = useRef(reducedMotion);
  useEffect(() => {
    frozenRef.current = frozen;
    reducedRef.current = reducedMotion;
  }, [frozen, reducedMotion]);

  return useMemo(() => ({
    frozen,
    impulse(deltaPixels: number, viewportHeight: number) {
      if (frozenRef.current || reducedRef.current) return;
      const impulse = Math.max(-650, Math.min(650, deltaPixels)) / Math.max(1, viewportHeight) * 0.16;
      const resistance = target.current < 0 || target.current > 1 ? 0.16 : 1;
      target.current = Math.max(-0.055, Math.min(1.055, target.current + impulse * resistance));
    },
    jumpTo(progress: number) {
      const next = Math.max(0, Math.min(1, progress));
      target.current = next;
      if (frozenRef.current || reducedRef.current) {
        rendered.current = next;
        velocity.current = 0;
      }
    },
    rendered,
    step(deltaSeconds: number) {
      if (frozenRef.current) {
        rendered.current = target.current;
        velocity.current = 0;
        return rendered.current;
      }
      const dt = Math.min(0.05, Math.max(0.001, deltaSeconds));
      if (target.current < 0) target.current += (0 - target.current) * (1 - Math.exp(-9 * dt));
      if (target.current > 1) target.current += (1 - target.current) * (1 - Math.exp(-9 * dt));
      const previous = rendered.current;
      const damping = reducedRef.current ? 1 : 1 - Math.exp(-6 * dt);
      rendered.current += (target.current - rendered.current) * damping;
      velocity.current = (rendered.current - previous) / dt;
      if (Math.abs(target.current - rendered.current) < 0.00001) {
        rendered.current = target.current;
        velocity.current = 0;
      }
      return rendered.current;
    },
    target,
    velocity,
  }), [frozen, rendered, target, velocity]);
}
