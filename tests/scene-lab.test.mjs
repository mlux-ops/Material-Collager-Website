import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  adaptCompletedCollages,
  getLibraryCollageNavigationTarget,
  getLibraryPresentationOffset,
  normalizeLibraryCollageRecords,
  parseLibraryPayload,
  removeLibraryCollageRecord,
} from "../app/lib/scene-lab-assets.ts";
import { buildTrackNavigation, nearestReachableTrack } from "../app/lib/scene-lab-navigation.ts";
import {
  beginPointerDrag,
  finishPointerDrag,
  IDLE_DRAG_STATE,
  movePointerDrag,
} from "../app/lib/scene-lab-pointer.ts";
import { getIntrinsicFrameSize, WORLD_FRAME_NORMAL } from "../app/lib/world-scene-geometry.ts";

const geometry = JSON.parse(await readFile(new URL("../artifacts/reference-audit/reference-geometry.json", import.meta.url), "utf8"));
const anchorProgress = new Map([["p00", 0], ["p20", 0.2], ["p40", 0.4], ["p60", 0.6], ["p80", 0.8], ["p100", 1]]);

function navigationFor(viewportKey) {
  const anchors = geometry.viewports[viewportKey].anchors;
  return buildTrackNavigation(Object.entries(anchors).flatMap(([anchor, state]) => state.planes.map((plane) => ({
    dominant: plane.dominant,
    focal: plane.focal,
    progress: anchorProgress.get(anchor),
    role: plane.role,
    trackId: plane.track_id,
    zRank: plane.z_rank,
  }))));
}

test("populated Library records are ordered, preserved, and repeated deterministically", () => {
  const catalog = adaptCompletedCollages([
    { id: "older", imageUrl: "/api/library/older/image", title: "Older", createdAt: 10 },
    { id: "newer", imageUrl: "/api/library/newer/image", title: "Newer", createdAt: 20 },
  ]);
  assert.equal(catalog.source, "/api/library");
  assert.equal(catalog.persistedCollageCount, 2);
  assert.equal(catalog.actualCollageCount, 2);
  assert.equal(catalog.items.length, 20);
  assert.deepEqual(catalog.items.slice(0, 4).map((item) => item.collageId), ["newer", "older", "newer", "older"]);
  assert.ok(catalog.items.every((item) => item.sourceKind === "library-record"));
  assert.equal(new Set(catalog.items.map((item) => item.instanceId)).size, 20);
});

test("empty Library uses only four completed lab collages and five honest repetitions each", () => {
  const catalog = adaptCompletedCollages([]);
  const ids = [...new Set(catalog.items.map((item) => item.collageId))];
  assert.equal(catalog.source, "user-provided-lab-collages");
  assert.equal(catalog.persistedCollageCount, 0);
  assert.equal(catalog.actualCollageCount, 4);
  assert.equal(catalog.items.length, 20);
  assert.deepEqual(ids, [
    "user-finish-collage-01",
    "user-finish-collage-02",
    "user-finish-collage-03",
    "user-finish-collage-04",
  ]);
  for (const id of ids) assert.equal(catalog.items.filter((item) => item.collageId === id).length, 5);
  assert.ok(catalog.items.every((item) => item.repeated && item.instanceLabel.includes("of 05")));
  assert.ok(catalog.items.every((item) => item.url.startsWith("/scene-lab/collages/")));
  assert.ok(catalog.items.every((item) => !item.url.includes("references/assets") && item.sourceKind === "user-provided-lab-collage"));
});

test("production empty Library remains empty and never promotes lab fixtures", () => {
  const catalog = adaptCompletedCollages([], { allowLabFixtures: false });
  assert.equal(catalog.source, "empty-production-library");
  assert.equal(catalog.persistedCollageCount, 0);
  assert.equal(catalog.actualCollageCount, 0);
  assert.equal(catalog.items.length, 0);
});

test("production repetitions remain presentation-only and never use lab labels", () => {
  const catalog = adaptCompletedCollages([
    { id: "production", imageUrl: "/api/library/production/image", title: "Production finish", createdAt: 1 },
  ], { allowLabFixtures: false });
  assert.equal(catalog.items.length, 20);
  assert.ok(catalog.items.every((item) => item.sourceKind === "library-record"));
  assert.ok(catalog.items.every((item) => item.instanceLabel === "Library finish collage"));
  assert.ok(catalog.items.every((item) => !item.accessibleName.includes("Repeated lab instance")));
});

