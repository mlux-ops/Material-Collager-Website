// Autoboard variants: building the exact CollageRequestInput the app's
// /api/generate endpoint expects.
//
// The variant table, hero ranking and note handling moved to
// app/lib/autoboard/variants.ts so the web review board runs the same rules;
// they are re-exported below, so every existing import is unchanged. What stays
// here needs node:path's basename, whose win32 vs posix behaviour differs on
// the operator's Windows library paths (docs/autoboard-shared-core.md).

import path from "node:path";

import {
  boardPayload as buildBoardPayload,
  boardReferenceFiles as buildBoardReferenceFiles,
} from "../../../app/lib/autoboard/variants.ts";

export {
  DEFAULT_VARIANTS,
  heroFor,
  modelNotes,
  orderedBoardItems,
  resolveHeroId,
  variantsFromCount,
} from "../../../app/lib/autoboard/variants.ts";

// node:path's basename, injected into both builders from this one place so the
// payload's imageNames and the multipart file names cannot drift apart. It is
// platform-sensitive by design: the library root is a Windows path, and on the
// operator's machine this strips the backslash-separated directories that a
// posix split would keep (docs/autoboard-shared-core.md).
const basename = (location) => path.basename(location);

export function boardPayload(board, variant, options = {}) {
  return buildBoardPayload(board, variant, { ...options, basename });
}

export function boardReferenceFiles(board) {
  return buildBoardReferenceFiles(board, basename);
}
