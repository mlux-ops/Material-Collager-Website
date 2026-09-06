// Reference-image dimension metadata (finding F2a): flags library photos that
// are too low-resolution to hold up as a generation reference — WITHOUT ever
// excluding them from a board. Low resolution is a quality-review concern,
// not a matching failure, so it's surfaced as a gap the human can see and
// decide about, same spirit as every other gap in this pipeline.

import sharp from "sharp";

export async function annotateReferenceMeta(boards, gaps, { minLongEdge = 600, minShortEdge = 600 } = {}) {
  gaps.lowResolutionReferences ??= [];
  for (const board of boards) {
    for (const item of board.items) {
      const imageMeta = [];
      for (const imagePath of item.images) {
        let metadata;
        try {
          metadata = await sharp(imagePath).metadata();
        } catch (error) {
          imageMeta.push({ path: imagePath, error: error.message });
          continue;
        }
        const width = metadata.width ?? 0;
        const height = metadata.height ?? 0;
        imageMeta.push({ path: imagePath, width, height });
        // A thin strip (e.g. 122x1200) clears the long-edge floor while being
        // a far worse generation reference than a small-but-square photo, so
        // the short edge is checked too — either one failing is a gap.
        const longEdge = Math.max(width, height);
        const shortEdge = Math.min(width, height);
        const shortEdgeFails = shortEdge < minShortEdge;
        const longEdgeFails = longEdge < minLongEdge;
        if (shortEdgeFails || longEdgeFails) {
          const reason = shortEdgeFails ? `short edge ${shortEdge} px` : `long edge ${longEdge} px`;
          gaps.lowResolutionReferences.push({
            unitType: board.unitType,
            roomLabel: board.roomLabel,
            collageType: board.collageType,
            slotId: item.slotId,
            itemName: item.name,
            path: imagePath,
            width,
            height,
            reason,
          });
        }
      }
      item.imageMeta = imageMeta;
    }
  }
}