test("invalid adapter records are excluded without creating reference-asset scene items", () => {
  const catalog = adaptCompletedCollages([
    { id: "valid", imageUrl: "/api/library/valid/image", title: "Valid", createdAt: 1 },
    { id: "reference", imageUrl: "/references/assets/source.png", title: "Invalid", createdAt: 2 },
    { id: "bad", imageUrl: "", title: "Invalid", createdAt: 3 },
  ]);
  assert.equal(catalog.actualCollageCount, 1);
  assert.ok(catalog.items.every((item) => item.collageId === "valid" && item.url === "/api/library/valid/image"));
});

test("duplicate production IDs retain one newest record and keep semantic counts honest", () => {
  const catalog = adaptCompletedCollages([
    { id: "same", imageUrl: "/api/library/same/old", title: "Older duplicate", createdAt: 1 },
    { id: "other", imageUrl: "/api/library/other/image", title: "Other", createdAt: 2 },
    { id: "same", imageUrl: "/api/library/same/new", title: "Newest duplicate", createdAt: 3 },
  ], { allowLabFixtures: false });
  assert.equal(catalog.actualCollageCount, 2);
  assert.equal(catalog.persistedCollageCount, 2);
  assert.deepEqual([...new Set(catalog.items.map((item) => item.collageId))], ["same", "other"]);
  assert.equal(catalog.items.find((item) => item.collageId === "same")?.url, "/api/library/same/new");
});

test("selection and removal consume the same normalized records as the rendered catalog", () => {
  const records = normalizeLibraryCollageRecords([
    { id: "same", imageUrl: "/api/library/same/old", title: "Older duplicate", createdAt: 1 },
    { id: "source", imageUrl: "/references/assets/source.png", title: "Source image", createdAt: 4 },
    { id: "same", imageUrl: "/api/library/same/new", title: "Newest duplicate", createdAt: 3 },
  ]);
  assert.deepEqual(records.map((record) => [record.id, record.title, record.imageUrl]), [
    ["same", "Newest duplicate", "/api/library/same/new"],
  ]);
  assert.equal(adaptCompletedCollages(records, { allowLabFixtures: false }).items[0].title, records[0].title);
});

test("a Library larger than the plane field retains every semantic record while presenting a bounded scene window", () => {
  const records = Array.from({ length: 25 }, (_, index) => ({
    id: `record-${String(index + 1).padStart(2, "0")}`,
    imageUrl: `/api/library/${index + 1}/image`,
    title: `Record ${index + 1}`,
    createdAt: 25 - index,
  }));
  const catalog = adaptCompletedCollages(records, { allowLabFixtures: false, presentationOffset: 5 });
  assert.equal(catalog.actualCollageCount, 25);
  assert.equal(catalog.actualRecords.length, 25);
  assert.equal(catalog.items.length, 20);
  assert.deepEqual(catalog.items.slice(0, 2).map((item) => item.collageId), ["record-06", "record-07"]);
});

test("production keyboard navigation and removal operate on real collage records, not visual tracks", () => {
  const records = normalizeLibraryCollageRecords(Array.from({ length: 25 }, (_, index) => ({
    id: `record-${String(index + 1).padStart(2, "0")}`,
    imageUrl: `/api/library/${index + 1}/image`,
    title: `Record ${index + 1}`,
    createdAt: 25 - index,
  })));
  assert.equal(getLibraryCollageNavigationTarget(records, "record-12", "previousPage")?.id, "record-09");
  assert.equal(getLibraryCollageNavigationTarget(records, "record-12", "nextPage")?.id, "record-15");
  assert.equal(getLibraryCollageNavigationTarget(records, "record-12", "first")?.id, "record-01");
  assert.equal(getLibraryCollageNavigationTarget(records, "record-12", "last")?.id, "record-25");
  assert.equal(getLibraryPresentationOffset(records, "record-25"), 5);
  const remaining = removeLibraryCollageRecord(records, "record-12");
  assert.equal(remaining.length, 24);
  assert.equal(remaining.some((record) => record.id === "record-12"), false);
});

