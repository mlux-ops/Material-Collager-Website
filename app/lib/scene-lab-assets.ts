export type LibraryCollageRecord = {
  collageType?: string;
  createdAt: number;
  filename?: string;
  format?: string;
  id: string;
  imageUrl: string;
  renderKind?: string;
  title: string;
};

export type SceneLabLibraryState = "loading" | "empty" | "populated" | "failed" | "malformed";

export type ParsedLibraryPayload =
  | { records: LibraryCollageRecord[]; valid: true }
  | { message: string; valid: false };

export type SceneLabCollageItem = {
  accessibleName: string;
  collageId: string;
  cropAnchor: readonly [number, number];
  id: string;
  instanceId: string;
  instanceLabel: string;
  repeated: boolean;
  route: string;
  sequenceIndex: number;
  sourceKind: "library-record" | "user-provided-lab-collage";
  title: string;
  url: string;
};

export type SceneLabCollageCatalog = {
  actualCollageCount: number;
  actualRecords: readonly LibraryCollageRecord[];
  items: readonly SceneLabCollageItem[];
  persistedCollageCount: number;
  repetitionRequired: boolean;
  source: "/api/library" | "user-provided-lab-collages" | "empty-production-library";
};

export type CompletedCollageAdapterOptions = {
  /** Isolated scene-lab only: never let these fixtures escape into production. */
  allowLabFixtures?: boolean;
  /** The 20-plane presentation window for a larger completed-collage library. */
  presentationOffset?: number;
};

export type LibraryCollageNavigationIntent = "previous" | "next" | "previousPage" | "nextPage" | "first" | "last";

export const SCENE_LAB_TRACK_COUNT = 20;

const CROP_ANCHORS = [
  [0.52, 0.42], [0.48, 0.52], [0.46, 0.5], [0.53, 0.48], [0.5, 0.5],
  [0.57, 0.46], [0.44, 0.54], [0.5, 0.47], [0.5, 0.5], [0.62, 0.52],
  [0.48, 0.5], [0.55, 0.48], [0.5, 0.5], [0.5, 0.53], [0.47, 0.46],
  [0.54, 0.5], [0.5, 0.5], [0.5, 0.48], [0.45, 0.52], [0.56, 0.5],
] as const;

// User-provided completed collages for the isolated lab while the local Library
// is empty. This deterministic seed manifest is not a parallel database.
const USER_PROVIDED_LAB_COLLAGES: readonly LibraryCollageRecord[] = [
  {
    collageType: "bathroom_fixture_collage",
    createdAt: 4,
    filename: "finish-collage-01.webp",
    format: "webp",
    id: "user-finish-collage-01",
    imageUrl: "/scene-lab/collages/finish-collage-01.webp",
    renderKind: "studio",
    title: "Warm oak fixture collage",
  },
  {
    collageType: "bathroom_fixture_collage",
    createdAt: 3,
    filename: "finish-collage-02.webp",
    format: "webp",
    id: "user-finish-collage-02",
    imageUrl: "/scene-lab/collages/finish-collage-02.webp",
    renderKind: "studio",
    title: "Graphite shower collage",
  },
  {
    collageType: "bathroom_fixture_collage",
    createdAt: 2,
    filename: "finish-collage-03.webp",
    format: "webp",
    id: "user-finish-collage-03",
    imageUrl: "/scene-lab/collages/finish-collage-03.webp",
    renderKind: "studio",
    title: "Sage terrazzo fixture collage",
  },
  {
    collageType: "bathroom_fixture_collage",
    createdAt: 1,
    filename: "finish-collage-04.webp",
    format: "webp",
    id: "user-finish-collage-04",
    imageUrl: "/scene-lab/collages/finish-collage-04.webp",
    renderKind: "studio",
    title: "White shower fixture collage",
  },
] as const;

function isLibraryCollageRecord(record: unknown): record is LibraryCollageRecord {
  if (!record || typeof record !== "object") return false;
  const candidate = record as Partial<LibraryCollageRecord>;
  return typeof candidate.id === "string"
    && typeof candidate.imageUrl === "string"
    && typeof candidate.title === "string"
    && typeof candidate.createdAt === "number"
    && Number.isFinite(candidate.createdAt);
}

export function parseLibraryPayload(payload: unknown): ParsedLibraryPayload {
  if (!payload || typeof payload !== "object") {
    return { message: "Library response was not an object.", valid: false };
  }
  const candidate = payload as { items?: unknown; ok?: unknown };
  if (candidate.ok !== true || !Array.isArray(candidate.items)) {
    return { message: "Library response did not contain an acknowledged items array.", valid: false };
  }
  if (!candidate.items.every(isLibraryCollageRecord)) {
    return { message: "Library response contained an invalid completed-collage record.", valid: false };
  }
  return { records: candidate.items, valid: true };
}

/**
 * One canonical record set for the production scene, semantic collection, and
 * detail actions. Keeping this at the API boundary prevents an older duplicate
 * or a rejected source asset from being selected after the scene has rendered.
 */
