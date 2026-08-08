import { describe, expect, it } from "vitest";
import {
  DEFAULT_TARGET_SUCCESS,
  LOW_BOX_CEILING,
  activeBands,
  bandWeights,
  chooseBand,
  introductionSlots,
  targetSuccess,
} from "./introduction.js";
import { newProficiency, predict, recordFirstExposure, spellingModel } from "./proficiency.js";
import { mulberry32 } from "./rng.js";
import type { BandId } from "./types.js";

const MODEL = spellingModel(1, 12);
const PLENTIFUL: Record<BandId, number> = Object.fromEntries(MODEL.bands.map((b) => [b, 500]));

function peakBand(weights: readonly { band: BandId; weight: number }[]): BandId {
  return weights.reduce((best, w) => (w.weight > best.weight ? w : best)).band;
}

describe("where new items come from", () => {
  it("peaks where the child is predicted to succeed about as often as the target", () => {
    const weights = bandWeights(newProficiency(), MODEL, PLENTIFUL);
    const winner = weights.find((w) => w.band === peakBand(weights))!;
    expect(Math.abs(winner.p - DEFAULT_TARGET_SUCCESS)).toBeLessThan(0.15);
  });

  it("normalises to one", () => {
    const total = bandWeights(newProficiency(), MODEL, PLENTIFUL).reduce(
      (sum, w) => sum + w.weight,
      0,
    );
    expect(total).toBeCloseTo(1, 10);
  });

  it("puts essentially all its mass where the child is actually learning", () => {
    const weights = bandWeights(newProficiency(), MODEL, PLENTIFUL);
    const learning = weights
      .filter((w) => w.p > 0.45 && w.p < 0.92)
      .reduce((sum, w) => sum + w.weight, 0);
    expect(learning).toBeGreaterThan(0.95);
  });

  it("all but ignores a band the child has outgrown, without ignoring it entirely", () => {
    const weights = bandWeights(newProficiency(), MODEL, PLENTIFUL);
    const easiest = weights[0]!;
    const peak = Math.max(...weights.map((w) => w.weight));
    expect(easiest.p).toBeGreaterThan(0.9);
    expect(easiest.weight).toBeLessThan(peak / 2);
    // Not zero: the fast-track makes a probe into an easy band cost one question,
    // so the occasional wasted one is affordable and worth keeping.
    expect(easiest.weight).toBeGreaterThan(0);
  });

  it("never introduces from a band that is out of reach", () => {
    const weights = bandWeights(newProficiency(), MODEL, PLENTIFUL);
    const hardest = weights[weights.length - 1]!;
    expect(hardest.p).toBeLessThan(0.1);
    expect(hardest.weight).toBeLessThan(0.001);
  });

  it("moves up as the child gets better", () => {
    let strong = newProficiency();
    for (let i = 0; i < 40; i += 1) strong = recordFirstExposure(strong, MODEL, "9", true);
    const before = Number(peakBand(bandWeights(newProficiency(), MODEL, PLENTIFUL)));
    const after = Number(peakBand(bandWeights(strong, MODEL, PLENTIFUL)));
    expect(after).toBeGreaterThan(before);
  });

  it("skips bands with nothing left to offer", () => {
    const exhausted = { ...PLENTIFUL, ...Object.fromEntries(MODEL.bands.map((b) => [b, 0])), "9": 5 };
    const weights = bandWeights(newProficiency(), MODEL, exhausted);
    expect(weights.filter((w) => w.weight > 0).map((w) => w.band)).toEqual(["9"]);
  });

  it("weights nothing when the corpus is used up", () => {
    const empty = Object.fromEntries(MODEL.bands.map((b) => [b, 0]));
    const weights = bandWeights(newProficiency(), MODEL, empty);
    expect(weights.every((w) => w.weight === 0)).toBe(true);
    expect(chooseBand(weights, mulberry32(1))).toBeNull();
  });
});

describe("drawing a band", () => {
  it("samples in proportion to the weights", () => {
    const rng = mulberry32(42);
    const weights = bandWeights(newProficiency(), MODEL, PLENTIFUL);
    const counts = new Map<BandId, number>();
    for (let i = 0; i < 4000; i += 1) {
      const band = chooseBand(weights, rng)!;
      counts.set(band, (counts.get(band) ?? 0) + 1);
    }
    for (const w of weights) {
      expect((counts.get(w.band) ?? 0) / 4000).toBeCloseTo(w.weight, 1);
    }
  });

  it("only ever returns a band that has items available", () => {
    const rng = mulberry32(5);
    const scarce = { ...Object.fromEntries(MODEL.bands.map((b) => [b, 0])), "4": 2, "5": 2 };
    const weights = bandWeights(newProficiency(), MODEL, scarce);
    for (let i = 0; i < 200; i += 1) {
      expect(["4", "5"]).toContain(chooseBand(weights, rng));
    }
  });
});

describe("the harder/easier control", () => {
  it("maps a harder setting to a lower success target", () => {
    expect(targetSuccess(-2)).toBeGreaterThan(targetSuccess(0));
    expect(targetSuccess(0)).toBe(DEFAULT_TARGET_SUCCESS);
    expect(targetSuccess(2)).toBeLessThan(targetSuccess(0));
  });

  it("shifts the zone the chart highlights", () => {
    const state = newProficiency();
    const easier = bandWeights(state, MODEL, PLENTIFUL, targetSuccess(-2));
    const harder = bandWeights(state, MODEL, PLENTIFUL, targetSuccess(2));
    expect(Number(peakBand(harder))).toBeGreaterThan(Number(peakBand(easier)));
  });

  it("marks a contiguous handful of bands as active, not the whole chart", () => {
    const active = activeBands(bandWeights(newProficiency(), MODEL, PLENTIFUL));
    expect(active.length).toBeGreaterThan(0);
    expect(active.length).toBeLessThan(MODEL.bands.length / 2);
    const numbers = active.map(Number);
    expect(Math.max(...numbers) - Math.min(...numbers)).toBe(numbers.length - 1);
  });

  it("marks nothing when there is nothing to introduce", () => {
    const empty = Object.fromEntries(MODEL.bands.map((b) => [b, 0]));
    expect(activeBands(bandWeights(newProficiency(), MODEL, empty))).toEqual([]);
  });
});

describe("the volume governor", () => {
  it("allows introductions up to the ceiling and none past it", () => {
    expect(introductionSlots(0)).toBe(LOW_BOX_CEILING);
    expect(introductionSlots(LOW_BOX_CEILING - 3)).toBe(3);
    expect(introductionSlots(LOW_BOX_CEILING)).toBe(0);
    expect(introductionSlots(LOW_BOX_CEILING + 20)).toBe(0);
  });

  it("is independent of where new items would come from", () => {
    // Volume and mix are separate questions; the weighting must not smuggle a
    // count in through the back door.
    const weights = bandWeights(newProficiency(), MODEL, PLENTIFUL);
    expect(weights.reduce((sum, w) => sum + w.weight, 0)).toBeCloseTo(1, 10);
    expect(introductionSlots(4)).toBe(LOW_BOX_CEILING - 4);
  });
});

describe("the estimate the weighting reads is the one the chart shows", () => {
  it("uses predict for both", () => {
    let state = newProficiency();
    for (let i = 0; i < 15; i += 1) state = recordFirstExposure(state, MODEL, "6", i % 3 !== 0);
    const weights = bandWeights(state, MODEL, PLENTIFUL);
    for (const w of weights) {
      expect(w.p).toBeCloseTo(predict(state, MODEL, w.band), 12);
    }
  });
});
