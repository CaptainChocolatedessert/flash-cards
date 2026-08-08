/**
 * Shared domain types for the headless core.
 *
 * Nothing here knows about the DOM, storage, or either game's content. The core
 * is a set of pure functions over these values; see DESIGN.md, "Build order" step 1.
 */

/**
 * Leitner box. 6 is retirement: the item stops being scheduled, though it is
 * still counted in the progress readout.
 */
export type Box = 1 | 2 | 3 | 4 | 5 | 6;

/**
 * Whether a question was asked against the clock. The mode follows the box
 * (see `timingMode`), and it changes what a wrong answer means: a timed miss
 * never demotes, because time pressure produces errors on known items.
 */
export type TimingMode = "untimed" | "timed";

/** One answered question. */
export interface AttemptResult {
  readonly correct: boolean;
  readonly mode: TimingMode;
  /** Epoch ms when the answer was submitted. */
  readonly at: number;
  /** Wall time from question shown to answer submitted. Reported, never scheduled on. */
  readonly elapsedMs: number;
}

/**
 * Scheduling state for a single item — a word, or a normalised multiplication
 * fact. Created when the item is first introduced, not when it is first answered,
 * so `timesSeen === 0` is exactly "has never been asked" and is what the
 * first-exposure fast-track keys on.
 */
export interface ItemState {
  readonly itemId: string;
  readonly box: Box;
  /** Epoch ms at which the item becomes eligible again. Null once retired. */
  readonly dueAt: number | null;
  readonly timesSeen: number;
  readonly timesCorrect: number;
  readonly lastResult: AttemptResult | null;
}

/**
 * A band is the unit the proficiency chart has one bar for: a school grade for
 * spelling, a times table for multiplication. Kept as a string so the state
 * serialises straight to JSON.
 */
export type BandId = string;
