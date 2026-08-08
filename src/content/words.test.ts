import { describe, expect, it } from "vitest";
import { mulberry32, newProficiency, predict } from "../core/index.js";
import { advance, endSession, startSession, submit } from "../game/index.js";
import { newRecord } from "../storage/index.js";
import {
  KINDERGARTEN_BAND,
  MAX_GRADE,
  bandLabel,
  spellingDeck,
  spellingProficiencyModel,
  spellingWords,
  wordsInSet,
  wordsNeedingContext,
} from "./words.js";

describe("the word list", () => {
  it("has words", () => {
    expect(spellingWords().length).toBeGreaterThan(1000);
  });

  it("contains each word exactly once", () => {
    const words = spellingWords().map((w) => w.word);
    expect(new Set(words).size).toBe(words.length);
  });

  it("resolves a word in two grades to the higher one", () => {
    // "their" is a grade-2 reading sight word and a grade-4 spelling problem;
    // "contradict" appears at both grade 6 and grade 8.
    const byWord = new Map(spellingWords().map((w) => [w.word, w]));
    expect(byWord.get("their")?.band).toBe("4");
    expect(byWord.get("contradict")?.band).toBe("8");
    expect(byWord.get("children")?.band).toBe("4");
  });

  it("keeps set membership from every place a word appeared", () => {
    const their = spellingWords().find((w) => w.word === "their");
    expect(their?.sets).toContain("Homophones");
    expect(their?.sets).toContain("Dolch Second Grade");
  });

  it("stores words lowercase, so a missing capital is not marked wrong", () => {
    for (const w of spellingWords()) expect(w.word).toBe(w.word.toLowerCase());
    expect(spellingWords().some((w) => w.word === "christmas")).toBe(true);
  });

  it("puts kindergarten in band 0 and labels it K", () => {
    expect(spellingWords().some((w) => w.band === KINDERGARTEN_BAND)).toBe(true);
    expect(bandLabel(KINDERGARTEN_BAND)).toBe("K");
    expect(bandLabel("6")).toBe("Grade 6");
  });

  it("covers kindergarten through grade 8 and no further, for now", () => {
    const bands = [...new Set(spellingWords().map((w) => w.band))].sort(
      (a, b) => Number(a) - Number(b),
    );
    expect(bands).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8"]);
  });

  it("has most of its words where the children actually are", () => {
    // Grades 4-8 are the range that matters for a 6th and 8th grader; the K-3
    // Dolch words will fast-track out in a session or two.
    const upper = spellingWords().filter((w) => Number(w.band) >= 4).length;
    expect(upper).toBeGreaterThan(700);
  });
});

describe("the deck", () => {
  it("offers every word and knows each one's band", () => {
    const deck = spellingDeck();
    const words = spellingWords();
    expect(deck.itemIds).toHaveLength(words.length);
    for (const w of words.slice(0, 50)) expect(deck.bandOf(w.word)).toBe(w.band);
  });

  it("refuses an item it does not have, rather than guessing a band", () => {
    expect(() => spellingDeck().bandOf("nonesuchword")).toThrow(/Not a spelling word/);
  });

  it("only offers items the proficiency model has bands for", () => {
    const model = spellingProficiencyModel();
    const known = new Set(model.bands);
    for (const w of spellingWords()) expect(known.has(w.band)).toBe(true);
  });

  it("keeps empty upper bands, so the chart does not change shape when the list grows", () => {
    const model = spellingProficiencyModel();
    expect(model.bands).toContain(String(MAX_GRADE));
    // An empty band still predicts, it simply has nothing to introduce from.
    expect(predict(newProficiency(), model, String(MAX_GRADE))).toBeGreaterThan(0);
  });
});

describe("running a session on it", () => {
  /**
   * The point of the import: the same engine that runs multiplication runs
   * spelling, with nothing changed but the deck.
   */
  it("plays through as a child who spells the easy grades and misses the hard ones", () => {
    const cfg = {
      deck: spellingDeck(),
      model: spellingProficiencyModel(),
      rng: mulberry32(5),
    };
    const T0 = Date.parse("2026-09-01T12:00:00Z");
    let session = advance(startSession(newRecord("Sam", T0).subjects.spelling, T0), cfg, T0);

    let asked = 0;
    while (session.current !== null && asked < 150) {
      const band = Number(session.current.band);
      const correct = band <= 4;
      session = submit(
        session,
        cfg,
        { correct, answer: "x", elapsedMs: 3000, keystrokes: [] },
        T0 + asked * 1000,
      );
      session = advance(session, cfg, T0 + asked * 1000);
      asked += 1;
    }

    expect(asked).toBeGreaterThan(20);
    const outcome = endSession(session, T0 + 600_000);

    // Every word the child met is a real word from the deck.
    const deckWords = new Set(spellingDeck().itemIds);
    for (const itemId of Object.keys(outcome.progress.items)) {
      expect(deckWords.has(itemId)).toBe(true);
    }
    // What is stuck in the low boxes should be the harder grades.
    const stuck = Object.values(outcome.progress.items).filter((s) => s.box <= 2);
    expect(stuck.length).toBeGreaterThan(0);
    for (const s of stuck) expect(Number(spellingDeck().bandOf(s.itemId))).toBeGreaterThan(4);
  });
});

describe("sets", () => {
  it("exposes the homophones", () => {
    const homophones = wordsInSet("Homophones").map((w) => w.word);
    for (const w of ["their", "there", "they're", "to", "too", "two"]) {
      expect(homophones).toContain(w);
    }
  });

  it("gathers everything a spoken prompt cannot distinguish, across both sets", () => {
    // The pairs are split between two sets at different grades: their/there is
    // "Homophones" at grade 4, principal/principle is "Commonly confused" at 7.
    // Both are the same problem, so the cloze feature needs the union.
    const needsContext = wordsNeedingContext().map((w) => w.word);
    for (const w of ["their", "there", "principal", "principle", "stationary", "stationery"]) {
      expect(needsContext).toContain(w);
    }
    expect(needsContext.length).toBeGreaterThan(80);
  });

  it("does not flag ordinary words as needing context", () => {
    const needsContext = new Set(wordsNeedingContext().map((w) => w.word));
    expect(needsContext.has("accommodate")).toBe(false);
    expect(needsContext.has("photosynthesis")).toBe(false);
  });
});
