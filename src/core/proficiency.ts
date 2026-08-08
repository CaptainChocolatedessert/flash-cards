/**
 * The proficiency profile. See DESIGN.md, "Progression — a proficiency profile,
 * not a ladder".
 *
 * The quantity being estimated is: *the probability this child would correctly
 * answer an item they have never seen before, in each band.* That is what the
 * chart shows and what the introduction weighting reads, with no translation
 * layer between the two.
 *
 * The form is online Rasch, Elo-shaped: one latent ability per child, one
 * difficulty per band, predicted success is the logistic of the difference, and
 * every first-exposure answer nudges the ability by how surprising it was. That
 * buys three things twelve independent counters would not: every answer informs
 * every band, the profile is monotone by construction, and there is one number
 * to store rather than a history to replay.
 *
 * Fed by first-exposure results only. Once an item is in the box system, getting
 * it right says something about that item's rehearsal state, not about ability
 * on unseen items — feeding reviews in would drift every band toward 100% as
 * items got learned, and the chart would report practice history while looking
 * entirely plausible. Open question 9 may revise this; the raw attempt history is
 * kept so the estimator can be re-derived if it does.
 */

import type { BandId } from "./types.js";

// ---------------------------------------------------------------------------
// Tuning constants. All of these are knobs, not findings.
// ---------------------------------------------------------------------------

/** Ability step size for a child with no history. Large, so the first session lands somewhere sane. */
const STEP_START = 0.6;

/**
 * The floor the step size decays to, and never below.
 *
 * Load-bearing. A conventional estimator of a *fixed* quantity shrinks its
 * update toward zero as data accumulates. Ability is not fixed — it rises as the
 * child learns — so an unfloored estimator would lock onto a stale value and the
 * chart would go flat while the kid kept improving.
 *
 * The floor is what a moving target costs. A filter that never stops moving
 * never stops wobbling either: its resting spread is sqrt(step / 2I) logits, so
 * 0.05 buys a chart that jitters by about 0.35 logits — a few points of
 * probability — while still crossing two logits of genuine improvement in a few
 * hundred first exposures. Raising it makes the chart visibly noisy between
 * sessions; lowering it makes a child's real progress take a term to show up.
 */
const STEP_FLOOR = 0.05;

/** Observations over which the step decays from START toward FLOOR. */
const STEP_HALFLIFE = 40;

/** Step size for a band's own residual. Modest relative to the ability step. */
const RESIDUAL_STEP = 0.3;

/** Pull of the residual back toward zero each update — the prior that says bands are on the pooled curve. */
const RESIDUAL_DECAY = 0.01;

/** Prior spread of band residuals, in logits. */
const RESIDUAL_PRIOR_SD = 0.5;

/** Samples at which a band's residual is trusted halfway. Below this it stays near-pinned at zero. */
const RESIDUAL_PSEUDO_SAMPLES = 8;

/** Hard bound on a residual, so one bad run cannot pull a band off the chart. */
const RESIDUAL_LIMIT = 2;

/** Prior spread of ability before any answers, in logits. */
const ABILITY_PRIOR_SD = 1.5;

/**
 * Fisher information carried by one answer near the operating point, p(1-p) at
 * roughly 70% success. Used only to turn a step size into a spread.
 */
const TYPICAL_INFORMATION = 0.2;

/** Half-width of the reported interval, in standard deviations (~95%). */
const INTERVAL_Z = 1.96;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** How far a band sits off the pooled curve for this child, and how much evidence there is for that. */
export interface BandResidual {
  /** Logits of extra ability in this band. Positive means better than the pooled curve predicts. */
  readonly residual: number;
  readonly samples: number;
}

/** Everything stored per child per subject. Serialises to JSON as-is. */
export interface ProficiencyState {
  /** Latent ability, in logits. */
  readonly ability: number;
  /** Total first-exposure results folded in. Drives the step size. */
  readonly observations: number;
  /** Accumulated Fisher information about `ability`, prior included. Drives the interval. */
  readonly information: number;
  readonly bands: Readonly<Record<BandId, BandResidual>>;
}

/** The fixed part: which bands exist and how hard each is, before any child is considered. */
export interface ProficiencyModel {
  readonly bands: readonly BandId[];
  readonly difficulty: Readonly<Record<BandId, number>>;
}

/** One bar of the chart. */
export interface BandEstimate {
  readonly band: BandId;
  /** Estimated probability of getting an unseen item from this band right. */
  readonly p: number;
  /** Interval endpoints. Wide means "few samples" and should render as such. */
  readonly lo: number;
  readonly hi: number;
  /** First-exposure results seen in this band. */
  readonly samples: number;
}

// ---------------------------------------------------------------------------
// Model construction
// ---------------------------------------------------------------------------

/**
 * Grade difficulty for spelling: linear in grade, one band every 0.55 logits,
 * with grade 5 as the zero point. A child of ability 0 is therefore an even bet
 * on an unseen grade-5 word. Spacing and origin are both guesses that the band
 * residuals are there to correct.
 */
export function spellingModel(minGrade = 1, maxGrade = 12): ProficiencyModel {
  const bands: BandId[] = [];
  const difficulty: Record<BandId, number> = {};
  for (let g = minGrade; g <= maxGrade; g += 1) {
    const band = String(g);
    bands.push(band);
    difficulty[band] = (g - 5) * 0.55;
  }
  return { bands, difficulty };
}

/**
 * Times-table difficulty, as a starting prior only. The ordering is the
 * conventional one — 1s, 2s, 5s and 10s come nearly free; 6s through 9s and the
 * 12s are where children actually stall — and is not derived from these children.
 */
