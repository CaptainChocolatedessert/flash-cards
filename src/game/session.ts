/**
 * The session engine: what to ask next, and what an answer does.
 *
 * Pure, with no DOM and no storage, for the same reason `src/core` is — this is
 * where the bugs would be, and it has to be testable without a browser. The
 * screen above it does three things only: show the question the engine hands it,
 * collect what the child typed, and hand back a result.
 *
 * Deliberately subject-agnostic. Multiplication is the first game built, but
 * nothing here knows about it: a subject supplies a `Deck` — a set of item ids
 * and which band each belongs to — and everything else is the same machinery
 * spelling will use. See DESIGN.md, "Build order", where multiplication is
 * chosen first precisely because everything it proves, spelling reuses.
 */

import {
  applyAttempt,
  bandWeights,
  chooseBand,
  dueItems,
  introductionSlots,
  isFirstExposure,
  lowBoxCount,
  newItem,
  recordFirstExposure,
  requeueMissed,
  SESSION_REINSERT_GAP,
  targetSuccess,
  timingMode,
} from "../core/index.js";
import type {
  AttemptResult,
  BandId,
  ItemState,
  ProficiencyModel,
  Rng,
  TimingMode,
} from "../core/index.js";
import { appendAttempt, appendSession } from "../storage/index.js";
import type { Keystroke, SubjectProgress } from "../storage/index.js";

/**
 * What a subject offers. The engine never learns what an item id means — for
 * multiplication it is a normalised fact like `7x8`, for spelling it will be a
 * word — only which band it belongs to, which is what the introduction
 * weighting and the estimator both need.
 */
export interface Deck {
  readonly itemIds: readonly string[];
  bandOf(itemId: string): BandId;
}

export interface SessionConfig {
  readonly deck: Deck;
  readonly model: ProficiencyModel;
  readonly rng: Rng;
  /**
   * Whether answers to this subject are typing worth measuring.
   *
   * True for spelling, where building typing speed is a wanted outcome and needs
   * a number the child can watch go up. False for multiplication: a two-digit
   * product says nothing about typing, and pooling it in would drag the rate
   * toward meaninglessness. See DESIGN.md, "Typing speed as a goal".
   */
  readonly tracksTyping?: boolean;
}

export interface Question {
  readonly itemId: string;
  readonly band: BandId;
  readonly mode: TimingMode;
  /** Never asked before. The only kind of answer the estimator reads. */
  readonly firstExposure: boolean;
  /**
   * A random number drawn when the question was made, for a subject to present
   * with. Multiplication uses it to decide whether to show `7×8` or `8×7`.
   *
   * It lives here rather than in the screen so that presentation is fixed for
   * the life of the question — a re-render must not flip the fact around while
   * the child is halfway through answering it — and so a seeded run is
   * reproducible end to end.
   */
  readonly presentationRoll: number;
}

/** What the screen hands back when the child submits. */
export interface Response {
  readonly correct: boolean;
  /** What was typed. Kept verbatim so a near-miss stays distinguishable from a blank. */
  readonly answer: string;
  readonly elapsedMs: number;
  readonly keystrokes: readonly Keystroke[];
}

export interface Session {
  readonly progress: SubjectProgress;
  /** Item ids waiting to be asked, in order. */
  readonly queue: readonly string[];
  /** The question on screen, or null when the session has run out. */
  readonly current: Question | null;
  readonly asked: number;
  readonly correct: number;
  /**
   * Items brought in during this session, in order. Kept as ids rather than a
   * count because the top-up runs ahead of the child: at the end, the ones that
   * were never reached are removed again, and only a list can say which those
   * were.
   */
  readonly introducedIds: readonly string[];
  readonly startedAt: number;
  /**
   * Correct characters typed, and the time they took.
   *
   * Only correct answers count, and they are kept as two raw numbers rather than
   * a rate so sessions can be pooled without averaging averages. Correct
   * characters per minute across a whole session is the typing-tutor measure:
   * robust to one slow word, and needing no separation of retrieval from typing
   * — which DESIGN.md establishes cannot be done for spelling anyway.
   */
  readonly correctChars: number;
  readonly typingMs: number;
}

/** Everything the readout at the end of a session shows. */
export interface SessionOutcome {
  readonly asked: number;
  readonly correct: number;
  readonly introduced: number;
  readonly progress: SubjectProgress;
}

// ---------------------------------------------------------------------------
// Starting
// ---------------------------------------------------------------------------

function states(progress: SubjectProgress): ItemState[] {
  return Object.values(progress.items);
}

/**
 * A new session: everything already due, soonest first.
 *
 * New items are not put in the queue here. They are introduced one at a time,
 * on demand, once the review queue is empty — see `advance`.
 */
