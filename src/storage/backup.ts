/**
 * The export file, as text. See DESIGN.md, "Storage durability".
 *
 * This is the actual backup story — the only thing that survives a reinstalled
 * OS, and the manual sync path if a second device ever appears before a real
 * backend does. It is also the one entry point where data arrives from outside
 * the app, so it is the one place that has to distrust its input.
 *
 * Kept as pure string-to-value functions with no DOM in sight, so the validator
 * can be tested directly. Picking and downloading the file is the UI's job.
 */

import type { AttemptResult, Box, DifficultySetting, ItemState, TimingMode } from "../core/index.js";
import type {
  Backup,
  Keystroke,
  ProfileSummary,
  ProgressRecord,
  RecordedAttempt,
  SessionSummary,
  SharedState,
  SubjectProgress,
} from "./types.js";
import { BACKUP_KIND, SCHEMA_VERSION, SUBJECT_IDS } from "./types.js";

/** Thrown for any file that is not a usable backup. The message is shown to the user, so it says what is wrong. */
export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupError";
  }
}

export function serialiseBackup(backup: Backup): string {
  // Compact rather than indented: with a full attempt archive the pretty-printed
  // form is roughly double the size for no benefit a text editor cannot provide.
  return JSON.stringify(backup);
}

/** `flash-cards-progress-2026-08-08.json` — sorts chronologically in a downloads folder. */
export function backupFilename(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `flash-cards-progress-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`;
}

// ---------------------------------------------------------------------------
// Validation
//
// Deeper than it looks necessary, and deliberately so. The failure that matters
// is not a file that is obviously wrong — that one throws on the first field.
// It is a file that is *nearly* right, where one number has become null or NaN
// and it lands in the estimator, which then produces NaN for every prediction
// forever with no error anywhere. Every number below is checked for being finite
// for that reason.
// ---------------------------------------------------------------------------

function fail(what: string): never {
  throw new BackupError(what);
}

function obj(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${what} is missing or is not an object`);
  }
  return value as Record<string, unknown>;
}

function arr(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) fail(`${what} is missing or is not a list`);
  return value;
}

function num(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${what} is not a finite number`);
  }
  return value;
}

function str(value: unknown, what: string): string {
  if (typeof value !== "string") fail(`${what} is not text`);
  return value;
}

function bool(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") fail(`${what} is not true or false`);
  return value;
}

function nullableNum(value: unknown, what: string): number | null {
  return value === null ? null : num(value, what);
}

function parseKeystroke(value: unknown, what: string): Keystroke {
  const k = obj(value, what);
  return { t: num(k["t"], `${what}.t`), key: str(k["key"], `${what}.key`) };
}

function parseAttempt(value: unknown, what: string): RecordedAttempt {
  const a = obj(value, what);
  return {
    itemId: str(a["itemId"], `${what}.itemId`),
    band: str(a["band"], `${what}.band`),
    firstExposure: bool(a["firstExposure"], `${what}.firstExposure`),
    correct: bool(a["correct"], `${what}.correct`),
    mode: parseMode(a["mode"], `${what}.mode`),
    at: num(a["at"], `${what}.at`),
    elapsedMs: num(a["elapsedMs"], `${what}.elapsedMs`),
    answer: str(a["answer"], `${what}.answer`),
    keystrokes: arr(a["keystrokes"], `${what}.keystrokes`).map((k, i) =>
      parseKeystroke(k, `${what}.keystrokes[${i}]`),
    ),
  };
}

function parseSession(value: unknown, what: string): SessionSummary {
  const s = obj(value, what);
  return {
    startedAt: num(s["startedAt"], `${what}.startedAt`),
    endedAt: num(s["endedAt"], `${what}.endedAt`),
    asked: num(s["asked"], `${what}.asked`),
    correct: num(s["correct"], `${what}.correct`),
    introduced: num(s["introduced"], `${what}.introduced`),
    correctChars: num(s["correctChars"], `${what}.correctChars`),
    typingMs: num(s["typingMs"], `${what}.typingMs`),
  };
}

function parseMode(value: unknown, what: string): TimingMode {
  const mode = str(value, what);
  if (mode !== "timed" && mode !== "untimed") fail(`${what} is not "timed" or "untimed"`);
  return mode;
}

function parseAttemptResult(value: unknown, what: string): AttemptResult {
  const r = obj(value, what);
  return {
    correct: bool(r["correct"], `${what}.correct`),
    mode: parseMode(r["mode"], `${what}.mode`),
    at: num(r["at"], `${what}.at`),
    elapsedMs: num(r["elapsedMs"], `${what}.elapsedMs`),
  };
}

function parseItem(value: unknown, what: string): ItemState {
  const s = obj(value, what);
  const box = num(s["box"], `${what}.box`);
  if (!Number.isInteger(box) || box < 1 || box > 6) fail(`${what}.box is not a box number (1-6)`);
  const lastResultRaw = s["lastResult"];
  return {
    itemId: str(s["itemId"], `${what}.itemId`),
    box: box as Box,
    dueAt: nullableNum(s["dueAt"], `${what}.dueAt`),
    timesSeen: num(s["timesSeen"], `${what}.timesSeen`),
    timesCorrect: num(s["timesCorrect"], `${what}.timesCorrect`),
    lastResult:
      lastResultRaw === null || lastResultRaw === undefined
        ? null
        : parseAttemptResult(lastResultRaw, `${what}.lastResult`),
  };
}