const TIMES_TABLE_DIFFICULTY: Record<number, number> = {
  1: -2.2,
  2: -1.6,
  3: -0.4,
  4: -0.2,
  5: -1.2,
  6: 0.4,
  7: 0.8,
  8: 0.7,
  9: 0.5,
  10: -1.4,
  11: -0.6,
  12: 0.6,
};

export function multiplicationModel(maxTable = 12): ProficiencyModel {
  const bands: BandId[] = [];
  const difficulty: Record<BandId, number> = {};
  for (let t = 1; t <= maxTable; t += 1) {
    const band = String(t);
    bands.push(band);
    difficulty[band] = TIMES_TABLE_DIFFICULTY[t] ?? 0;
  }
  return { bands, difficulty };
}

// ---------------------------------------------------------------------------
// Estimation
// ---------------------------------------------------------------------------

export function logistic(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** A child with no history: middle of the scale, every band on the pooled curve. */
export function newProficiency(startingAbility = 0): ProficiencyState {
  return {
    ability: startingAbility,
    observations: 0,
    information: 1 / (ABILITY_PRIOR_SD * ABILITY_PRIOR_SD),
    bands: {},
  };
}

/** How much the next answer moves the ability estimate. Decays with experience, never past the floor. */
export function abilityStep(observations: number): number {
  return STEP_FLOOR + (STEP_START - STEP_FLOOR) / (1 + observations / STEP_HALFLIFE);
}

/**
 * How much of a band's raw residual is believed. Zero at no samples, so a band
 * starts pinned to the pooled curve and is only allowed to depart from it as its
 * own evidence accumulates.
 */
function residualTrust(samples: number): number {
  return samples / (samples + RESIDUAL_PSEUDO_SAMPLES);
}

/**
 * How unsure the ability estimate is, in logits.
 *
 * Two sources, and the binding one wins. Early on it is ordinary lack of data,
 * shrinking as answers accumulate from the prior spread. Later it is the
 * filter's own restlessness: a step size that never reaches zero means the
 * estimate never stops moving, and its resting spread is sqrt(step / 2I). That
 * second term is a floor no amount of data removes, which is the honest thing
 * for the chart to say — a bar that looks certain but is being nudged around by
 * every answer is the same class of error as a diagnostic that cannot
 * distinguish its outcomes.
 */
function abilitySd(state: ProficiencyState): number {
  const fromData = 1 / Math.sqrt(state.information);
  const fromJitter = Math.sqrt(abilityStep(state.observations) / (2 * TYPICAL_INFORMATION));
  return Math.max(fromData, fromJitter);
}

function bandOffset(state: ProficiencyState, band: BandId): number {
  const r = state.bands[band];
  if (r === undefined) return 0;
  return residualTrust(r.samples) * r.residual;
}

function difficultyOf(model: ProficiencyModel, band: BandId): number {
  const d = model.difficulty[band];
  if (d === undefined) throw new Error(`Unknown band: ${band}`);
  return d;
}

/** Log-odds of success on an unseen item from `band`. */
function logOdds(state: ProficiencyState, model: ProficiencyModel, band: BandId): number {
  return state.ability + bandOffset(state, band) - difficultyOf(model, band);
}

/** Probability this child gets an unseen item from `band` right. */
export function predict(state: ProficiencyState, model: ProficiencyModel, band: BandId): number {
  return logistic(logOdds(state, model, band));
}

/** One bar, with its interval. */
export function estimate(
  state: ProficiencyState,
  model: ProficiencyModel,
  band: BandId,
): BandEstimate {
  const samples = state.bands[band]?.samples ?? 0;
  const abilityVariance = abilitySd(state) ** 2;
  const residualVariance =
    RESIDUAL_PRIOR_SD *
    RESIDUAL_PRIOR_SD *
    (RESIDUAL_PSEUDO_SAMPLES / (samples + RESIDUAL_PSEUDO_SAMPLES));
  const sd = Math.sqrt(abilityVariance + residualVariance);
  const centre = logOdds(state, model, band);
  return {
    band,
    p: logistic(centre),
    lo: logistic(centre - INTERVAL_Z * sd),
    hi: logistic(centre + INTERVAL_Z * sd),
    samples,
  };
}

/** The whole chart, in band order. */
export function profile(state: ProficiencyState, model: ProficiencyModel): BandEstimate[] {
  return model.bands.map((band) => estimate(state, model, band));
}

/**
 * Fold in one first-exposure result.
 *
 * Both the pooled ability and the band's residual move on the same event, by the
 * same prediction error. That double-counts slightly and is the standard Elo
 * compromise; the residual's decay toward zero is what keeps the two from
 * drifting apart into an unidentifiable pair.
 *
 * Do not call this for a review. See the header.
 */
export function recordFirstExposure(
  state: ProficiencyState,
  model: ProficiencyModel,
  band: BandId,
  correct: boolean,
): ProficiencyState {
  const p = predict(state, model, band);
  const surprise = (correct ? 1 : 0) - p;

  const previous = state.bands[band] ?? { residual: 0, samples: 0 };
  const residual = clamp(
    previous.residual * (1 - RESIDUAL_DECAY) + RESIDUAL_STEP * surprise,
    -RESIDUAL_LIMIT,
    RESIDUAL_LIMIT,
  );

  return {
    ability: state.ability + abilityStep(state.observations) * surprise,
    observations: state.observations + 1,
    information: state.information + p * (1 - p),
    bands: { ...state.bands, [band]: { residual, samples: previous.samples + 1 } },
  };
}
