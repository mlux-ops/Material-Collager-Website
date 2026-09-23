import assert from "node:assert/strict";
import test from "node:test";
import { createDirtyChannel, decidePendingSave } from "../app/components/workbench/persistence.ts";

test("a save that lands after a newer edit leaves that edit owed", () => {
  const structure = createDirtyChannel();
  structure.edit();                  // edit A
  const saveA = structure.begin();   // A's autosave reads the store
  structure.edit();                  // edit B, while A's save is in flight
  structure.settle(saveA);           // A's save lands
  assert.equal(structure.dirty, true);
  assert.equal(decidePendingSave(structure.dirty, false), "structure");
});

test("an older save settling after a newer one leaves the channel dirty (its write landed last, overwriting the newer save)", () => {
  // saveGraph awaits a thumbnail before its transaction opens, so a
  // structure-only save that began later can still commit -- and settle --
  // first. Settles arrive in commit order, not begin order, so the older
  // save's later settle must win and reopen the channel: the store's
  // content no longer matches the edit the newer settle thought was saved.
  const channel = createDirtyChannel();
  channel.edit();
  const older = channel.begin();
  channel.edit();
  const newer = channel.begin();
  channel.settle(newer);
  channel.settle(older);
  assert.equal(channel.dirty, true);
});

test("settles that land in begin order read clean", () => {
  const channel = createDirtyChannel();
  channel.edit();
  const first = channel.begin();
  channel.settle(first);
  channel.edit();
  const second = channel.begin();
  channel.settle(second);
  assert.equal(channel.dirty, false);
});

test("a save that never settles (it failed) keeps the channel dirty", () => {
  const channel = createDirtyChannel();
  channel.edit();
  channel.begin();
  assert.equal(channel.dirty, true);
});

test("a fresh channel is clean", () => {
  assert.equal(createDirtyChannel().dirty, false);
});