function parseSubject(value: unknown, what: string): SubjectProgress {
  const s = obj(value, what);
  const p = obj(s["proficiency"], `${what}.proficiency`);
  const bandsRaw = obj(p["bands"], `${what}.proficiency.bands`);
  const bands: Record<string, { residual: number; samples: number }> = {};
  for (const [band, raw] of Object.entries(bandsRaw)) {
    const b = obj(raw, `${what}.proficiency.bands.${band}`);
    bands[band] = {
      residual: num(b["residual"], `${what}.proficiency.bands.${band}.residual`),
      samples: num(b["samples"], `${what}.proficiency.bands.${band}.samples`),
    };
  }

  const difficulty = num(s["difficulty"], `${what}.difficulty`);
  if (!Number.isInteger(difficulty) || difficulty < -2 || difficulty > 2) {
    fail(`${what}.difficulty is outside the -2..2 range`);
  }

  const itemsRaw = obj(s["items"], `${what}.items`);
  const items: Record<string, ItemState> = {};
  for (const [id, raw] of Object.entries(itemsRaw)) {
    items[id] = parseItem(raw, `${what}.items["${id}"]`);
  }

  return {
    proficiency: {
      ability: num(p["ability"], `${what}.proficiency.ability`),
      observations: num(p["observations"], `${what}.proficiency.observations`),
      information: num(p["information"], `${what}.proficiency.information`),
      bands,
    },
    difficulty: difficulty as DifficultySetting,
    items,
    attempts: arr(s["attempts"], `${what}.attempts`).map((a, i) =>
      parseAttempt(a, `${what}.attempts[${i}]`),
    ),
    sessions: arr(s["sessions"], `${what}.sessions`).map((x, i) =>
      parseSession(x, `${what}.sessions[${i}]`),
    ),
  };
}

function parseProfileSummary(value: unknown, what: string): ProfileSummary {
  const p = obj(value, what);
  const name = str(p["name"], `${what}.name`);
  return {
    id: str(p["id"], `${what}.id`),
    name,
    createdAt: num(p["createdAt"], `${what}.createdAt`),
    lastPlayedAt: nullableNum(p["lastPlayedAt"], `${what}.lastPlayedAt`),
    updatedAt: num(p["updatedAt"], `${what}.updatedAt`),
  };
}

function parseRecord(value: unknown, what: string): ProgressRecord {
  const r = obj(value, what);
  const profile = parseProfileSummary(r["profile"], `${what}.profile`);
  const subjectsRaw = obj(r["subjects"], `${what}.subjects`);
  const spelling = parseSubject(subjectsRaw["spelling"], `${what}.subjects.spelling`);
  const multiplication = parseSubject(
    subjectsRaw["multiplication"],
    `${what}.subjects.multiplication`,
  );
  // The union is closed, so this is exhaustive by construction; the loop exists
  // to fail loudly if a third subject is ever added and missed here.
  for (const id of SUBJECT_IDS) {
    if (subjectsRaw[id] === undefined) fail(`${what}.subjects.${id} is missing`);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    profile,
    subjects: { spelling, multiplication },
  };
}

function parseShared(value: unknown, what: string): SharedState {
  const s = obj(value, what);
  return {
    schemaVersion: SCHEMA_VERSION,
    blockedRecordings: arr(s["blockedRecordings"], `${what}.blockedRecordings`).map((x, i) =>
      str(x, `${what}.blockedRecordings[${i}]`),
    ),
  };
}

/**
 * Turn the contents of a chosen file into a backup, or throw with a message
 * worth showing.
 *
 * A file from a *newer* schema version is refused rather than read on a
 * best-effort basis. Reading a shape from the future means guessing at what
 * changed, and guessing wrong writes plausible-looking damage into the record
 * that nothing downstream would flag.
 */
export function parseBackup(text: string): Backup {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail("That file is not valid JSON.");
  }

  const b = obj(raw, "The file");
  if (b["kind"] !== BACKUP_KIND) {
    fail("That does not look like a Flash Cards backup file.");
  }

  const version = num(b["schemaVersion"], "The file's schemaVersion");
  if (version > SCHEMA_VERSION) {
    fail(
      `That backup was written by a newer version of Flash Cards (format ${version}, this app reads ${SCHEMA_VERSION}). Update the app first.`,
    );
  }
  if (version < 1) fail("That backup's format version is not valid.");

  return {
    kind: BACKUP_KIND,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: num(b["exportedAt"], "The file's exportedAt"),
    profiles: arr(b["profiles"], "The file's profiles").map((r, i) =>
      parseRecord(r, `profiles[${i}]`),
    ),
    shared: parseShared(b["shared"] ?? { blockedRecordings: [] }, "The file's shared state"),
  };
}