test("Library payload parsing distinguishes valid and malformed responses", () => {
  assert.deepEqual(parseLibraryPayload({ ok: true, items: [] }), { records: [], valid: true });
  assert.equal(parseLibraryPayload({ ok: true, items: "not-an-array" }).valid, false);
  assert.equal(parseLibraryPayload({ ok: true, items: [{ id: "missing-fields" }] }).valid, false);
  assert.equal(parseLibraryPayload({ ok: false, items: [] }).valid, false);
});

test("geometry-derived navigation exposes only reachable tracks at every viewport", () => {
  const expected = new Map([["1440x900", 20], ["1280x800", 20], ["1024x768", 19], ["390x844", 18]]);
  for (const [viewport, count] of expected) {
    const navigation = navigationFor(viewport);
    assert.equal(navigation.length, count, viewport);
    assert.equal(navigation.at(-1).trackId, `track-${String(count).padStart(2, "0")}`, viewport);
    for (const target of navigation) {
      const anchor = [...anchorProgress].find(([, progress]) => progress === target.progress)[0];
      const exists = geometry.viewports[viewport].anchors[anchor].planes.some((plane) => plane.track_id === target.trackId);
      assert.ok(exists, `${viewport} ${target.trackId} must exist at ${anchor}`);
    }
  }
});

test("navigation prefers focal states and reconciles unavailable mobile tracks", () => {
  const mobile = navigationFor("390x844");
  for (const target of mobile) {
    const hasFocal = Object.values(geometry.viewports["390x844"].anchors).some((state) => state.planes.some((plane) => plane.track_id === target.trackId && plane.focal));
    if (hasFocal) assert.equal(target.focal, true, target.trackId);
  }
  assert.equal(mobile.find((target) => target.trackId === "track-18").progress, 1);
  assert.equal(mobile.some((target) => target.trackId === "track-19" || target.trackId === "track-20"), false);
  assert.equal(nearestReachableTrack(mobile, "track-20").trackId, "track-18");
});

test("pointer up, cancel, and lost capture share complete drag cleanup", () => {
  const started = beginPointerDrag(7, 200);
  const moved = movePointerDrag(started, 7, 180);
  assert.equal(moved.handled, true);
  assert.equal(moved.drag.moved, true);
  for (const reason of ["pointerup", "pointercancel", "lostpointercapture"]) {
    const result = finishPointerDrag(moved.drag, 7, reason);
    assert.equal(result.finished, true);
    assert.equal(result.suppressClick, true);
    assert.deepEqual(result.drag, IDLE_DRAG_STATE);
    assert.equal(movePointerDrag(result.drag, 7, 160).handled, false);
  }
});

test("pointer cleanup ignores unrelated pointer IDs and preserves tap clicks", () => {
  const tap = beginPointerDrag(3, 100);
  assert.equal(finishPointerDrag(tap, 4, "pointercancel").finished, false);
  const finished = finishPointerDrag(tap, 3, "pointerup");
  assert.equal(finished.suppressClick, false);
  assert.deepEqual(finished.drag, IDLE_DRAG_STATE);
});

test("world-space frames preserve every decoded source aspect without slot cropping", () => {
  for (const sourceAspect of [0.625, 1, 1.5, 1.777]) {
    const frame = getIntrinsicFrameSize({
      normalizedArea: 0.08,
      sourceAspect,
      viewportHeight: 900,
      viewportWidth: 1440,
      visibleHeight: 5.1,
      visibleWidth: 8.16,
    });
    assert.ok(Math.abs(frame.width / frame.height - sourceAspect) < 0.001, `${sourceAspect} must remain intrinsic`);
  }
});

test("the world-space overview exposes one shared row-aligned frame normal", () => {
  assert.equal(WORLD_FRAME_NORMAL.length, 3);
  assert.ok(WORLD_FRAME_NORMAL.every(Number.isFinite));
  assert.ok(Math.abs(Math.hypot(...WORLD_FRAME_NORMAL) - 1) < 0.01);
  assert.ok(WORLD_FRAME_NORMAL[2] > 0);
});
