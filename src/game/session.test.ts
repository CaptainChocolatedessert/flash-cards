import { describe, expect, it } from "vitest";
import {
  FAST_TRACK_BOX,
  LOW_BOX_CEILING,
  mulberry32,
  multiplicationModel,
  newItem,
  newProficiency,
  predict,
  applyAttempt,
} from "../core/index.js";
import { newRecord } from "../storage/index.js";
import type { SubjectProgress } from "../storage/index.js";
import { advance, endSession, startSession, submit, typingSpeed } from "./session.js";
import type { Response, Session, SessionConfig } from "./session.js";
import {
  answeredFromMemory,
  correctAnswer,
  isCorrect,
  multiplicationDeck,
  multiplicationFluencyLimitMs,
} from "./multiplication.js";

const T0 = Date.parse("2026-09-01T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function config(seed = 1): SessionConfig {
  return { deck: multiplicationDeck(), model: multiplicationModel(), rng: mulberry32(seed) };
}

function emptyProgress(): SubjectProgress {
  return newRecord("Sam", T0).subjects.multiplication;
}

function answer(correct: boolean, overrides: Partial<Response> = {}): Response {
  return {
    correct,
    answer: correct ? "56" : "54",
    elapsedMs: 2200,
    keystrokes: [
      { t: 900, key: "5" },
      { t: 1040, key: correct ? "6" : "4" },
    ],
    ...overrides,
  };
}

/** Play through, answering each question with `decide`. Returns the finished session. */
function play(
  session: Session,
  cfg: SessionConfig,
  decide: (itemId: string, index: number) => boolean,
  limit = 200,
  now = T0,
): Session {
  let current = advance(session, cfg, now);
  let i = 0;
  while (current.current !== null && i < limit) {
    const correct = decide(current.current.itemId, i);
    current = submit(current, cfg, answer(correct), now + i * 1000);
    current = advance(current, cfg, now + i * 1000);
    i += 1;
  }
  return current;
}

describe("starting a session", () => {
  it("asks nothing before it is advanced", () => {
    expect(startSession(emptyProgress(), T0).current).toBeNull();
  });

  it("introduces material when there is no history at all", () => {
    const cfg = config();
    const session = advance(startSession(emptyProgress(), T0), cfg, T0);
    expect(session.current).not.toBeNull();
    expect(session.current?.firstExposure).toBe(true);
    expect(cfg.deck.itemIds).toContain(session.current?.itemId);
  });

  it("keeps enough ahead of the child that a missed item is not echoed back", () => {
    const cfg = config();
    let session = advance(startSession(emptyProgress(), T0), cfg, T0);
    const missed = session.current?.itemId ?? "";

    session = submit(session, cfg, answer(false), T0 + 3000);
    session = advance(session, cfg, T0 + 3000);

    // The miss comes back later in the session, but not as the very next
    // question — that would be echo rather than recall.
    expect(session.current?.itemId).not.toBe(missed);
    expect(session.queue).toContain(missed);
  });

  it("asks due reviews before introducing anything new", () => {
    const progress = emptyProgress();
    const seen = applyAttempt(newItem("3x4", T0 - 5 * DAY), {
      correct: false,
      mode: "untimed",
      at: T0 - 5 * DAY,
      elapsedMs: 3000,
    });
    const withHistory: SubjectProgress = { ...progress, items: { "3x4": seen } };

    const session = advance(startSession(withHistory, T0), config(), T0);

    expect(session.current?.itemId).toBe("3x4");
    expect(session.current?.firstExposure).toBe(false);
  });

  it("leaves items that are not due yet alone", () => {
    const notDue = applyAttempt(newItem("3x4", T0), {
      correct: true,
      mode: "untimed",
      at: T0,
      elapsedMs: 1000,
    });
    const progress: SubjectProgress = { ...emptyProgress(), items: { "3x4": notDue } };

    const session = advance(startSession(progress, T0 + DAY), config(), T0 + DAY);

    // Fast-tracked to box 5, so it is 21 days out; anything asked now is new.
    expect(session.current?.itemId).not.toBe("3x4");
    expect(session.introducedIds.length).toBeGreaterThan(0);
    expect(session.progress.items["3x4"]).toEqual(notDue);
  });
});

