/**
 * Multiplication, as a subject the session engine can run.
 *
 * Everything specific to the game is here: which items exist, how a fact is
 * shown, and what counts as a right answer. The engine itself knows none of it.
 */

import {
  allFacts,
  bandForFact,
  multiplicationModel,
  parseFactId,
  present,
  product,
} from "../core/index.js";
import type { Fact, ProficiencyModel } from "../core/index.js";
import type { Deck } from "./session.js";

/**
 * The whole table, eligible from the first session. There is no ladder to climb
 * and no unlocking: 78 distinct facts is not enough material to ration, so the
 * volume governor in the engine is the only thing holding introductions back.
 */
export function multiplicationDeck(): Deck {
  const facts = allFacts();
  const bands = new Map(facts.map((f) => [f.id, bandForFact(f)]));
  return {
    itemIds: facts.map((f) => f.id),
    bandOf(itemId: string): string {
      const band = bands.get(itemId);
      if (band === undefined) throw new Error(`Not a multiplication fact: ${itemId}`);
      return band;
    },
  };
}

export function multiplicationProficiencyModel(): ProficiencyModel {
  return multiplicationModel();
}

/** `7 × 8`, in one order or the other. The scheduler never sees the difference. */
export function factPrompt(itemId: string, roll: number): string {
  const fact = parseFactId(itemId);
  const shown = present(fact, roll >= 0.5);
  return `${shown.left} × ${shown.right}`;
}

export function factOf(itemId: string): Fact {
  return parseFactId(itemId);
}

export function correctAnswer(itemId: string): number {
  return product(parseFactId(itemId));
}

/**
 * Whether what was typed is the right product.
 *
 * Strict about what it accepts: surrounding space is forgiven because a stray
 * space is a slip rather than a wrong answer, and everything else is not. "56 "
 * is right; "5 6", "fifty-six" and an empty box are all wrong, which is the
 * honest reading — an unanswered question is not a correct one.
 */
export function isCorrect(itemId: string, typed: string): boolean {
  const trimmed = typed.trim();
  if (!/^\d+$/.test(trimmed)) return false;
  return Number(trimmed) === correctAnswer(itemId);
}
