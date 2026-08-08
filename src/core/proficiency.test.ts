import { describe, expect, it } from "vitest";
import { bandWeights, chooseBand } from "./introduction.js";
import {
  abilityStep,
  estimate,
  logistic,
  multiplicationModel,
  newProficiency,
  predict,
  profile,
  recordFirstExposure,
  spellingModel,
} from "./proficiency.js";
import type { ProficiencyModel, ProficiencyState } from "./proficiency.js";
import { mulberry32 } from "./rng.js";
import type { Rng } from "./rng.js";

const MODEL = spellingModel(1, 12);
const PLENTIFUL = Object.fromEntries(MODEL.bands.map((b) => [b, 1000]));

/**
 * A synthetic child with a known true ability, answering according to the same
 * Rasch model the estimator assumes. This is the only way to know the estimator
 * works before a real child has generated a year of data.
 */
function simulate(
  model: ProficiencyModel,
  trueAbilityAt: (step: number) => number,
  steps: number,
  rng: Rng,
): { state: ProficiencyState; abilityTrace: number[] } {
  let state = newProficiency();
  const abilityTrace: number[] = [];
  for (let i = 0; i < steps; i += 1) {
    // Bands are picked the way the real game picks them, so the estimator is
    // exercised against its own introduction policy rather than a uniform sweep.
    const band = chooseBand(bandWeights(state, model, PLENTIFUL), rng) ?? "5";
    const difficulty = model.difficulty[band] ?? 0;
    const correct = rng() < logistic(trueAbilityAt(i) - difficulty);
    state = recordFirstExposure(state, model, band, correct);
    abilityTrace.push(state.ability);
  }
  return { state, abilityTrace };
}

function mean(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// Several seeds, not one. A single seed passing says nothing about an estimator
// driven by simulated coin flips; the tolerances below sit above the worst case
// of a thirty-seed sweep, so they measure the estimator rather than the seed.
const SEEDS = [1, 2, 3, 4, 5];

describe("simulated children", () => {
  it("converges on a fixed true ability", () => {
    for (const trueAbility of [-1.5, 0, 1.2, 2.5]) {
      for (const seed of SEEDS) {
        const { abilityTrace } = simulate(MODEL, () => trueAbility, 600, mulberry32(seed));
        // Averaged over the tail, because a floored step size means the estimate
        // jitters around the truth forever rather than settling on it.
        const settled = mean(abilityTrace.slice(-200));
        expect(Math.abs(settled - trueAbility)).toBeLessThan(0.6);
      }
    }
  });

  it("tracks an ability that rises, instead of locking onto a stale value", () => {
    for (const seed of SEEDS.slice(0, 3)) {
      const { abilityTrace } = simulate(MODEL, (i) => (i < 400 ? 0 : 2), 1600, mulberry32(seed));
      const before = mean(abilityTrace.slice(200, 400));
      const after = mean(abilityTrace.slice(-300));
      expect(Math.abs(before - 0)).toBeLessThan(0.5);
      expect(Math.abs(after - 2)).toBeLessThan(0.5);
    }
  });

  it("keeps its step size above the floor no matter how much history there is", () => {
    expect(abilityStep(0)).toBeCloseTo(0.6, 6);
    expect(abilityStep(100_000)).toBeGreaterThan(0.049);
    expect(abilityStep(1_000_000)).toBeGreaterThanOrEqual(abilityStep(Infinity));
  });

  it("recovers a band the child is genuinely better at than the pooled curve predicts", () => {
    // A child of ability 0 everywhere except grade 9, where they are two logits
    // stronger — the non-monotone case a single-parameter model cannot express.
    const rng = mulberry32(3);
    let state = newProficiency();
    for (let i = 0; i < 900; i += 1) {
      const band = String(1 + (i % 12));
      const difficulty = MODEL.difficulty[band] ?? 0;
      const bonus = band === "9" ? 2 : 0;
      state = recordFirstExposure(state, MODEL, band, rng() < logistic(bonus - difficulty));
    }
    const nine = predict(state, MODEL, "9");
    const eight = predict(state, MODEL, "8");
    expect(nine).toBeGreaterThan(eight);
    expect(nine).toBeGreaterThan(logistic(2 - (MODEL.difficulty["9"] ?? 0)) - 0.2);
  });
});

describe("the profile as a chart", () => {
  it("is monotone before any band has evidence of its own", () => {
    const bars = profile(newProficiency(0.5), MODEL);
    for (let i = 1; i < bars.length; i += 1) {
      expect(bars[i]!.p).toBeLessThan(bars[i - 1]!.p);
    }
  });

  it("starts wide and narrows only where evidence accumulates", () => {
    let state = newProficiency();
    const before = estimate(state, MODEL, "5");
    expect(before.samples).toBe(0);
    expect(before.hi - before.lo).toBeGreaterThan(0.5);

    for (let i = 0; i < 60; i += 1) state = recordFirstExposure(state, MODEL, "5", i % 2 === 0);
    const after = estimate(state, MODEL, "5");
    expect(after.samples).toBe(60);
    expect(after.hi - after.lo).toBeLessThan(before.hi - before.lo);
    // Never certain: a tracking filter must keep some doubt or the chart lies.
    expect(after.hi - after.lo).toBeGreaterThan(0.05);
  });

  it("keeps a floor under the interval however much data arrives", () => {
    let state = newProficiency();
    for (let i = 0; i < 5000; i += 1) state = recordFirstExposure(state, MODEL, "5", i % 2 === 0);
    const bar = estimate(state, MODEL, "5");
    // The estimate is still being nudged by every answer, so the bar must not
    // claim a precision the filter does not have.
    expect(bar.hi - bar.lo).toBeGreaterThan(0.15);
    expect(bar.hi - bar.lo).toBeLessThan(0.45);
  });

  it("pins a band to the pooled curve until it has samples of its own", () => {
    let state = newProficiency();
    const pooledOnly = predict(newProficiency(), MODEL, "11");
    state = recordFirstExposure(state, MODEL, "11", false);
    // One answer barely moves grade 11 off the shared curve, beyond what the
    // pooled ability shift already did.
    const shifted = predict({ ...state, bands: {} }, MODEL, "11");
    expect(Math.abs(predict(state, MODEL, "11") - shifted)).toBeLessThan(0.02);
    expect(predict(state, MODEL, "11")).toBeLessThan(pooledOnly);
  });
});

describe("every answer informs every band", () => {
  it("lowers grades that were never asked about", () => {
    let state = newProficiency();
    const before = predict(state, MODEL, "2");
    for (let i = 0; i < 10; i += 1) state = recordFirstExposure(state, MODEL, "7", false);
    expect(predict(state, MODEL, "2")).toBeLessThan(before);
  });
});

describe("the multiplication model", () => {
  it("has one band per times table, hardest in the middle-to-high tables", () => {
    const model = multiplicationModel();
    expect(model.bands).toHaveLength(12);
    const fresh = newProficiency();
    expect(predict(fresh, model, "1")).toBeGreaterThan(predict(fresh, model, "7"));
    expect(predict(fresh, model, "10")).toBeGreaterThan(predict(fresh, model, "12"));
  });

  it("rejects a band it does not know", () => {
    expect(() => predict(newProficiency(), multiplicationModel(), "13")).toThrow(/Unknown band/);
  });
});
