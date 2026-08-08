/**
 * The spelling word list, turned into something the session engine can run.
 *
 * `word-lists.json` is kept **verbatim** as it arrived, and every change to it
 * happens here in code with tests beside it. That is deliberate: the audit of
 * this list (DESIGN.md, "Spelling word lists") could not establish where its
 * grade-4-8 words came from, so the one thing worth guaranteeing is that the
 * input stays auditable and the transformation stays inspectable. Editing the
 * JSON by hand would destroy both.
 *
 * The list is bundled rather than fetched. At ~18KB that is simpler than a
 * network path that has to work offline, and it means there is no loading state
 * to design around. Audio is the thing that must never be bundled; a word list
 * is not.
 */

import { spellingModel } from "../core/index.js";
import type { BandId, ProficiencyModel } from "../core/index.js";
import type { Deck } from "../game/index.js";
import raw from "./word-lists.json";

/**
 * Kindergarten is band "0".
 *
 * Bands stay numeric so the estimator's difficulty formula and the chart's
 * ordering both keep working unchanged — `spellingModel` already takes a
 * starting grade, so this needs no special case in the core. Rendering "0" as
 * "K" is the display layer's job, and belongs there rather than here.
 */
export const KINDERGARTEN_BAND: BandId = "0";

export const MIN_GRADE = 0;

/**
 * The chart runs to grade 12 even though the list stops at 8.
 *
 * Bands with no unseen words left get zero introduction weight automatically, so
 * the empty upper bands cost nothing — and leaving them in place means the chart
 * does not silently change shape when the corpus is extended upward, which is
 * open question 11 and the first thing that will be wanted.
 */
export const MAX_GRADE = 12;

/** A word, the band it counts toward, and the sets it came from. */
export interface SpellingWord {
  readonly word: string;
  readonly band: BandId;
  /**
   * Set names, e.g. "Homophones". Carried because the homophone and
   * commonly-confused sets are exactly the words that cannot be disambiguated by
   * audio alone, and so are what the cloze-sentence feature needs.
   */
  readonly sets: readonly string[];
}

interface RawSet {
  readonly name: string;
  readonly words: readonly string[];
}

interface RawGrade {
  readonly grade: string;
  readonly sets: readonly RawSet[];
}

function bandFor(grade: string): BandId {
  return grade.toUpperCase() === "K" ? KINDERGARTEN_BAND : grade;
}

/**
 * Words are matched case-insensitively, so they are stored lowercase — except
 * that this also collapses proper nouns like "Christmas". That is the right
 * trade for a spelling game aimed at children: marking a word wrong for a
 * missing capital would teach nothing about spelling.
 */
function normalise(word: string): string {
  return word.trim().toLowerCase();
}

/**
 * Build the word list, resolving words that appear in more than one grade.
 *
 * **The higher grade wins.** 32 words appear twice in the source, and a word in
 * two bands has no valid reading: the scheduler keys an item by its word, and
 * the estimator takes exactly one band per first exposure. Taking the later
 * placement is not arbitrary — it is there because someone judged the word hard
 * enough to warrant it, and that judgement is spelling-specific. `their` is a
 * grade-2 *reading* sight word and a grade-4 *spelling* problem; `children`,
 * `feet`, `men` and `sheep` are all easy to read and hard to spell. Taking the
 * lower placement would systematically mark the tricky ones easy.
 *
 * Set membership is unioned across every appearance, since that is metadata
 * rather than a competing claim.
 */
function build(): SpellingWord[] {
  const byWord = new Map<string, { band: BandId; sets: Set<string> }>();

  for (const grade of raw.grades as readonly RawGrade[]) {
    const band = bandFor(grade.grade);
    for (const set of grade.sets) {
      for (const rawWord of set.words) {
        const word = normalise(rawWord);
        if (word === "") continue;
        const existing = byWord.get(word);
        if (existing === undefined) {
          byWord.set(word, { band, sets: new Set([set.name]) });
          continue;
        }
        existing.sets.add(set.name);
        if (Number(band) > Number(existing.band)) existing.band = band;
      }
    }
  }

  return [...byWord]
    .map(([word, { band, sets }]) => ({ word, band, sets: [...sets].sort() }))
    .sort((a, b) => Number(a.band) - Number(b.band) || a.word.localeCompare(b.word));
}

let cached: SpellingWord[] | null = null;

/** Every word, deduplicated, in band then alphabetical order. */
export function spellingWords(): readonly SpellingWord[] {
  cached ??= build();
  return cached;
}

/** Words belonging to a named set. */
export function wordsInSet(name: string): SpellingWord[] {
  return spellingWords().filter((w) => w.sets.includes(name));
}

/**
 * The sets whose words a spoken prompt cannot distinguish.
 *
 * Two of them, not one: `their`/`there` sit in "Homophones" at grade 4, while
 * `principal`/`principle` and `stationary`/`stationery` sit in "Commonly
 * confused" at grade 7. Both are the same problem — saying the word aloud does
 * not say which word it is.
 */
const CONTEXT_REQUIRED_SETS: readonly string[] = ["Homophones", "Commonly confused"];

/**
 * Words that cannot be asked by audio alone and need a sentence with the word
 * blanked out. See DESIGN.md, "Cloze sentences — the homophone answer": this is
 * the set that makes the feature necessary, and the one a hand-written fallback
 * would have to cover if a sentence corpus proves unworkable.
 */
export function wordsNeedingContext(): SpellingWord[] {
  return spellingWords().filter((w) => w.sets.some((s) => CONTEXT_REQUIRED_SETS.includes(s)));
}

export function spellingDeck(): Deck {
  const words = spellingWords();
  const bands = new Map(words.map((w) => [w.word, w.band]));
  return {
    itemIds: words.map((w) => w.word),
    bandOf(itemId: string): BandId {
      const band = bands.get(itemId);
      if (band === undefined) throw new Error(`Not a spelling word: ${itemId}`);
      return band;
    },
  };
}

export function spellingProficiencyModel(): ProficiencyModel {
  return spellingModel(MIN_GRADE, MAX_GRADE);
}

/** How a band is labelled on screen. Grade 0 is kindergarten. */
export function bandLabel(band: BandId): string {
  return band === KINDERGARTEN_BAND ? "K" : `Grade ${band}`;
}
