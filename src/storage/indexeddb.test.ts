// Must come first: it installs a fake IndexedDB on the global, and anything that
// opens a database before this line would find nothing there.
import "fake-indexeddb/auto";

import { describe, expect, it } from "vitest";
import { IndexedDbProgressStore } from "./indexeddb.js";
import { newSharedState } from "./store.js";
import { parseBackup, serialiseBackup } from "./backup.js";
import { populatedRecord, T0 } from "./fixtures.js";

/**
 * A fresh database per test. Sharing one would let a test that leaves state
 * behind pass or fail depending on ordering, which is the least useful kind of
 * flake.
 */
let counter = 0;
function freshStore(): IndexedDbProgressStore {
  counter += 1;
  return new IndexedDbProgressStore(`flash-cards-test-${counter}`);
}

/**
 * Reopen the same database through a new connection.
 *
 * This is the closest an automated test gets to "quit the browser and come
 * back": nothing is carried over in memory, the data has to come off the stored
 * database. It is not a substitute for actually restarting the browser — only
 * that proves the browser has not evicted the origin's storage — but it does
 * prove the record survives independently of the object that wrote it.
 */
function reopen(store: IndexedDbProgressStore): IndexedDbProgressStore {
  return new IndexedDbProgressStore(store.dbName);
}

describe("profiles", () => {
  it("lists a created profile and loads it back", async () => {
    const store = freshStore();
    const created = await store.createProfile("Sam", T0);

    expect(await store.listProfiles()).toEqual([created.profile]);
    expect(await store.load(created.profile.id)).toEqual(created);
  });

  it("returns null for an id that is not there", async () => {
    expect(await freshStore().load("nobody")).toBeNull();
  });

  it("lists profiles oldest first", async () => {
    const store = freshStore();
    await store.createProfile("Second", T0 + 1000);
    await store.createProfile("First", T0);
    expect((await store.listProfiles()).map((p) => p.name)).toEqual(["First", "Second"]);
  });

  it("deletes a profile without touching the other", async () => {
    const store = freshStore();
    const a = await store.createProfile("A", T0);
    const b = await store.createProfile("B", T0 + 1);

    await store.deleteProfile(a.profile.id);

    expect((await store.listProfiles()).map((p) => p.id)).toEqual([b.profile.id]);
    expect(await store.load(a.profile.id)).toBeNull();
  });
});

describe("saving", () => {
  it("round-trips a fully populated record through a reopened database", async () => {
    const store = freshStore();
    const record = populatedRecord();
    await store.save(record, T0 + 5000);

    const loaded = await reopen(store).load(record.profile.id);

    expect(loaded).toEqual({
      ...record,
      profile: { ...record.profile, updatedAt: T0 + 5000 },
    });
    // Spot-check the parts most likely to be quietly lost: nested numbers, the
    // keystroke arrays, and the per-band residuals.
    expect(loaded?.subjects.spelling.attempts[0]?.keystrokes).toHaveLength(5);
    expect(loaded?.subjects.spelling.proficiency.bands["6"]?.samples).toBe(1);
    expect(loaded?.subjects.multiplication.items["7x8"]?.box).toBe(5);
  });

  it("stamps updatedAt on every save", async () => {
    const store = freshStore();
    const record = await store.createProfile("Sam", T0);
    await store.save(record, T0 + 60_000);
    expect((await store.load(record.profile.id))?.profile.updatedAt).toBe(T0 + 60_000);
  });

  it("overwrites rather than accumulating", async () => {
    const store = freshStore();
    const record = await store.createProfile("Sam", T0);
    await store.save({ ...record, profile: { ...record.profile, name: "Renamed" } }, T0 + 1);
    const profiles = await store.listProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.name).toBe("Renamed");
  });
});

describe("shared state", () => {
  it("defaults to an empty blacklist", async () => {
    expect((await freshStore().loadShared()).blockedRecordings).toEqual([]);
  });

  it("round-trips through a reopened database", async () => {
    const store = freshStore();
    await store.saveShared({ ...newSharedState(), blockedRecordings: ["commons:abc.ogg"] });
    expect((await reopen(store).loadShared()).blockedRecordings).toEqual(["commons:abc.ogg"]);
  });
});

describe("export and import", () => {
  it("carries every profile and the shared state through a file and into an empty database", async () => {
    const source = freshStore();
    const sam = populatedRecord("Sam");
    const alex = populatedRecord("Alex", T0 + 1000);
    await source.save(sam, T0 + 10);
    await source.save(alex, T0 + 20);
    await source.saveShared({ ...newSharedState(), blockedRecordings: ["commons:bad.ogg"] });

    const text = serialiseBackup(await source.exportAll(T0 + 30));

    const target = freshStore();
    await target.importAll(parseBackup(text), "replace");

    expect((await target.listProfiles()).map((p) => p.name)).toEqual(["Sam", "Alex"]);
    expect((await target.loadShared()).blockedRecordings).toEqual(["commons:bad.ogg"]);
    expect(await target.load(sam.profile.id)).toEqual({
      ...sam,
      profile: { ...sam.profile, updatedAt: T0 + 10 },
    });
  });

  it("replace removes profiles the file does not contain", async () => {
    const store = freshStore();
    const keep = await store.createProfile("Keep", T0);
    const backup = await store.exportAll(T0);
    const drop = await store.createProfile("Drop", T0 + 1);

    await store.importAll(backup, "replace");

    expect((await store.listProfiles()).map((p) => p.id)).toEqual([keep.profile.id]);
    expect(await store.load(drop.profile.id)).toBeNull();
  });

  it("merge keeps the record that was written last", async () => {
    const store = freshStore();
    const record = populatedRecord("Sam");
    await store.save(record, T0 + 1000);

    const older = { ...record, profile: { ...record.profile, name: "Stale", updatedAt: T0 } };
    const newer = { ...record, profile: { ...record.profile, name: "Fresh", updatedAt: T0 + 9999 } };

    await store.importAll(
      { kind: "flash-cards-progress", schemaVersion: 1, exportedAt: T0, profiles: [older], shared: newSharedState() },
      "merge",
    );
    expect((await store.load(record.profile.id))?.profile.name).toBe("Sam");

    await store.importAll(
      { kind: "flash-cards-progress", schemaVersion: 1, exportedAt: T0, profiles: [newer], shared: newSharedState() },
      "merge",
    );
    expect((await store.load(record.profile.id))?.profile.name).toBe("Fresh");
  });

  it("merge adds unseen profiles and keeps existing ones", async () => {
    const store = freshStore();
    const mine = await store.createProfile("Mine", T0);
    const theirs = populatedRecord("Theirs", T0 + 1);

    await store.importAll(
      { kind: "flash-cards-progress", schemaVersion: 1, exportedAt: T0, profiles: [theirs], shared: newSharedState() },
      "merge",
    );

    const names = (await store.listProfiles()).map((p) => p.name).sort();
    expect(names).toEqual(["Mine", "Theirs"]);
    expect(await store.load(mine.profile.id)).not.toBeNull();
  });

  it("merge unions the blacklist from both sides", async () => {
    const store = freshStore();
    await store.saveShared({ ...newSharedState(), blockedRecordings: ["a"] });

    await store.importAll(
      {
        kind: "flash-cards-progress",
        schemaVersion: 1,
        exportedAt: T0,
        profiles: [],
        shared: { ...newSharedState(), blockedRecordings: ["b"] },
      },
      "merge",
    );

    expect((await store.loadShared()).blockedRecordings).toEqual(["a", "b"]);
  });
});