export function startSession(progress: SubjectProgress, now: number): Session {
  return {
    progress,
    queue: dueItems(states(progress), now).map((s) => s.itemId),
    current: null,
    asked: 0,
    correct: 0,
    introducedIds: [],
    startedAt: now,
    correctChars: 0,
    typingMs: 0,
  };
}

// ---------------------------------------------------------------------------
// Introducing
// ---------------------------------------------------------------------------

/** Deck items this child has never met, grouped by band. */
function unseenByBand(progress: SubjectProgress, deck: Deck): Map<BandId, string[]> {
  const byBand = new Map<BandId, string[]>();
  for (const itemId of deck.itemIds) {
    if (progress.items[itemId] !== undefined) continue;
    const band = deck.bandOf(itemId);
    const bucket = byBand.get(band);
    if (bucket === undefined) byBand.set(band, [itemId]);
    else bucket.push(itemId);
  }
  return byBand;
}

/**
 * Bring one new item in, or null if nothing should come in right now.
 *
 * Two separate gates, kept separate on purpose (DESIGN.md, "How many new words"):
 * the governor decides *whether* — nothing new while too many items are still
 * churning in the low boxes — and the weighting decides *where from*.
 *
 * The weighting is used for multiplication too, which departs from the original
 * "multiplication is exempt" note. The exemption was about not *building* an
 * introduction policy for 78 facts; the policy exists and is generic over bands,
 * so the choice here is only whether to use it or to invent a second, worse
 * ordering. Using it also keeps the harder/easier control meaningful in both
 * games, which a fixed order would not.
 */
function introduce(session: Session, config: SessionConfig, now: number): Session | null {
  const slots = introductionSlots(lowBoxCount(states(session.progress)));
  if (slots <= 0) return null;

  const unseen = unseenByBand(session.progress, config.deck);
  if (unseen.size === 0) return null;

  const available: Record<BandId, number> = {};
  for (const [band, items] of unseen) available[band] = items.length;

  const weights = bandWeights(
    session.progress.proficiency,
    config.model,
    available,
    targetSuccess(session.progress.difficulty),
  );
  const band = chooseBand(weights, config.rng);
  if (band === null) return null;

  const candidates = unseen.get(band);
  if (candidates === undefined || candidates.length === 0) return null;
  const itemId = candidates[Math.floor(config.rng() * candidates.length)] ?? candidates[0];
  if (itemId === undefined) return null;

  return {
    ...session,
    progress: {
      ...session.progress,
      items: { ...session.progress.items, [itemId]: newItem(itemId, now) },
    },
    queue: [...session.queue, itemId],
    introducedIds: [...session.introducedIds, itemId],
  };
}

// ---------------------------------------------------------------------------
// Asking
// ---------------------------------------------------------------------------

function questionFor(session: Session, config: SessionConfig, itemId: string): Question | null {
  const state = session.progress.items[itemId];
  if (state === undefined) return null;
  return {
    itemId,
    band: config.deck.bandOf(itemId),
    mode: timingMode(state.box),
    firstExposure: isFirstExposure(state),
    presentationRoll: config.rng(),
  };
}

/**
 * How much material the queue is kept topped up with.
 *
 * This exists to make the intra-session gap real. A missed item is put back
 * roughly five questions later, and "five later" in an empty queue means
 * *immediately* — which is echo, not recall, and is the one thing box 1 is
 * defined to avoid. Keeping a question more than the gap in front means there
 * is always something to put between an item and its repeat.
 *
 * It is a second, tighter gate on introductions than the volume governor, and
 * it is the one that binds when a child is missing a lot: they end up cycling
 * around six unknowns rather than meeting fifteen. That is the better failure
 * mode of the two, and the ceiling still binds when reviews are plentiful.
 */
const QUEUE_TARGET = SESSION_REINSERT_GAP + 1;

/**
 * Put the next question on screen, topping the queue up with new material first
 * if there is room under both gates.
 *
 * `current` comes back null when there is nothing left to ask: no reviews due,
 * and either the deck is exhausted or the low boxes are full.
 */
export function advance(session: Session, config: SessionConfig, now: number): Session {
  let topped = session;
  while (topped.queue.length < QUEUE_TARGET) {
    const next = introduce(topped, config, now);
    if (next === null) break;
    topped = next;
  }

  const [next, ...rest] = topped.queue;
  if (next === undefined) return { ...topped, current: null };

  const question = questionFor(topped, config, next);
  // A queued id with no state is not reachable today; skipping rather than
  // throwing means a damaged record costs one question, not the session.
  if (question === null) return advance({ ...topped, queue: rest }, config, now);
  return { ...topped, queue: rest, current: question };
}

// ---------------------------------------------------------------------------
// Answering
// ---------------------------------------------------------------------------