describe("answering", () => {
  it("fast-tracks a correct first exposure out of the cycle", () => {
    const cfg = config();
    const session = advance(startSession(emptyProgress(), T0), cfg, T0);
    const itemId = session.current?.itemId ?? "";

    const after = submit(session, cfg, answer(true), T0 + 3000);

    expect(after.progress.items[itemId]?.box).toBe(FAST_TRACK_BOX);
    expect(after.correct).toBe(1);
    expect(after.asked).toBe(1);
  });

  it("sends a missed item to box 1 and brings it back this session", () => {
    const cfg = config();
    let session = advance(startSession(emptyProgress(), T0), cfg, T0);
    const itemId = session.current?.itemId ?? "";

    session = submit(session, cfg, answer(false), T0 + 3000);

    expect(session.progress.items[itemId]?.box).toBe(1);
    expect(session.queue).toContain(itemId);
    expect(session.correct).toBe(0);
  });

  it("holds a right-but-slow answer where it is when the subject gates on speed", () => {
    const cfg: SessionConfig = { ...config(), fluencyLimitMs: multiplicationFluencyLimitMs };
    let session = advance(startSession(emptyProgress(), T0), cfg, T0);
    const itemId = session.current?.itemId ?? "";

    session = submit(session, cfg, answer(true, { elapsedMs: 20_000 }), T0 + 20_000);

    // No fast-track: the fact was worked out, not remembered.
    expect(session.progress.items[itemId]?.box).toBe(1);
    // Still a right answer everywhere else it is counted.
    expect(session.correct).toBe(1);
    expect(session.progress.items[itemId]?.timesCorrect).toBe(1);
    // And not brought back within the session — that is what a miss earns, and
    // an item re-asked five questions later would be measuring echo anyway.
    expect(session.queue).not.toContain(itemId);
  });

  it("still tells the estimator a slow right answer was right", () => {
    const cfg: SessionConfig = { ...config(), fluencyLimitMs: multiplicationFluencyLimitMs };
    const session = advance(startSession(emptyProgress(), T0), cfg, T0);
    const band = session.current?.band ?? "";
    const before = predict(session.progress.proficiency, cfg.model, band);

    const after = submit(session, cfg, answer(true, { elapsedMs: 20_000 }), T0 + 20_000);

    // The estimator answers "would they get an unseen fact right", and a slow
    // right answer is still a right one. Speed governs the box, not the chart.
    expect(predict(after.progress.proficiency, cfg.model, band)).toBeGreaterThan(before);
  });

  it("leaves a subject with no fluency limit promoting on correctness alone", () => {
    const cfg = config();
    const session = advance(startSession(emptyProgress(), T0), cfg, T0);
    const itemId = session.current?.itemId ?? "";

    const after = submit(session, cfg, answer(true, { elapsedMs: 60_000 }), T0 + 60_000);

    expect(after.progress.items[itemId]?.box).toBe(FAST_TRACK_BOX);
  });

  it("gives the screen the same verdict the scheduler used", () => {
    // The feedback card decides what to say by calling this; the engine decides
    // where the fact goes by calling the limit. They have to agree, or a child
    // is told one thing and shown another.
    const limit = multiplicationFluencyLimitMs("7x8");
    expect(answeredFromMemory("7x8", limit)).toBe(true);
    expect(answeredFromMemory("7x8", limit + 1)).toBe(false);
  });

  it("records the keystroke timeline and what was typed", () => {
    const cfg = config();
    const session = advance(startSession(emptyProgress(), T0), cfg, T0);

    const after = submit(
      session,
      cfg,
      answer(false, { answer: "54", keystrokes: [{ t: 800, key: "5" }, { t: 1500, key: "4" }] }),
      T0 + 3000,
    );

    const attempt = after.progress.attempts[0];
    expect(attempt?.answer).toBe("54");
    expect(attempt?.keystrokes).toEqual([{ t: 800, key: "5" }, { t: 1500, key: "4" }]);
    expect(attempt?.firstExposure).toBe(true);
  });

  it("moves the estimator on a first exposure", () => {
    const cfg = config();
    const session = advance(startSession(emptyProgress(), T0), cfg, T0);
    const before = session.progress.proficiency;

    const after = submit(session, cfg, answer(false), T0 + 1000);

    expect(after.progress.proficiency.observations).toBe(1);
    expect(after.progress.proficiency.ability).toBeLessThan(before.ability);
  });

  it("leaves the estimator alone on a review", () => {
    // Once an item is in the box system, its result says something about that
    // item's rehearsal state, not about ability on unseen ones.
    const cfg = config();
    const seen = applyAttempt(newItem("3x4", T0 - 5 * DAY), {
      correct: false,
      mode: "untimed",
      at: T0 - 5 * DAY,
      elapsedMs: 3000,
    });
    const progress: SubjectProgress = { ...emptyProgress(), items: { "3x4": seen } };

    let session = advance(startSession(progress, T0), cfg, T0);
    expect(session.current?.itemId).toBe("3x4");
    const before = session.progress.proficiency;

    session = submit(session, cfg, answer(true), T0 + 2000);

    expect(session.progress.proficiency.observations).toBe(before.observations);
    expect(session.progress.proficiency.ability).toBe(before.ability);
    // The box still moved — correctness schedules, it just does not rate.
    expect(session.progress.items["3x4"]?.box).toBe(2);
  });

  it("credits a first exposure to the larger factor's table", () => {
    const cfg = config();
    const session = advance(startSession(emptyProgress(), T0), cfg, T0);
    const question = session.current;
    const [a, b] = (question?.itemId ?? "1x1").split("x").map(Number);

    expect(question?.band).toBe(String(Math.max(a ?? 0, b ?? 0)));
  });
});

