import { describe, expect, it } from "vitest";
import {
  appendAttempt,
  appendSession,
  markPlayed,
  mergeShared,
  newRecord,
  newSharedState,
  pickNewer,
  renameProfile,
  withSubject,
} from "./store.js";
import type { RecordedAttempt, SessionSummary } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

const T0 = Date.parse("2026-09-01T12:00:00Z");

function attemptAt(at: number): RecordedAttempt {
  return {
    itemId: `w${at}`,
    band: "5",
    firstExposure: true,
    correct: true,
    mode: "untimed",
    at,
    elapsedMs: 1000,
    answer: "cat",
    keystrokes: [{ t: 100, key: "c" }],
  };
}

function sessionAt(startedAt: number): SessionSummary {
  return {
    startedAt,
    endedAt: startedAt + 60_000,
    asked: 10,
    correct: 8,
    introduced: 2,
    correctChars: 60,
    typingMs: 45_000,
  };
}

describe("newRecord", () => {
  it("starts both subjects empty, with a fresh proficiency state", () => {
    const record = newRecord("Sam", T0);
    expect(record.schemaVersion).toBe(SCHEMA_VERSION);
    expect(record.profile.name).toBe("Sam");
    expect(record.profile.lastPlayedAt).toBeNull();
    for (const subject of [record.subjects.spelling, record.subjects.multiplication]) {
      expect(subject.proficiency.observations).toBe(0);
      expect(subject.difficulty).toBe(0);
      expect(Object.keys(subject.items)).toHaveLength(0);
      expect(subject.attempts).toHaveLength(0);
    }
  });

  it("gives every profile a distinct id", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newRecord("Sam", T0).profile.id));
    expect(ids.size).toBe(50);
  });
});

describe("record updates", () => {
  it("replaces one subject without touching the other", () => {
    const record = newRecord("Sam", T0);
    const changed = withSubject(record, "spelling", {
      ...record.subjects.spelling,
      difficulty: 2,
    });
    expect(changed.subjects.spelling.difficulty).toBe(2);
    expect(changed.subjects.multiplication.difficulty).toBe(0);
  });

  it("keeps a rename from disturbing history", () => {
    const record = markPlayed(newRecord("Sam", T0), T0 + 5000);
    const renamed = renameProfile(record, "Samantha");
    expect(renamed.profile.name).toBe("Samantha");
    expect(renamed.profile.id).toBe(record.profile.id);
    expect(renamed.profile.lastPlayedAt).toBe(T0 + 5000);
  });
});

describe("the rolling attempt window", () => {
  it("keeps the most recent attempts and drops the oldest", () => {
    let progress = newRecord("Sam", T0).subjects.spelling;
    for (let i = 0; i < 12; i += 1) {
      progress = appendAttempt(progress, attemptAt(T0 + i), 5);
    }
    expect(progress.attempts).toHaveLength(5);
    expect(progress.attempts.map((a) => a.at)).toEqual([T0 + 7, T0 + 8, T0 + 9, T0 + 10, T0 + 11]);
  });

  it("does not trim below the window", () => {
    let progress = newRecord("Sam", T0).subjects.spelling;
    progress = appendAttempt(progress, attemptAt(T0), 5);
    expect(progress.attempts).toHaveLength(1);
  });

  it("trims session summaries on their own, larger, cap", () => {
    let progress = newRecord("Sam", T0).subjects.spelling;
    for (let i = 0; i < 6; i += 1) progress = appendSession(progress, sessionAt(T0 + i), 3);
    expect(progress.sessions.map((s) => s.startedAt)).toEqual([T0 + 3, T0 + 4, T0 + 5]);
  });

  it("keeps session summaries when attempts are trimmed away", () => {
    let progress = appendSession(newRecord("Sam", T0).subjects.spelling, sessionAt(T0), 10);
    for (let i = 0; i < 20; i += 1) progress = appendAttempt(progress, attemptAt(T0 + i), 3);
    expect(progress.attempts).toHaveLength(3);
    expect(progress.sessions).toHaveLength(1);
  });
});

describe("merging", () => {
  it("keeps whichever record was written last", () => {
    const a = newRecord("Sam", T0);
    const b = { ...a, profile: { ...a.profile, name: "Sam 2", updatedAt: T0 + 1000 } };
    expect(pickNewer(a, b).profile.name).toBe("Sam 2");
    expect(pickNewer(b, a).profile.name).toBe("Sam 2");
  });

  it("unions blocked recordings rather than picking a side", () => {
    const merged = mergeShared(
      { ...newSharedState(), blockedRecordings: ["b", "a"] },
      { ...newSharedState(), blockedRecordings: ["c", "a"] },
    );
    expect(merged.blockedRecordings).toEqual(["a", "b", "c"]);
  });
});