/**
 * Fold one answer in: scheduling, proficiency, and the archive.
 *
 * The three are deliberately driven off different things. The box moves on
 * correctness alone — never on time. The estimator reads *only* first exposures,
 * because once an item is in the box system its result says something about that
 * item's rehearsal state rather than about ability on unseen ones. The archive
 * takes everything, including the keystroke timeline, which nothing interprets
 * yet and which cannot be recovered later if it is not recorded now.
 */
export function submit(
  session: Session,
  config: SessionConfig,
  response: Response,
  now: number,
): Session {
  const question = session.current;
  if (question === null) return session;

  const state = session.progress.items[question.itemId];
  if (state === undefined) return { ...session, current: null };

  const attempt: AttemptResult = {
    correct: response.correct,
    mode: question.mode,
    at: now,
    elapsedMs: response.elapsedMs,
  };

  let progress: SubjectProgress = {
    ...session.progress,
    items: { ...session.progress.items, [question.itemId]: applyAttempt(state, attempt) },
  };

  if (question.firstExposure) {
    progress = {
      ...progress,
      proficiency: recordFirstExposure(
        progress.proficiency,
        config.model,
        question.band,
        response.correct,
      ),
    };
  }

  progress = appendAttempt(progress, {
    itemId: question.itemId,
    band: question.band,
    firstExposure: question.firstExposure,
    correct: response.correct,
    mode: question.mode,
    at: now,
    elapsedMs: response.elapsedMs,
    answer: response.answer,
    keystrokes: response.keystrokes,
  });

  // A missed item comes back within the session, far enough away that answering
  // it is recall rather than echo. A timed miss did not demote, so it is not
  // unfinished business and is left on its existing interval.
  const requeue = !response.correct && question.mode === "untimed";

  // Only correct answers count toward typing speed. A misspelling has a length
  // that says nothing about how fast the child types, and counting attempts
  // would reward typing gibberish quickly.
  const counted = config.tracksTyping === true && response.correct;

  return {
    ...session,
    progress,
    queue: requeue ? requeueMissed(session.queue, question.itemId) : session.queue,
    current: null,
    asked: session.asked + 1,
    correct: session.correct + (response.correct ? 1 : 0),
    correctChars: session.correctChars + (counted ? response.answer.trim().length : 0),
    typingMs: session.typingMs + (counted ? response.elapsedMs : 0),
  };
}

// ---------------------------------------------------------------------------
// Finishing
// ---------------------------------------------------------------------------

/**
 * Drop items that were introduced but never actually asked.
 *
 * The queue is topped up ahead of the child, so a session that ends mid-queue
 * leaves several items sitting in box 1 having never been on screen. Left in the
 * record they are phantoms: they count as met, they show up in the readout as
 * "just learning", and — worst — they count toward the low-box total, so the
 * governor throttles introductions because of material the child has never seen.
 *
 * Removing them restores the invariant the rest of the system assumes, that an
 * item in the record is one the child has actually met. Nothing is lost: they go
 * back to being unseen deck items and can be introduced again next time.
 */
function forgetUnasked(progress: SubjectProgress): SubjectProgress {
  const items: Record<string, ItemState> = {};
  for (const [itemId, state] of Object.entries(progress.items)) {
    if (state.timesSeen > 0) items[itemId] = state;
  }
  return { ...progress, items };
}

/**
 * Close the session and write its summary into the record.
 *
 * A session where nothing was asked leaves no summary — an empty row would
 * otherwise show up in the trend lines as a session with no accuracy at all.
 *
 * `correctChars` and `typingMs` carry through from the session, and stay zero
 * unless the subject tracks typing — see `SessionConfig.tracksTyping`.
 */
export function endSession(session: Session, now: number): SessionOutcome {
  const progress = forgetUnasked(session.progress);

  if (session.asked === 0) {
    return { asked: 0, correct: 0, introduced: 0, progress };
  }

  // Only the introductions the child actually reached count — the rest were
  // just queued ahead of them and have been removed again.
  const introduced = session.introducedIds.filter(
    (itemId) => progress.items[itemId] !== undefined,
  ).length;

  return {
    asked: session.asked,
    correct: session.correct,
    introduced,
    progress: appendSession(progress, {
      startedAt: session.startedAt,
      endedAt: now,
      asked: session.asked,
      correct: session.correct,
      introduced,
      correctChars: session.correctChars,
      typingMs: session.typingMs,
    }),
  };
}

/** Correct characters per minute across a session. Null when nothing countable was typed. */
export function typingSpeed(correctChars: number, typingMs: number): number | null {
  if (typingMs <= 0 || correctChars <= 0) return null;
  return (correctChars / typingMs) * 60_000;
}
