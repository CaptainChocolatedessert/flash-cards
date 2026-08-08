/**
 * Test fixtures. Imported only by the tests beside it, so it never reaches the
 * bundle.
 *
 * The point of building a *fully populated* record here rather than an empty one
 * is that the round-trip and validation tests are only worth anything if every
 * field is exercised. An empty record round-trips through almost any bug.
 */

import { applyAttempt, newItem, recordFirstExposure, spellingModel } from "../core/index.js";
import { appendAttempt, appendSession, newRecord, withSubject } from "./store.js";
import type { ProgressRecord, RecordedAttempt, SessionSummary } from "./types.js";

export const T0 = Date.parse("2026-09-01T12:00:00Z");

export function sampleAttempt(overrides: Partial<RecordedAttempt> = {}): RecordedAttempt {
  return {
    itemId: "necessary",
    band: "6",
    firstExposure: true,
    correct: false,
    mode: "untimed",
    at: T0,
    elapsedMs: 8400,
    answer: "neccessary",
    keystrokes: [
      { t: 120, key: "n" },
      { t: 260, key: "e" },
      { t: 390, key: "c" },
      { t: 1980, key: "c" },
      { t: 2110, key: "e" },
    ],
    ...overrides,
  };
}

export function sampleSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    startedAt: T0,
    endedAt: T0 + 8 * 60_000,
    asked: 24,
    correct: 19,
    introduced: 6,
    correctChars: 148,
    typingMs: 6 * 60_000,
    ...overrides,
  };
}

/** A record with both subjects carrying real state: items in several boxes, attempts, sessions, a moved ability. */
export function populatedRecord(name = "Sam", now = T0): ProgressRecord {
  let record = newRecord(name, now);
  const model = spellingModel();

  let spelling = record.subjects.spelling;
  spelling = {
    ...spelling,
    difficulty: -1,
    proficiency: recordFirstExposure(
      recordFirstExposure(spelling.proficiency, model, "6", false),
      model,
      "4",
      true,
    ),
    items: {
      necessary: applyAttempt(newItem("necessary", now), {
        correct: false,
        mode: "untimed",
        at: now,
        elapsedMs: 8400,
      }),
      rhythm: applyAttempt(newItem("rhythm", now), {
        correct: true,
        mode: "untimed",
        at: now,
        elapsedMs: 3100,
      }),
    },
  };
  spelling = appendAttempt(spelling, sampleAttempt());
  spelling = appendAttempt(
    spelling,
    sampleAttempt({ itemId: "rhythm", band: "4", correct: true, answer: "rhythm", at: T0 + 9000 }),
  );
  spelling = appendSession(spelling, sampleSession());
  record = withSubject(record, "spelling", spelling);

  let multiplication = record.subjects.multiplication;
  multiplication = {
    ...multiplication,
    difficulty: 2,
    items: {
      "7x8": applyAttempt(newItem("7x8", now), {
        correct: true,
        mode: "timed",
        at: now,
        elapsedMs: 1400,
      }),
    },
  };
  multiplication = appendAttempt(
    multiplication,
    sampleAttempt({
      itemId: "7x8",
      band: "8",
      correct: true,
      mode: "timed",
      answer: "56",
      keystrokes: [
        { t: 700, key: "5" },
        { t: 820, key: "6" },
      ],
    }),
  );
  multiplication = appendSession(
    multiplication,
    sampleSession({ correctChars: 0, typingMs: 0, introduced: 12 }),
  );
  record = withSubject(record, "multiplication", multiplication);

  return record;
}
