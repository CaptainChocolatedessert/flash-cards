/**
 * The shape of everything that is stored. See DESIGN.md, "What gets stored".
 *
 * This file is the one that is expensive to get wrong: a record shape that has
 * shipped and then changes needs migration code for as long as the app exists.
 * Hence `SCHEMA_VERSION` — every stored record and every export file carries it,
 * so a future change has something to key off rather than having to guess what
 * it is looking at.
 *
 * Everything here is plain JSON. No dates, no maps, no class instances: the
 * record has to survive `structuredClone` into IndexedDB and `JSON.stringify`
 * into the export file, and those two agreeing is worth more than convenience.
 */

import type {
  BandId,
  DifficultySetting,
  ItemState,
  ProficiencyState,
  TimingMode,
} from "../core/index.js";

/**
 * Bumped only when the shape changes incompatibly. A record from an older
 * version is either migrated on load or refused; a record from a *newer* version
 * is always refused, because guessing at a shape from the future is how data
 * gets silently mangled.
 */
export const SCHEMA_VERSION = 1;

/** The two games. Progress is kept separately for each; nothing is shared between them. */
export type SubjectId = "spelling" | "multiplication";

export const SUBJECT_IDS: readonly SubjectId[] = ["spelling", "multiplication"];

/** What the profile picker needs, without loading a whole record. */
export interface ProfileSummary {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  /** Last time a question was answered. Null until the first session. */
  readonly lastPlayedAt: number | null;
  /**
   * Last time the record was written. Distinct from `lastPlayedAt` — renaming
   * touches this and not that — and it is what decides the winner when an
   * imported backup collides with a profile that is already here.
   */
  readonly updatedAt: number;
}

/**
 * One keystroke. `t` is milliseconds since the question was shown, not epoch
 * time: the offsets are what any later analysis would want, and they compress
 * to two or three digits instead of thirteen.
 *
 * Recorded and deliberately not interpreted. DESIGN.md, "Store the keystroke
 * timeline anyway" — timings not recorded cannot be recovered, timings recorded
 * and unused cost a few bytes. Nothing should build an inference on these until
 * there is a reason to.
 */
export interface Keystroke {
  readonly t: number;
  readonly key: string;
}

/**
 * One answered question, in full.
 *
 * Richer than the `AttemptResult` the scheduler folds in, because this is the
 * archive rather than the input: it keeps which item and band the question came
 * from, whether it was a first exposure, and what was actually typed. That last
 * one is what makes a near-miss ("recieve") distinguishable from a blank later.
 *
 * `firstExposure` and `band` are here so the proficiency estimator can be
 * re-derived from history if open question 9 changes the rule about which
 * results feed it. Without them the archive would not support the recomputation
 * it exists to make possible.
 */
export interface RecordedAttempt {
  readonly itemId: string;
  readonly band: BandId;
  readonly firstExposure: boolean;
  readonly correct: boolean;
  readonly mode: TimingMode;
  /** Epoch ms when the answer was submitted. */
  readonly at: number;
  readonly elapsedMs: number;
  /** What the child typed. Empty string for a multiplication answer left blank. */
  readonly answer: string;
  readonly keystrokes: readonly Keystroke[];
}

/**
 * A finished session, kept after its individual attempts have aged out of the
 * rolling window. Small and permanent, so the trend lines in the readout do not
 * depend on the attempt archive still being there.
 */
export interface SessionSummary {
  readonly startedAt: number;
  readonly endedAt: number;
  readonly asked: number;
  readonly correct: number;
  /** New items introduced during the session. */
  readonly introduced: number;
  /**
   * Correct characters typed and the time they took, across the whole session.
   * Kept as the two raw numbers rather than a rate so sessions can be pooled
   * without averaging averages. Both stay zero for multiplication.
   */
  readonly correctChars: number;
  readonly typingMs: number;
}

/**
 * How many attempts are kept per subject before the oldest are dropped.
 *
 * Keystroke timelines grow without bound and nothing needs three years of them.
 * At roughly 300 bytes an attempt this is about 150KB per subject per child,
 * which keeps the export file comfortably emailable — the constraint that
 * actually decides the number. Session summaries survive the trim, so the
 * long-run trends do not depend on this window.
 */
export const ATTEMPT_WINDOW = 500;

/** Session summaries kept per subject. ~100 bytes each, so this is years of daily play. */
export const SESSION_HISTORY = 1000;

/** Everything stored for one child in one game. */
export interface SubjectProgress {
  readonly proficiency: ProficiencyState;
  /** The kid's harder/easier control. Persisted; open question 8 is whether it should decay. */
  readonly difficulty: DifficultySetting;
  /** Scheduling state, keyed by item id — the word, or the normalised `min×max` fact. */
  readonly items: Readonly<Record<string, ItemState>>;
  /** Rolling window, oldest first. Capped at `ATTEMPT_WINDOW`. */
  readonly attempts: readonly RecordedAttempt[];
  /** Oldest first. Capped at `SESSION_HISTORY`. */
  readonly sessions: readonly SessionSummary[];
}

/** One child's whole record. This is what `load` and `save` move. */
export interface ProgressRecord {
  readonly schemaVersion: number;
  readonly profile: ProfileSummary;
  readonly subjects: { readonly [S in SubjectId]: SubjectProgress };
}

/**
 * State that is not any one child's.
 *
 * Just the audio blacklist today. Shared rather than per-child because a bad
 * recording is objectively bad — open question 3, which is unresolved; if it
 * turns out one kid's "can't understand it" is the other's fine, this moves into
 * `SubjectProgress` and the merge rule below goes with it.
 */
export interface SharedState {
  readonly schemaVersion: number;
  /** Recording ids a child could not understand. The word falls through to the next recording. */
  readonly blockedRecordings: readonly string[];
}

/**
 * The export file. Everything, not one profile — this is the backup that has to
 * survive a wiped machine, and a backup that silently omits the other child is
 * worse than no backup.
 */
export interface Backup {
  /** A fixed marker, so an unrelated JSON file dropped on the import button is caught immediately. */
  readonly kind: "flash-cards-progress";
  readonly schemaVersion: number;
  readonly exportedAt: number;
  readonly profiles: readonly ProgressRecord[];
  readonly shared: SharedState;
}

export const BACKUP_KIND = "flash-cards-progress";
