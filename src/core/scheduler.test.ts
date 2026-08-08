import { describe, expect, it } from "vitest";
import {
  BOX_INTERVAL_DAYS,
  FAST_TRACK_BOX,
  applyAttempt,
  boxCounts,
  dueItems,
  isDue,
  isRetired,
  lowBoxCount,
  newItem,
  nextDueAt,
  requeueMissed,
  timingMode,
} from "./scheduler.js";
import type { AttemptResult, Box, ItemState } from "./types.js";

const T0 = Date.parse("2026-09-01T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function attempt(over: Partial<AttemptResult> = {}): AttemptResult {
  return { correct: true, mode: "untimed", at: T0, elapsedMs: 3000, ...over };
}

function at(state: ItemState, box: Box, seen = 1): ItemState {
  return { ...state, box, timesSeen: seen };
}

describe("first-exposure fast-track", () => {
  it("sends a correct first answer straight to box 5", () => {
    const after = applyAttempt(newItem("cat", T0), attempt());
    expect(after.box).toBe(FAST_TRACK_BOX);
    expect(after.dueAt).toBe(T0 + 21 * DAY);
  });

  it("costs an already-known item exactly two questions before it retires", () => {
    let s = newItem("cat", T0);
    s = applyAttempt(s, attempt());
    s = applyAttempt(s, attempt({ at: T0 + 21 * DAY, mode: "timed" }));
    expect(isRetired(s)).toBe(true);
    expect(s.timesSeen).toBe(2);
  });

  it("does not apply to a miss — an unknown item starts the ladder at box 1", () => {
    const after = applyAttempt(newItem("cat", T0), attempt({ correct: false }));
    expect(after.box).toBe(1);
  });

  it("does not apply on the second exposure", () => {
    let s = newItem("cat", T0);
    s = applyAttempt(s, attempt({ correct: false }));
    s = applyAttempt(s, attempt({ at: T0 + 60_000 }));
    expect(s.box).toBe(2);
  });
});

describe("promotion and demotion", () => {
  it("moves up one box per correct review and stops at retirement", () => {
    let s = at(newItem("x", T0), 1);
    for (const expected of [2, 3, 4, 5, 6, 6]) {
      s = applyAttempt(s, attempt({ mode: timingMode(s.box) }));
      expect(s.box).toBe(expected);
    }
  });

  it("drops an untimed miss all the way to box 1", () => {
    const s = applyAttempt(at(newItem("x", T0), 5), attempt({ correct: false }));
    expect(s.box).toBe(1);
    expect(s.dueAt).toBe(T0);
  });

  it("leaves the box alone on a timed miss but still reschedules", () => {
    const s = applyAttempt(at(newItem("x", T0), 4), attempt({ correct: false, mode: "timed" }));
    expect(s.box).toBe(4);
    expect(s.dueAt).toBe(T0 + 7 * DAY);
    expect(s.timesSeen).toBe(2);
    expect(s.timesCorrect).toBe(0);
  });

  it("brings a retired item back if it is missed untimed", () => {
    const s = applyAttempt(at(newItem("x", T0), 6), attempt({ correct: false }));
    expect(s.box).toBe(1);
  });
});

describe("intervals and due dates", () => {
  it("matches the documented ladder", () => {
    expect(BOX_INTERVAL_DAYS).toEqual({ 1: 0, 2: 1, 3: 3, 4: 7, 5: 21, 6: null });
  });

  it("makes box 1 due immediately and box 6 never", () => {
    expect(nextDueAt(1, T0)).toBe(T0);
    expect(nextDueAt(6, T0)).toBeNull();
  });

  it("never treats a retired item as due", () => {
    expect(isDue({ ...newItem("x", T0), box: 6, dueAt: null }, T0 + 1000 * DAY)).toBe(false);
  });

  it("returns due items soonest first and skips the rest", () => {
    const states: ItemState[] = [
      { ...newItem("late", T0), dueAt: T0 + DAY },
      { ...newItem("second", T0), dueAt: T0 - DAY },
      { ...newItem("first", T0), dueAt: T0 - 2 * DAY },
      { ...newItem("gone", T0), box: 6, dueAt: null },
    ];
    expect(dueItems(states, T0).map((s) => s.itemId)).toEqual(["first", "second"]);
  });
});

describe("timing mode follows the box", () => {
  it("asks low boxes untimed and box 4+ against the clock", () => {
    expect([1, 2, 3].map((b) => timingMode(b as Box))).toEqual(["untimed", "untimed", "untimed"]);
    expect([4, 5].map((b) => timingMode(b as Box))).toEqual(["timed", "timed"]);
  });

  it("leaves retired items untimed", () => {
    expect(timingMode(6)).toBe("untimed");
  });
});

describe("session requeue", () => {
  it("puts a missed item back five items later", () => {
    const queue = ["a", "b", "c", "d", "e", "f", "g"];
    expect(requeueMissed(queue, "miss")).toEqual(["a", "b", "c", "d", "e", "miss", "f", "g"]);
  });

  it("appends when the session is nearly over", () => {
    expect(requeueMissed(["a", "b"], "miss")).toEqual(["a", "b", "miss"]);
    expect(requeueMissed([], "miss")).toEqual(["miss"]);
  });

  it("does not mutate the queue it was given", () => {
    const queue = ["a", "b"];
    requeueMissed(queue, "miss");
    expect(queue).toEqual(["a", "b"]);
  });
});

describe("counts for the governor and the readout", () => {
  const states: ItemState[] = [1, 1, 2, 3, 4, 6].map((b, i) => at(newItem(`i${i}`, T0), b as Box));

  it("counts only boxes 1 and 2 as unfinished business", () => {
    expect(lowBoxCount(states)).toBe(3);
  });

  it("counts every box for the readout, retirement included", () => {
    expect(boxCounts(states)).toEqual({ 1: 2, 2: 1, 3: 1, 4: 1, 5: 0, 6: 1 });
  });
});
