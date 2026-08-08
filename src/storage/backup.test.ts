import { describe, expect, it } from "vitest";
import { BackupError, backupFilename, parseBackup, serialiseBackup } from "./backup.js";
import { newSharedState } from "./store.js";
import { populatedRecord, T0 } from "./fixtures.js";
import type { Backup } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

function sampleBackup(): Backup {
  return {
    kind: "flash-cards-progress",
    schemaVersion: SCHEMA_VERSION,
    exportedAt: T0,
    profiles: [populatedRecord("Sam"), populatedRecord("Alex", T0 + 1)],
    shared: { ...newSharedState(), blockedRecordings: ["commons:bad.ogg"] },
  };
}

/** Round-trip through text and hand back the parsed object, with a field surgically damaged. */
function parseWith(mutate: (raw: Record<string, unknown>) => void): () => Backup {
  const raw = JSON.parse(serialiseBackup(sampleBackup())) as Record<string, unknown>;
  mutate(raw);
  return () => parseBackup(JSON.stringify(raw));
}

describe("round trip", () => {
  it("survives text unchanged", () => {
    const backup = sampleBackup();
    expect(parseBackup(serialiseBackup(backup))).toEqual(backup);
  });

  it("keeps keystroke timelines intact", () => {
    const parsed = parseBackup(serialiseBackup(sampleBackup()));
    expect(parsed.profiles[0]?.subjects.spelling.attempts[0]?.keystrokes).toEqual([
      { t: 120, key: "n" },
      { t: 260, key: "e" },
      { t: 390, key: "c" },
      { t: 1980, key: "c" },
      { t: 2110, key: "e" },
    ]);
  });
});

describe("rejecting bad files", () => {
  it("refuses text that is not JSON", () => {
    expect(() => parseBackup("not a file")).toThrow(BackupError);
  });

  it("refuses a JSON file that is not a backup", () => {
    expect(() => parseBackup('{"hello":"world"}')).toThrow(/not look like a Flash Cards backup/);
  });

  it("refuses a backup from a newer format, rather than guessing", () => {
    expect(parseWith((raw) => (raw["schemaVersion"] = SCHEMA_VERSION + 1))).toThrow(
      /newer version of Flash Cards/,
    );
  });

  it("accepts an older format version", () => {
    // Nothing to migrate yet — this only asserts that older is not treated the
    // same way as newer, so the first real migration has somewhere to hook in.
    const backup = sampleBackup();
    const raw = JSON.parse(serialiseBackup(backup)) as Record<string, unknown>;
    raw["schemaVersion"] = 1;
    expect(parseBackup(JSON.stringify(raw)).schemaVersion).toBe(SCHEMA_VERSION);
  });
});

describe("rejecting damaged numbers", () => {
  // The failure worth catching: a file that is *nearly* right, where one number
  // has gone missing and would land in the estimator and turn every prediction
  // into NaN with no error raised anywhere.

  it("refuses a null ability", () => {
    expect(
      parseWith((raw) => {
        const profiles = raw["profiles"] as Record<string, any>[];
        profiles[0]!["subjects"]["spelling"]["proficiency"]["ability"] = null;
      }),
    ).toThrow(/ability is not a finite number/);
  });

  it("refuses an ability that arrived as text", () => {
    expect(
      parseWith((raw) => {
        const profiles = raw["profiles"] as Record<string, any>[];
        profiles[0]!["subjects"]["spelling"]["proficiency"]["ability"] = "0.4";
      }),
    ).toThrow(/ability is not a finite number/);
  });

  it("refuses a band residual that is not a number", () => {
    expect(
      parseWith((raw) => {
        const profiles = raw["profiles"] as Record<string, any>[];
        profiles[0]!["subjects"]["spelling"]["proficiency"]["bands"]["6"]["residual"] = "x";
      }),
    ).toThrow(/bands\.6\.residual/);
  });

  it("refuses a box outside 1-6", () => {
    expect(
      parseWith((raw) => {
        const profiles = raw["profiles"] as Record<string, any>[];
        profiles[0]!["subjects"]["spelling"]["items"]["rhythm"]["box"] = 9;
      }),
    ).toThrow(/box is not a box number/);
  });

  it("refuses a difficulty setting off the scale", () => {
    expect(
      parseWith((raw) => {
        const profiles = raw["profiles"] as Record<string, any>[];
        profiles[0]!["subjects"]["spelling"]["difficulty"] = 7;
      }),
    ).toThrow(/difficulty is outside/);
  });

  it("refuses a missing subject", () => {
    expect(
      parseWith((raw) => {
        const profiles = raw["profiles"] as Record<string, any>[];
        delete profiles[0]!["subjects"]["multiplication"];
      }),
    ).toThrow(/subjects\.multiplication/);
  });

  it("names the profile that is at fault", () => {
    expect(
      parseWith((raw) => {
        const profiles = raw["profiles"] as Record<string, any>[];
        profiles[1]!["profile"]["createdAt"] = null;
      }),
    ).toThrow(/profiles\[1\]\.profile\.createdAt/);
  });
});

describe("filenames", () => {
  it("sorts chronologically in a downloads folder", () => {
    expect(backupFilename(Date.parse("2026-08-08T09:00:00"))).toBe(
      "flash-cards-progress-2026-08-08.json",
    );
  });
});