describe("timed questions", () => {
  /** Box 4+ is asked against the clock, and a timed miss must not demote. */
  function progressWithKnownFact(): SubjectProgress {
    let state = newItem("6x7", T0 - 100 * DAY);
    // Correct first exposure fast-tracks to box 5, which is timed.
    state = applyAttempt(state, {
      correct: true,
      mode: "untimed",
      at: T0 - 100 * DAY,
      elapsedMs: 2000,
    });
    return { ...emptyProgress(), items: { "6x7": state } };
  }

  it("asks a well-known fact against the clock", () => {
    const session = advance(startSession(progressWithKnownFact(), T0), config(), T0);
    expect(session.current?.itemId).toBe("6x7");
    expect(session.current?.mode).toBe("timed");
  });

  it("does not demote on a timed miss, and does not requeue it", () => {
    const cfg = config();
    const before = progressWithKnownFact();
    const session = advance(startSession(before, T0), cfg, T0);

    const after = submit(session, cfg, answer(false), T0 + 9000);

    expect(after.progress.items["6x7"]?.box).toBe(before.items["6x7"]?.box);
    expect(after.queue).not.toContain("6x7");
    // Still counted as a miss in the session readout — it just does not schedule.
    expect(after.correct).toBe(0);
    expect(after.asked).toBe(1);
  });
});

