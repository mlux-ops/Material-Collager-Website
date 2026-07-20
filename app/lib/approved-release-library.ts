import type { GenerationJob } from "@/app/lib/generation-jobs";

type ApprovedReleaseEntry = Pick<GenerationJob, "id" | "filename" | "title" | "createdAt">;

const RELEASE_CREATED_AT = Date.UTC(2026, 6, 16, 12, 0, 0);
const RELEASE_EXPIRES_AT = Date.UTC(2027, 6, 16, 12, 0, 0);

const APPROVED_RELEASE_ENTRIES: readonly ApprovedReleaseEntry[] = [
  { id: "release-chrome-bathroom-package", filename: "chrome-bathroom-package.png", title: "Chrome Bathroom Package", createdAt: RELEASE_CREATED_AT + 8_000 },
  { id: "release-chrome-bathroom-package-v2", filename: "chrome-bathroom-package-v2.png", title: "Chrome Bathroom Package v2", createdAt: RELEASE_CREATED_AT + 7_000 },
  { id: "release-matte-black-bathroom-package", filename: "matte-black-bathroom-package.png", title: "Matte Black Bathroom Package", createdAt: RELEASE_CREATED_AT + 6_000 },
  { id: "release-kitchen-cabinet-package", filename: "kitchen-cabinet-package.png", title: "Kitchen Cabinet Package", createdAt: RELEASE_CREATED_AT + 5_000 },
  { id: "release-matte-white-terrazzo-bathroom-package", filename: "matte-white-terrazzo-bathroom-package.png", title: "Matte White Terrazzo Bathroom Package", createdAt: RELEASE_CREATED_AT + 4_000 },
  { id: "release-primary-bathroom-brizo-package", filename: "primary-bathroom-brizo-package.png", title: "Primary Bathroom Brizo Package", createdAt: RELEASE_CREATED_AT + 3_000 },
  { id: "release-primary-bathroom-kohler-package", filename: "primary-bathroom-kohler-package.png", title: "Primary Bathroom Kohler Package", createdAt: RELEASE_CREATED_AT + 2_000 },
  { id: "release-bathroom-tile-package", filename: "bathroom-tile-package.png", title: "Bathroom Tile Package", createdAt: RELEASE_CREATED_AT + 1_000 },
];

/**
 * A checked-in mirror of the approved release assets. It is only used when a
 * fresh local D1/R2 workspace has no persisted Library records yet; generated
 * Library entries remain the source of truth whenever they are available.
 */
export const approvedReleaseLibrary: readonly GenerationJob[] = APPROVED_RELEASE_ENTRIES.map((entry) => ({
  ...entry,
  mode: "immediate",
  status: "completed",
  openaiBatchId: null,
  outputKey: `release-library/${entry.filename}`,
  format: "png",
  renderKind: "final",
  collageType: "material_package",
  libraryVisible: true,
  estimatedUsd: null,
  usage: {},
  qa: { source: "approved-release-library", assetKey: entry.filename.replace(/\.png$/, "") },
  error: null,
  updatedAt: RELEASE_CREATED_AT,
  expiresAt: RELEASE_EXPIRES_AT,
}));

export function approvedReleaseImageUrl(filename: string) {
  return `/release-library/${encodeURIComponent(filename)}`;
}
