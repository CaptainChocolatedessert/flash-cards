/**
 * The storage boundary. See DESIGN.md, "The storage interface".
 *
 * Everything above this line talks to `ProgressStore` and never learns what is
 * underneath it. That is the whole point: today there is one implementation, on
 * IndexedDB, because progress only has to be visible on one family desktop. If
 * cross-device sync is ever wanted, a second implementation slots in here and no
 * game code changes. The moment a caller knows it is talking to IndexedDB, that
 * option is gone — so nothing in `src/core` or the UI may import from
 * `indexeddb.ts` directly.
 *
 * Everything in this file besides the interface itself is a pure function over
 * records, so it is testable without a database.
 */

import { newProficiency } from "../core/index.js";
import type {
  Backup,
  ProfileSummary,
  ProgressRecord,
  RecordedAttempt,
  SessionSummary,
  SharedState,
  SubjectId,
  SubjectProgress,
} from "./types.js";
import { ATTEMPT_WINDOW, SCHEMA_VERSION, SESSION_HISTORY } from "./types.js";

/**
 * What an import does about profiles that are already here.
 *
 * `replace` is the restore-a-backup case: the database ends up as the file
 * describes and anything not in the file is gone. `merge` is the two-devices
 * case — profiles are matched by id and the one written most recently wins,
 * which is the only rule available without a server to arbitrate.
 */
export type ImportMode = "replace" | "merge";

export interface ProgressStore {
  listProfiles(): Promise<ProfileSummary[]>;
  createProfile(name: string, now?: number): Promise<ProgressRecord>;
  /** Null when there is no such profile, rather than throwing — a stale id in the URL or in memory is ordinary. */
  load(profileId: string): Promise<ProgressRecord | null>;
  /** Stamps `updatedAt` and refreshes the profile index. */
  save(record: ProgressRecord, now?: number): Promise<void>;
  deleteProfile(profileId: string): Promise<void>;

  loadShared(): Promise<SharedState>;
  saveShared(shared: SharedState): Promise<void>;

  exportAll(now?: number): Promise<Backup>;
  importAll(backup: Backup, mode: ImportMode): Promise<void>;
}

// ---------------------------------------------------------------------------
// Record construction
// ---------------------------------------------------------------------------

function newSubjectProgress(): SubjectProgress {
  return {
    proficiency: newProficiency(),
    difficulty: 0,
    items: {},
    attempts: [],
    sessions: [],
  };
}

/**
 * A profile id. Random rather than derived from the name, so renaming a child's
 * profile does not orphan their history and two profiles called "Sam" on
 * different devices stay distinct through an import.
 */
export function newProfileId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function newRecord(name: string, now: number, id: string = newProfileId()): ProgressRecord {
  return {
    schemaVersion: SCHEMA_VERSION,
    profile: { id, name, createdAt: now, lastPlayedAt: null, updatedAt: now },
    subjects: {
      spelling: newSubjectProgress(),
      multiplication: newSubjectProgress(),
    },
  };
}

export function newSharedState(): SharedState {
  return { schemaVersion: SCHEMA_VERSION, blockedRecordings: [] };
}

export function summarise(record: ProgressRecord): ProfileSummary {
  return record.profile;
}

// ---------------------------------------------------------------------------
// Record updates
// ---------------------------------------------------------------------------

/** Replace one subject's progress, leaving the other untouched. */
export function withSubject(
  record: ProgressRecord,
  subject: SubjectId,
  progress: SubjectProgress,
): ProgressRecord {
  return { ...record, subjects: { ...record.subjects, [subject]: progress } };
}

/**
 * Append an attempt, dropping the oldest once the window is full.
 *
 * The trim is here rather than at save time so the cap holds in memory too — a
 * long session should not grow an unbounded array and then quietly shed most of
 * it on the way to disk.
 */
export function appendAttempt(
  progress: SubjectProgress,
  attempt: RecordedAttempt,
  window: number = ATTEMPT_WINDOW,
): SubjectProgress {
  const attempts = [...progress.attempts, attempt];
  return { ...progress, attempts: attempts.slice(Math.max(0, attempts.length - window)) };
}

export function appendSession(
  progress: SubjectProgress,
  session: SessionSummary,
  history: number = SESSION_HISTORY,
): SubjectProgress {
  const sessions = [...progress.sessions, session];
  return { ...progress, sessions: sessions.slice(Math.max(0, sessions.length - history)) };
}

export function renameProfile(record: ProgressRecord, name: string): ProgressRecord {
  return { ...record, profile: { ...record.profile, name } };
}

/** Mark that a question was answered. Drives the "last played" line in the picker. */
export function markPlayed(record: ProgressRecord, at: number): ProgressRecord {
  return { ...record, profile: { ...record.profile, lastPlayedAt: at } };
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * Which of two records for the same profile to keep: the one written last.
 *
 * Deliberately whole-record and not field-by-field. A finer merge would have to
 * reconcile two divergent box states for the same word, and there is no correct
 * answer to that without knowing which session really happened later — a
 * last-writer-wins rule that is easy to explain beats a clever one that silently
 * invents a history neither device had.
 */
export function pickNewer(a: ProgressRecord, b: ProgressRecord): ProgressRecord {
  return b.profile.updatedAt > a.profile.updatedAt ? b : a;
}

export function mergeShared(a: SharedState, b: SharedState): SharedState {
  return {
    schemaVersion: SCHEMA_VERSION,
    blockedRecordings: [...new Set([...a.blockedRecordings, ...b.blockedRecordings])].sort(),
  };
}