describe("the volume governor", () => {
  it("cycles a small set rather than piling on more when the child misses everything", () => {
    const cfg = config();
    // Miss everything, so every introduction lands in box 1 and stays there.
    const session = play(startSession(emptyProgress(), T0), cfg, () => false, 400);

    // The queue top-up is the binding gate here, well under the ceiling: a
    // child who is getting nothing right ends up working a handful of facts
    // rather than being handed fifteen unknowns.
    expect(session.introducedIds.length).toBeLessThanOrEqual(LOW_BOX_CEILING);
    expect(session.introducedIds.length).toBeLessThanOrEqual(8);
    expect(session.introducedIds.length).toBeGreaterThan(1);

    const inLowBoxes = Object.values(session.progress.items).filter(
      (s) => s.box === 1 || s.box === 2,
    );
    expect(inLowBoxes).toHaveLength(session.introducedIds.length);
  });

  it("never exceeds the ceiling on items churning in the low boxes", () => {
    const cfg = config(3);
    // Right two times in three: enough correct answers to keep draining the
    // queue and pulling more in, so the ceiling is what has to hold.
    const session = play(startSession(emptyProgress(), T0), cfg, (_, i) => i % 3 !== 0, 400);

    const inLowBoxes = Object.values(session.progress.items).filter(
      (s) => s.box === 1 || s.box === 2,
    );
    expect(inLowBoxes.length).toBeLessThanOrEqual(LOW_BOX_CEILING);
  });

  it("keeps introducing when everything is answered right, since nothing piles up", () => {
    const cfg = config();
    const session = play(startSession(emptyProgress(), T0), cfg, () => true, 200);

    // Every correct first exposure is fast-tracked straight to box 5, so the low
    // boxes never fill and the whole deck is reachable in one sitting.
    expect(session.introducedIds.length).toBe(cfg.deck.itemIds.length);
    expect(session.current).toBeNull();
  });

  it("never introduces the same fact twice", () => {
    const cfg = config();
    const session = play(startSession(emptyProgress(), T0), cfg, (_, i) => i % 3 !== 0, 400);
    const ids = Object.keys(session.progress.items);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("finishing", () => {
  it("writes a summary with the session's counts", () => {
    const cfg = config();
    const session = play(startSession(emptyProgress(), T0), cfg, (_, i) => i % 2 === 0, 8);

    const outcome = endSession(session, T0 + 300_000);
    const summary = outcome.progress.sessions.at(-1);

    expect(summary?.asked).toBe(session.asked);
    expect(summary?.correct).toBe(session.correct);
    expect(summary?.introduced).toBe(outcome.introduced);
    expect(summary?.startedAt).toBe(T0);
    expect(summary?.endedAt).toBe(T0 + 300_000);

    // Fewer facts were reached than were queued ahead of the child, and the
    // summary reports the ones actually met.
    expect(outcome.introduced).toBeLessThan(session.introducedIds.length);
  });

  it("leaves no summary when nothing was asked", () => {
    const outcome = endSession(startSession(emptyProgress(), T0), T0 + 1000);
    expect(outcome.progress.sessions).toHaveLength(0);
  });

  it("forgets facts that were queued up but never actually asked", () => {
    const cfg = config();
    // One question answered, with the queue topped up well beyond it.
    let session = advance(startSession(emptyProgress(), T0), cfg, T0);
    const asked = session.current?.itemId ?? "";
    session = submit(session, cfg, answer(true), T0 + 2000);
    expect(session.introducedIds.length).toBeGreaterThan(1);

    const outcome = endSession(session, T0 + 3000);

    // Only the fact the child actually saw stays in the record. The rest were
    // queued ahead of them and would otherwise sit in box 1 for ever, counting
    // as met and throttling the governor.
    expect(Object.keys(outcome.progress.items)).toEqual([asked]);
    expect(outcome.introduced).toBe(1);
    expect(outcome.progress.sessions.at(-1)?.introduced).toBe(1);
  });

  it("does not count facts met in an earlier session as newly introduced", () => {
    const cfg = config();
    const old = applyAttempt(newItem("3x4", T0 - 5 * DAY), {
      correct: false,
      mode: "untimed",
      at: T0 - 5 * DAY,
      elapsedMs: 3000,
    });
    const progress: SubjectProgress = { ...emptyProgress(), items: { "3x4": old } };

    let session = advance(startSession(progress, T0), cfg, T0);
    expect(session.current?.itemId).toBe("3x4");
    session = submit(session, cfg, answer(true), T0 + 2000);

    const outcome = endSession(session, T0 + 3000);

    // It was asked, and it was the only thing asked — but it is not new.
    expect(outcome.asked).toBe(1);
    expect(outcome.introduced).toBe(0);
  });

  it("records no typing speed for multiplication — a two-digit product says nothing about typing", () => {
    const cfg = config();
    const session = play(startSession(emptyProgress(), T0), cfg, () => true, 5);
    const summary = endSession(session, T0 + 60_000).progress.sessions.at(-1);
    expect(summary?.correctChars).toBe(0);
    expect(summary?.typingMs).toBe(0);
  });

  it("counts typing when the subject tracks it, and only for correct answers", () => {
    const cfg = { ...config(), tracksTyping: true };
    let session = advance(startSession(emptyProgress(), T0), cfg, T0);

    // Correct: 5 characters over 2 seconds.
    session = submit(
      session,
      cfg,
      { correct: true, answer: "rhythm", elapsedMs: 2000, keystrokes: [] },
      T0 + 2000,
    );
    session = advance(session, cfg, T0 + 2000);
    // Wrong: must not count, however much was typed.
    session = submit(
      session,
      cfg,
      { correct: false, answer: "wrongwrongwrong", elapsedMs: 9000, keystrokes: [] },
      T0 + 11_000,
    );

    expect(session.correctChars).toBe(6);
    expect(session.typingMs).toBe(2000);

    const summary = endSession(session, T0 + 20_000).progress.sessions.at(-1);
    expect(summary?.correctChars).toBe(6);
    expect(summary?.typingMs).toBe(2000);
  });

  it("turns characters and time into a rate a child can watch go up", () => {
    // 180 correct characters in 60 seconds is 180 a minute.
    expect(typingSpeed(180, 60_000)).toBeCloseTo(180);
    expect(typingSpeed(0, 60_000)).toBeNull();
    expect(typingSpeed(50, 0)).toBeNull();
  });
});

describe("a child who knows the easy tables and not the hard ones", () => {
  /**
   * The end-to-end check: play several sessions as a simulated child who gets
   * the small tables right and the large ones wrong, and see whether the system
   * ends up pointed at the right material.
   */
  it("learns where the child is weak and introduces from there", () => {
    const cfg = config(7);
    let progress = emptyProgress();
    const knowsUpTo = 6;

    for (let day = 0; day < 6; day += 1) {
      const now = T0 + day * DAY;
      let session = play(
        startSession(progress, now),
        cfg,
        (itemId) => {
          const [, b] = itemId.split("x").map(Number);
          return (b ?? 12) <= knowsUpTo;
        },
        300,
        now,
      );
      progress = endSession(session, now + 600_000).progress;
    }

    // The hard tables should now look harder than they did before any evidence
    // arrived, and easier tables should still rate above them.
    const model = multiplicationModel();
    const before = newProficiency();
    expect(predict(progress.proficiency, model, "11")).toBeLessThan(
      predict(before, model, "11"),
    );
    expect(predict(progress.proficiency, model, "3")).toBeGreaterThan(
      predict(progress.proficiency, model, "11"),
    );

    // And the facts actually being drilled — the ones stuck in the low boxes —
    // should be the ones from the tables the child does not know.
    const stuck = Object.values(progress.items)
      .filter((s) => s.box <= 2)
      .map((s) => Number(s.itemId.split("x")[1] ?? 0));
    expect(stuck.length).toBeGreaterThan(0);
    expect(stuck.every((table) => table > knowsUpTo)).toBe(true);
  });
});

describe("answer checking", () => {
  it("accepts the product, with or without stray spaces", () => {
    expect(isCorrect("7x8", "56")).toBe(true);
    expect(isCorrect("7x8", " 56 ")).toBe(true);
  });

  it("rejects a wrong number, a blank, and anything that is not one", () => {
    expect(isCorrect("7x8", "54")).toBe(false);
    expect(isCorrect("7x8", "")).toBe(false);
    expect(isCorrect("7x8", "   ")).toBe(false);
    expect(isCorrect("7x8", "5 6")).toBe(false);
    expect(isCorrect("7x8", "fifty-six")).toBe(false);
  });

  it("knows the products", () => {
    expect(correctAnswer("7x8")).toBe(56);
    expect(correctAnswer("12x12")).toBe(144);
    expect(correctAnswer("1x9")).toBe(9);
  });
});
