import assert from "node:assert/strict";
import test from "node:test";

import {
  COLLAGE_TYPES,
  ORIENTATIONS,
  resolvedOrientation,
  resolvedSize,
  validateCollageRequest,
} from "../app/lib/collage.ts";

function requestFor(collageType, orientation, extra = {}) {
  return {
    collageType,
    orientation,
    quality: "medium",
    items: [{ id: "sample", role: "wall tile", imageKeys: ["sample.png"] }],
    ...extra,
  };
}

// Orientation used to be gated per collage type: bathroom_tile_collage was
// rejected unless it resolved to portrait, and "square" was accepted only for
// bathroom_fixture_collage. Both gates were product taste, not a model or
// canvas constraint -- resolvedSize maps every orientation for every type --
// and they surfaced only at execute time, after the Collage Board's
// Orientation menu had already offered the choice.
test("every collage type accepts every orientation", () => {
  for (const collageType of COLLAGE_TYPES) {
    for (const orientation of ORIENTATIONS) {
      const request = requestFor(collageType, orientation);
      assert.doesNotThrow(
        () => validateCollageRequest(request),
        `${collageType} should accept orientation "${orientation}"`,
      );
      assert.ok(
        /^\d+x\d+$/.test(resolvedSize(request)),
        `${collageType}/${orientation} should resolve to a concrete canvas`,
      );
    }
  }
});

test("an explicit orientation always wins, and \"default\" still keeps each type's house orientation", () => {
  for (const collageType of COLLAGE_TYPES) {
    for (const orientation of ORIENTATIONS.filter((value) => value !== "default")) {
      assert.equal(resolvedOrientation(requestFor(collageType, orientation)), orientation);
    }
  }

  assert.equal(resolvedOrientation(requestFor("bathroom_tile_collage", "default")), "portrait");
  assert.equal(resolvedOrientation(requestFor("kitchen_material_palette", "default")), "landscape");
  assert.equal(resolvedOrientation(requestFor("appliance_collage", "default")), "landscape");
  assert.equal(resolvedOrientation(requestFor("bathroom_fixture_collage", "default")), "landscape");
});
