/**
 * Which new items enter the queue, and how many. See DESIGN.md,
 * "Choosing where new words come from" and "How many new words".
 *
 * The two questions are kept apart on purpose. The weighting below decides
 * *where* new items come from; the governor decides *how many*. Letting one
 * answer both is how a run of misses at the frontier compounds — misses put
 * items in box 1, and a system that keeps introducing regardless buries them.
 */

import type { ProficiencyModel, ProficiencyState } from "./proficiency.js";
import { predict } from "./proficiency.js";
import type { Rng } from "./rng.js";
import type { BandId } from "./types.js";

/**
 * Where the introduction zone is centred, as predicted probability of success.
 *
 * Not 50%, and not 90%. Two pressures pull against each other: learning value
 * peaks *low*, because an item answered correctly on first exposure is
 * fast-tracked out and teaches nothing, so only misses actually enter the
 * Leitner cycle — while morale peaks *high*, because a stream of failures is how
 * a kid stops playing. 70% is the compromise: most of a session feels like
 * competence, and roughly one introduction in three is something they needed.
 *
 * A starting guess, explicitly. Open question 6.
 */
export const DEFAULT_TARGET_SUCCESS = 0.7;

/**
 * How wide the zone is, in probability. Bands further than this from the target
 * fall away fast.
 *
 * Narrower than it first looks it should be, because the logistic is flat near
 * the ends: with a wider bump, three bands the child has effectively mastered
 * all cluster up at 85-90% predicted success and collectively take a fifth of
 * the introductions. A small tail into easy bands is still wanted and still
 * happens — the fast-track makes a wasted probe cost one question — but it
 * should be a tail, not a quarter of the session.
 */
export const TARGET_WIDTH = 0.12;

/** Items in boxes 1-2 above which nothing new is introduced. Unfinished business first. */
export const LOW_BOX_CEILING = 15;

/**
 * The kid's harder/easier control, as the only thing it touches: the target
 * success rate. Index 0 is easiest.
 *
 * Never show the number. The direction is inverted — a *lower* success target
 * means *harder* items — and that is a guaranteed source of confusion. Label it
 * "harder" and "easier".
 */
export const DIFFICULTY_TARGETS: readonly number[] = [0.85, 0.78, 0.7, 0.62, 0.55];

/** -2 is easiest, 0 is default, +2 is hardest. */
export type DifficultySetting = -2 | -1 | 0 | 1 | 2;

export function targetSuccess(setting: DifficultySetting): number {
  return DIFFICULTY_TARGETS[setting + 2] ?? DEFAULT_TARGET_SUCCESS;
}

export interface BandWeight {
  readonly band: BandId;
  /** Normalised across all bands, so the set sums to 1 (or is all-zero if nothing is available). */
  readonly weight: number;
  /** What the estimator thinks an unseen item here would do. */
  readonly p: number;
  /** How many unseen items this band still has to offer. */
  readonly available: number;
}

/**
 * How much value a new item from each band would have: a bump peaked at the
 * target success rate, near zero where the child is already proficient (nothing
 * left to teach) and near zero where they are out of their depth (nothing but
 * frustration).
 *
 * `available` is the count of items in that band the child has never seen. A
 * band with none gets weight zero regardless of how well it scores.
 */
export function bandWeights(
  state: ProficiencyState,
  model: ProficiencyModel,
  available: Readonly<Record<BandId, number>>,
  target: number = DEFAULT_TARGET_SUCCESS,
  width: number = TARGET_WIDTH,
): BandWeight[] {
  const raw = model.bands.map((band) => {
    const p = predict(state, model, band);
    const count = available[band] ?? 0;
    const z = (p - target) / width;
    const weight = count > 0 ? Math.exp(-0.5 * z * z) : 0;
    return { band, weight, p, available: count };
  });

  const total = raw.reduce((sum, w) => sum + w.weight, 0);
  if (total === 0) return raw;
  return raw.map((w) => ({ ...w, weight: w.weight / total }));
}

/** Draw one band from the weighting. Null when nothing is available anywhere. */
export function chooseBand(weights: readonly BandWeight[], rng: Rng): BandId | null {
  const total = weights.reduce((sum, w) => sum + w.weight, 0);
  if (total <= 0) return null;
  let roll = rng() * total;
  for (const w of weights) {
    roll -= w.weight;
    if (roll <= 0) return w.band;
  }
  return weights[weights.length - 1]?.band ?? null;
}

/**
 * The bands new items are actually coming from, for the chart to highlight.
 * Showing this next to the bars is what makes the harder/easier control legible:
 * move it, and watch the marked zone shift.
 */
export function activeBands(weights: readonly BandWeight[], threshold = 0.25): BandId[] {
  const peak = weights.reduce((max, w) => Math.max(max, w.weight), 0);
  if (peak <= 0) return [];
  return weights.filter((w) => w.weight >= threshold * peak).map((w) => w.band);
}

/**
 * The volume governor: how many new items may be introduced right now, given
 * how many are already churning in boxes 1-2. A kid with thirty words in the low
 * boxes does not need more; they need to finish those.
 */
export function introductionSlots(lowBoxCount: number, ceiling: number = LOW_BOX_CEILING): number {
  return Math.max(0, ceiling - lowBoxCount);
}
