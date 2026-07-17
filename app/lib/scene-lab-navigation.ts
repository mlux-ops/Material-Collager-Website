export type NavigationRole = "near" | "focal" | "adjacent" | "mid" | "far";

export type NavigationSample = {
  dominant: boolean;
  focal: boolean;
  progress: number;
  role: NavigationRole;
  trackId: string;
  zRank: number;
};

export type TrackNavigationTarget = NavigationSample & {
  sequenceIndex: number;
};

function sequenceIndex(trackId: string) {
  const parsed = Number.parseInt(trackId.replace(/^track-/, ""), 10);
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}

function roleRank(role: NavigationRole) {
  switch (role) {
    case "focal": return 0;
    case "adjacent": return 1;
    case "near": return 2;
    case "mid": return 3;
    case "far": return 4;
  }
}

function sampleScore(sample: NavigationSample) {
  if (sample.focal) return 0;
  if (sample.dominant) return 10 + roleRank(sample.role) + Math.abs(sample.zRank + 2) / 10;
  return 100 + roleRank(sample.role) * 10 + Math.abs(sample.zRank + 2);
}

export function buildTrackNavigation(samples: readonly NavigationSample[]): TrackNavigationTarget[] {
  const byTrack = new Map<string, NavigationSample[]>();
  for (const sample of samples) {
    const entries = byTrack.get(sample.trackId) ?? [];
    entries.push(sample);
    byTrack.set(sample.trackId, entries);
  }
  return [...byTrack.entries()]
    .map(([trackId, entries]) => {
      const best = entries.toSorted((left, right) => sampleScore(left) - sampleScore(right) || left.progress - right.progress)[0];
      return { ...best, sequenceIndex: sequenceIndex(trackId) };
    })
    .toSorted((left, right) => left.sequenceIndex - right.sequenceIndex || left.trackId.localeCompare(right.trackId));
}

export function nearestReachableTrack(
  targets: readonly TrackNavigationTarget[],
  preferredTrackId: string | null,
) {
  if (targets.length === 0) return null;
  const exact = targets.find((target) => target.trackId === preferredTrackId);
  if (exact) return exact;
  const preferredIndex = preferredTrackId ? sequenceIndex(preferredTrackId) : targets[0].sequenceIndex;
  return targets.reduce((best, target) => {
    const distance = Math.abs(target.sequenceIndex - preferredIndex);
    const bestDistance = Math.abs(best.sequenceIndex - preferredIndex);
    return distance < bestDistance || (distance === bestDistance && target.sequenceIndex < best.sequenceIndex) ? target : best;
  }, targets[0]);
}