export function normalizeLibraryCollageRecords(records: readonly LibraryCollageRecord[]) {
  const seenIds = new Set<string>();
  return records
    .filter(isLibraryCollageRecord)
    .filter((record) => record.id.trim() && record.imageUrl.trim())
    .filter((record) => !/(?:^|\/)references(?:\/|$)|(?:^|\/)scene-lab(?:\/|$)/i.test(record.imageUrl))
    .map((record) => ({ ...record, title: record.title.trim() || "Untitled finish collage" }))
    .toSorted((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id))
    .filter((record) => {
      if (seenIds.has(record.id)) return false;
      seenIds.add(record.id);
      return true;
    });
}

/**
 * Production navigation is by completed-collage identity, never by one of the
 * repeated visual track instances that fill the spatial field.
 */
export function getLibraryCollageNavigationTarget(
  records: readonly LibraryCollageRecord[],
  currentId: string,
  intent: LibraryCollageNavigationIntent,
) {
  const currentIndex = records.findIndex((record) => record.id === currentId);
  if (currentIndex < 0 || records.length === 0) return null;
  const offset = intent === "previous" ? -1
    : intent === "next" ? 1
      : intent === "previousPage" ? -3
        : intent === "nextPage" ? 3
          : intent === "first" ? -currentIndex
            : records.length - 1 - currentIndex;
  return records[Math.max(0, Math.min(records.length - 1, currentIndex + offset))] ?? null;
}

export function getLibraryPresentationOffset(records: readonly LibraryCollageRecord[], collageId: string) {
  const recordIndex = records.findIndex((record) => record.id === collageId);
  if (recordIndex < 0) return null;
  return Math.max(0, Math.min(recordIndex - Math.floor(SCENE_LAB_TRACK_COUNT / 2), records.length - SCENE_LAB_TRACK_COUNT));
}

export function removeLibraryCollageRecord(records: readonly LibraryCollageRecord[], collageId: string) {
  return records.filter((record) => record.id !== collageId);
}

export function adaptCompletedCollages(
  records: readonly LibraryCollageRecord[],
  { allowLabFixtures = true, presentationOffset = 0 }: CompletedCollageAdapterOptions = {},
): SceneLabCollageCatalog {
  const actualRecords = normalizeLibraryCollageRecords(records);
  const visibleRecords = actualRecords.length > SCENE_LAB_TRACK_COUNT
    ? actualRecords.slice(
      Math.max(0, Math.min(presentationOffset, actualRecords.length - SCENE_LAB_TRACK_COUNT)),
      Math.max(0, Math.min(presentationOffset, actualRecords.length - SCENE_LAB_TRACK_COUNT)) + SCENE_LAB_TRACK_COUNT,
    )
    : actualRecords;
  const sourceRecords = visibleRecords.length > 0
    ? visibleRecords
    : allowLabFixtures
      ? USER_PROVIDED_LAB_COLLAGES
      : [];
  const sourceKind = actualRecords.length > 0 ? "library-record" : "user-provided-lab-collage";
  const occurrenceTotals = new Map<string, number>();

  for (let index = 0; index < SCENE_LAB_TRACK_COUNT && sourceRecords.length > 0; index += 1) {
    const record = sourceRecords[index % sourceRecords.length];
    occurrenceTotals.set(record.id, (occurrenceTotals.get(record.id) ?? 0) + 1);
  }

  const seen = new Map<string, number>();
  const items = sourceRecords.length === 0 ? [] : Array.from({ length: SCENE_LAB_TRACK_COUNT }, (_, index): SceneLabCollageItem => {
    const record = sourceRecords[index % sourceRecords.length];
    const occurrence = (seen.get(record.id) ?? 0) + 1;
    const occurrenceTotal = occurrenceTotals.get(record.id) ?? 1;
    seen.set(record.id, occurrence);
    const repeated = occurrenceTotal > 1;
    const instanceLabel = sourceKind === "user-provided-lab-collage" && repeated
      ? `Repeated lab instance ${String(occurrence).padStart(2, "0")} of ${String(occurrenceTotal).padStart(2, "0")}`
      : "Library finish collage";

    return {
      accessibleName: sourceKind === "user-provided-lab-collage" && repeated
        ? `${record.title}, completed finish collage, ${instanceLabel.toLowerCase()}`
        : `${record.title}, completed finish collage`,
      collageId: record.id,
      cropAnchor: CROP_ANCHORS[index],
      id: `track-${String(index + 1).padStart(2, "0")}`,
      instanceId: `scene-lab:${record.id}:${occurrence}`,
      instanceLabel,
      repeated,
      route: "/",
      sequenceIndex: index + 1,
      sourceKind,
      title: record.title,
      url: record.imageUrl,
    };
  });

  return {
    actualCollageCount: actualRecords.length || (allowLabFixtures ? sourceRecords.length : 0),
    actualRecords,
    items,
    persistedCollageCount: actualRecords.length,
    repetitionRequired: sourceRecords.length > 0 && sourceRecords.length < SCENE_LAB_TRACK_COUNT,
    source: actualRecords.length > 0
      ? "/api/library"
      : allowLabFixtures
        ? "user-provided-lab-collages"
        : "empty-production-library",
  };
}
