/**
 * Leitner scheduling. See DESIGN.md, "The scheduler — Leitner boxes".
 *
 * Correctness moves items between boxes and nothing else does. Elapsed time is
 * carried on the attempt so it can be reported, but it never reaches a decision
 * here — the one place timing matters is that a timed miss does not demote.
 */

import type { AttemptResult, Box, ItemState, TimingMode } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Days until an item in each box comes back. Box 1 is intra-session; box 6 never. */
export const BOX_INTERVAL_DAYS: Record<Box, number | null> = {
  1: 0,
  2: 1,
  3: 3,
  4: 7,
  5: 21,
  6: null,
};

export const RETIRED_BOX: Box = 6;

/**
 * Where a correct first exposure lands. Not box 2 — an already-known item must
 * cost about one question, or a child working below their level spends weeks
 * re-proving what they already know. This is what makes "no placement test"
 * viable rather than merely slow.
 */
export const FAST_TRACK_BOX: Box = 5;

/** From this box up, an item is effectively known and gets asked against the clock. */
export const TIMED_FROM_BOX = 4;

/** Roughly how many other items come between a miss and its re-ask in the same session. */
export const SESSION_REINSERT_GAP = 5;

/** A freshly introduced item: box 1, due immediately, never asked. */
export function newItem(itemId: string, now: number): ItemState {
  return {
    itemId,
    box: 1,
    dueAt: now,
    timesSeen: 0,
    timesCorrect: 0,
    lastResult: null,
  };
}

export function isRetired(state: ItemState): boolean {
  return state.box === RETIRED_BOX;
}

export function isDue(state: ItemState, now: number): boolean {
  return state.dueAt !== null && state.dueAt <= now;
}

/** Never asked yet. The only kind of result that tells the estimator anything. */
export function isFirstExposure(state: ItemState): boolean {
  return state.timesSeen === 0;
}

/**
 * The clock lands only where speed is the remaining thing to improve. An
 * explicit speed round overrides this; nothing else does, and there is no mode
 * switch for anyone to think about.
 */
export function timingMode(box: Box): TimingMode {
  return box >= TIMED_FROM_BOX && box !== RETIRED_BOX ? "timed" : "untimed";
}

/** When an item in `box` should next come up, answered at `at`. */
export function nextDueAt(box: Box, at: number): number | null {
  const days = BOX_INTERVAL_DAYS[box];
  return days === null ? null : at + days * DAY_MS;
}

function nextBox(state: ItemState, attempt: AttemptResult): Box {
  if (attempt.correct) {
    if (isFirstExposure(state)) return FAST_TRACK_BOX;
    return Math.min(state.box + 1, RETIRED_BOX) as Box;
  }
  // A timed miss is not evidence of a gap, so it leaves the box alone; the item
  // simply comes round again on its existing interval.
  if (attempt.mode === "timed") return state.box;
  return 1;
}

/** Fold one answer into an item's scheduling state. */
export function applyAttempt(state: ItemState, attempt: AttemptResult): ItemState {
  const box = nextBox(state, attempt);
  return {
    itemId: state.itemId,
    box,
    dueAt: nextDueAt(box, attempt.at),
    timesSeen: state.timesSeen + 1,
    timesCorrect: state.timesCorrect + (attempt.correct ? 1 : 0),
    lastResult: attempt,
  };
}

/** Everything eligible right now, soonest-due first. Retired items never appear. */
export function dueItems(states: readonly ItemState[], now: number): ItemState[] {
  return states
    .filter((s) => isDue(s, now))
    .sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0));
}

/**
 * Put a just-missed item back into the running session, far enough away that
 * answering it is recall rather than echo but near enough to still be learnable.
 * If fewer than `gap` items remain, it goes on the end.
 */
export function requeueMissed(
  queue: readonly string[],
  itemId: string,
  gap: number = SESSION_REINSERT_GAP,
): string[] {
  const at = Math.min(gap, queue.length);
  return [...queue.slice(0, at), itemId, ...queue.slice(at)];
}

/**
 * Unfinished business: items churning in the low boxes. The introduction
 * governor gates on this — see `introductionSlots`.
 */
export function lowBoxCount(states: readonly ItemState[]): number {
  return states.filter((s) => s.box === 1 || s.box === 2).length;
}

/** Counts per box, for the progress readout. */
export function boxCounts(states: readonly ItemState[]): Record<Box, number> {
  const counts: Record<Box, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  for (const s of states) counts[s.box] += 1;
  return counts;
}
