import { describe, expect, it } from "vitest";
import {
  FLUENT_BASE_MS,
  FLUENT_PER_EXTRA_DIGIT_MS,
  allFacts,
  bandForFact,
  factId,
  factsInTable,
  fluencyLimitMs,
  normaliseFact,
  parseFactId,
  present,
  product,
  tablesFor,
} from "./multiplication.js";
import { applyAttempt, newItem } from "./scheduler.js";

describe("normalisation", () => {
  it("makes a×b and b×a the same fact", () => {
    expect(normaliseFact(7, 8)).toEqual(normaliseFact(8, 7));
    expect(factId(3, 12)).toBe("3x12");
    expect(factId(12, 3)).toBe("3x12");
  });

  it("round-trips through its id", () => {
    for (const [x, y] of [[1, 1], [4, 9], [12, 5]] as const) {
      expect(parseFactId(factId(x, y))).toEqual(normaliseFact(x, y));
    }
  });

  it("rejects nonsense ids", () => {
    expect(() => parseFactId("7*8")).toThrow(/Not a fact id/);
  });

  it("keeps the product", () => {
    expect(product(normaliseFact(12, 7))).toBe(84);
  });
});

describe("the deck", () => {
  it("is 78 distinct facts for 1 through 12, not 144", () => {
    const facts = allFacts();
    expect(facts).toHaveLength(78);
    expect(new Set(facts.map((f) => f.id)).size).toBe(78);
  });

  it("covers every ordered pair exactly once after normalisation", () => {
    const ids = new Set(allFacts().map((f) => f.id));
    for (let a = 1; a <= 12; a += 1) {
      for (let b = 1; b <= 12; b += 1) {
        expect(ids.has(factId(a, b))).toBe(true);
      }
    }
  });

  it("scopes to a smaller table when asked", () => {
    expect(allFacts(1, 3).map((f) => f.id)).toEqual(["1x1", "1x2", "1x3", "2x2", "2x3", "3x3"]);
  });
});

describe("times tables for the chart", () => {
  it("counts a fact toward both its tables", () => {
    expect(tablesFor(normaliseFact(7, 8))).toEqual([7, 8]);
  });

  it("counts a square once", () => {
    expect(tablesFor(normaliseFact(6, 6))).toEqual([6]);
  });

  it("gives each table 12 facts including its square", () => {
    for (let t = 1; t <= 12; t += 1) {
      const facts = factsInTable(t);
      expect(facts).toHaveLength(12);
      expect(facts.some((f) => f.a === t && f.b === t)).toBe(true);
    }
  });

  it("credits a first exposure to the larger factor's table", () => {
    expect(bandForFact(normaliseFact(8, 7))).toBe("8");
    expect(bandForFact(normaliseFact(6, 6))).toBe("6");
  });
});

describe("presentation", () => {
  it("shows both orders without splitting the scheduling item", () => {
    const fact = normaliseFact(4, 9);
    expect(present(fact, false)).toEqual({ left: 4, right: 9 });
    expect(present(fact, true)).toEqual({ left: 9, right: 4 });

    // Both orders fold into one item's history.
    let state = newItem(fact.id, 0);
    state = applyAttempt(state, { correct: false, mode: "untimed", at: 0, elapsedMs: 900 });
    state = applyAttempt(state, { correct: true, mode: "untimed", at: 1000, elapsedMs: 800 });
    expect(state.itemId).toBe("4x9");
    expect(state.timesSeen).toBe(2);
  });
});

describe("the fluency limit", () => {
  it("allows more time for a longer product, and only for the product", () => {
    // 2×3 is one digit, 4×9 two, 12×12 three. The extra allowance is typing,
    // not thinking, so it is keyed on how much there is to type.
    expect(fluencyLimitMs(normaliseFact(2, 3))).toBe(FLUENT_BASE_MS);
    expect(fluencyLimitMs(normaliseFact(4, 9))).toBe(FLUENT_BASE_MS + FLUENT_PER_EXTRA_DIGIT_MS);
    expect(fluencyLimitMs(normaliseFact(12, 12))).toBe(
      FLUENT_BASE_MS + 2 * FLUENT_PER_EXTRA_DIGIT_MS,
    );
  });

  it("does not depend on which way round the fact is shown", () => {
    expect(fluencyLimitMs(normaliseFact(7, 8))).toBe(fluencyLimitMs(normaliseFact(8, 7)));
  });

  it("stays inside a few seconds across the whole table", () => {
    // A sanity bound, not a finding: if a limit ever lands somewhere a child
    // could count up to, the constants have drifted.
    for (const fact of allFacts()) {
      expect(fluencyLimitMs(fact)).toBeGreaterThanOrEqual(2000);
      expect(fluencyLimitMs(fact)).toBeLessThanOrEqual(4500);
    }
  });
});
