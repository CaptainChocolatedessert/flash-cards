/**
 * The one implementation of `ProgressStore`, on IndexedDB.
 *
 * IndexedDB rather than `localStorage` because the record is structured and will
 * grow — per-item history for two children across thousands of words — and
 * `localStorage` is synchronous, string-only, and capped around 5MB. See
 * DESIGN.md, "The storage interface".
 *
 * `idb-keyval` rather than raw IndexedDB. Raw IndexedDB is an unusually hostile
 * API for what it does (request objects, event callbacks, transactions that
 * close if you await anything mid-flight) and none of that difficulty buys
 * anything here: this is a key-value store with three kinds of key.
 *
 * Nothing outside `src/storage` should import this file. Callers take a
 * `ProgressStore`; that is what keeps a second implementation possible.
 */

import { clear, createStore, del, entries, get, set, setMany, type UseStore } from "idb-keyval";

import type {
  Backup,
  ProfileSummary,
  ProgressRecord,
  SharedState,
} from "./types.js";
import { BACKUP_KIND, SCHEMA_VERSION } from "./types.js";
import type { ImportMode, ProgressStore } from "./store.js";
import { mergeShared, newRecord, newSharedState, pickNewer } from "./store.js";

const DEFAULT_DB_NAME = "flash-cards";
const STORE_NAME = "progress";

const PROFILE_PREFIX = "profile:";
const SHARED_KEY = "shared";

function profileKey(id: string): string {
  return `${PROFILE_PREFIX}${id}`;
}

/**
 * Profiles are found by scanning keys rather than kept in a separate index.
 *
 * An index would be one fewer read, and it would be a second copy of a fact that
 * can drift out of step with the records themselves — a profile that exists but
 * is not listed, or is listed but does not exist. With two children the scan is
 * free, so the failure mode is worth more than the read.
 */
function isProfileKey(key: IDBValidKey): key is string {
  return typeof key === "string" && key.startsWith(PROFILE_PREFIX);
}

export class IndexedDbProgressStore implements ProgressStore {
  #store: UseStore | null = null;
  /** Public so a test can open a second connection to the same database. */
  readonly dbName: string;

  constructor(dbName: string = DEFAULT_DB_NAME) {
    this.dbName = dbName;
  }

  /**
   * Opened on first use, not in the constructor. Constructing a store is
   * something a module can do at import time; opening a database is not, and in
   * tests the fake IndexedDB has to be installed on the global before anything
   * touches it.
   */
  #use(): UseStore {
    this.#store ??= createStore(this.dbName, STORE_NAME);
    return this.#store;
  }

  async #allRecords(): Promise<ProgressRecord[]> {
    const all = await entries(this.#use());
    return all
      .filter(([key]) => isProfileKey(key))
      .map(([, value]) => value as ProgressRecord);
  }

  async listProfiles(): Promise<ProfileSummary[]> {
    const records = await this.#allRecords();
    return records
      .map((r) => r.profile)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async createProfile(name: string, now: number = Date.now()): Promise<ProgressRecord> {
    const record = newRecord(name, now);
    await set(profileKey(record.profile.id), record, this.#use());
    return record;
  }

  async load(profileId: string): Promise<ProgressRecord | null> {
    const record = await get<ProgressRecord>(profileKey(profileId), this.#use());
    return record ?? null;
  }

  async save(record: ProgressRecord, now: number = Date.now()): Promise<void> {
    const stamped: ProgressRecord = {
      ...record,
      schemaVersion: SCHEMA_VERSION,
      profile: { ...record.profile, updatedAt: now },
    };
    await set(profileKey(stamped.profile.id), stamped, this.#use());
  }

  async deleteProfile(profileId: string): Promise<void> {
    await del(profileKey(profileId), this.#use());
  }

  async loadShared(): Promise<SharedState> {
    const shared = await get<SharedState>(SHARED_KEY, this.#use());
    return shared ?? newSharedState();
  }

  async saveShared(shared: SharedState): Promise<void> {
    await set(SHARED_KEY, { ...shared, schemaVersion: SCHEMA_VERSION }, this.#use());
  }

  async exportAll(now: number = Date.now()): Promise<Backup> {
    const [profiles, shared] = await Promise.all([this.#allRecords(), this.loadShared()]);
    return {
      kind: BACKUP_KIND,
      schemaVersion: SCHEMA_VERSION,
      exportedAt: now,
      profiles: profiles.sort((a, b) => a.profile.createdAt - b.profile.createdAt),
      shared,
    };
  }

  async importAll(backup: Backup, mode: ImportMode): Promise<void> {
    if (mode === "replace") {
      await clear(this.#use());
      await setMany(
        [
          ...backup.profiles.map((r) => [profileKey(r.profile.id), r] as [string, ProgressRecord]),
          [SHARED_KEY, backup.shared] as [string, SharedState],
        ],
        this.#use(),
      );
      return;
    }

    const existing = new Map((await this.#allRecords()).map((r) => [r.profile.id, r]));
    const merged = backup.profiles.map((incoming) => {
      const current = existing.get(incoming.profile.id);
      return current ? pickNewer(current, incoming) : incoming;
    });
    const shared = mergeShared(await this.loadShared(), backup.shared);

    await setMany(
      [
        ...merged.map((r) => [profileKey(r.profile.id), r] as [string, ProgressRecord]),
        [SHARED_KEY, shared] as [string, SharedState],
      ],
      this.#use(),
    );
  }
}
