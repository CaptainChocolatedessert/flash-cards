/**
 * Multiplication facts. See DESIGN.md, "Multiplication is exempt from all of this".
 *
 * `a×b` and `b×a` are one fact for scheduling and are presented in both orders.
 * Treating them separately would double the deck for no learning gain, so every
 * fact is normalised to `min×max` before it touches the scheduler.
 */

export const MIN_FACTOR = 1;
export const MAX_FACTOR = 12;

/** A fact in normalised form: `a <= b` always. */
export interface Fact {
  readonly a: number;
  readonly b: number;
  /** Stable key for the scheduler and the progress record, e.g. "3x7". */
  readonly id: string;
}

export function factId(x: number, y: number): string {
  const a = Math.min(x, y);
  const b = Math.max(x, y);
  return `${a}x${b}`;
}

export function normaliseFact(x: number, y: number): Fact {
  return { a: Math.min(x, y), b: Math.max(x, y), id: factId(x, y) };
}

export function parseFactId(id: string): Fact {
  const match = /^(\d+)x(\d+)$/.exec(id);
  if (match === null) throw new Error(`Not a fact id: ${id}`);
  return normaliseFact(Number(match[1]), Number(match[2]));
}

export function product(fact: Fact): number {
  return fact.a * fact.b;
}

/**
 * Every distinct fact in the table, in a stable order.
 *
 * 1 through 12 gives 78 distinct facts from 144 ordered pairs. (DESIGN.md's
 * original 91-of-169 counted 0 through 12; the 0s are not drilled and there is
 * no "0s table" on the chart, so the range starts at 1.)
 */
export function allFacts(min: number = MIN_FACTOR, max: number = MAX_FACTOR): Fact[] {
  const facts: Fact[] = [];
  for (let a = min; a <= max; a += 1) {
    for (let b = a; b <= max; b += 1) {
      facts.push(normaliseFact(a, b));
    }
  }
  return facts;
}

/**
 * The times tables a fact belongs to. 7×8 counts toward both the 7s and the 8s
 * on the chart; a square counts once. Scheduling still sees a single item — this
 * is only for the progress readout.
 */
export function tablesFor(fact: Fact): number[] {
  return fact.a === fact.b ? [fact.a] : [fact.a, fact.b];
}

/** All facts belonging to one times table, including its square. */
export function factsInTable(table: number, min: number = MIN_FACTOR, max: number = MAX_FACTOR): Fact[] {
  return allFacts(min, max).filter((f) => tablesFor(f).includes(table));
}

/**
 * Which band a first-exposure result should be credited to.
 *
 * A fact spans two tables, and the estimator takes one band per event. Credit
 * the harder of the two — the larger factor — since that is the one the child
 * was actually up against. 7×8 informs the 8s.
 */
export function bandForFact(fact: Fact): string {
  return String(fact.b);
}

/** How a fact is shown. Presented in both orders; the scheduler never sees the difference. */
export interface Presentation {
  readonly left: number;
  readonly right: number;
}

export function present(fact: Fact, swap: boolean): Presentation {
  return swap ? { left: fact.b, right: fact.a } : { left: fact.a, right: fact.b };
}
