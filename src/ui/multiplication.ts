/**
 * The multiplication game screen.
 *
 * Thin on purpose. It shows the question the engine hands it, collects what was
 * typed along with the keystroke timeline, and hands back a result — every
 * decision about what to ask, what a miss does and when to stop belongs to the
 * engine, which is testable without a browser. Anything clever appearing in this
 * file is in the wrong place.
 */

import { boxCounts } from "../core/index.js";
import type { Box } from "../core/index.js";
import {
  advance,
  correctAnswer,
  endSession,
  factPrompt,
  isCorrect,
  multiplicationDeck,
  multiplicationProficiencyModel,
  startSession,
  submit,
} from "../game/index.js";
import type { Session, SessionConfig, SessionOutcome } from "../game/index.js";
import { markPlayed, withSubject } from "../storage/index.js";
import type { Keystroke, ProgressRecord, ProgressStore } from "../storage/index.js";

export interface MultiplicationScreenOptions {
  readonly store: ProgressStore;
  readonly root: HTMLElement;
  readonly record: ProgressRecord;
  readonly onExit: () => void;
}

/**
 * How long a newly drawn screen ignores Enter.
 *
 * Not a cosmetic delay — it is what stops one physical keypress from doing two
 * things. A keystroke handled on an element is still propagating to the document
 * while the next screen is being built, so a listener attached during that
 * handler receives the same keystroke; key repeat has the same effect a moment
 * later. Long enough to swallow both, short enough that nobody typing at speed
 * ever notices it.
 */
const SETTLE_MS = 400;

type Phase = "asking" | "feedback" | "over";

/**
 * What the feedback card shows. Held separately from the engine's state because
 * submitting an answer clears the current question — by the time this is on
 * screen, the question it describes is already answered and gone.
 */
interface AnswerFeedback {
  readonly correct: boolean;
  readonly expected: number;
  readonly typed: string;
  /** The fact as it was shown, so the answer has something to attach to. */
  readonly prompt: string;
}

export class MultiplicationScreen {
  readonly #store: ProgressStore;
  readonly #root: HTMLElement;
  readonly #onExit: () => void;
  readonly #config: SessionConfig;

  #record: ProgressRecord;
  #session: Session;
  #phase: Phase = "asking";
  #lastAnswer: AnswerFeedback | null = null;

  /** When the current question went on screen, and what has been typed since. */
  #shownAt = 0;
  #keystrokes: Keystroke[] = [];
  #clock: number | null = null;
  /** Tears down the "press Enter to carry on" listener. One at a time, always. */
  #continueKey: AbortController | null = null;
  #ended = false;
  /** True when the engine ran out of material, false when the child chose to stop. */
  #ranOut = false;
  /** Set once the session is closed. The summary reads this, not the live counters. */
  #outcome: SessionOutcome | null = null;

  constructor({ store, root, record, onExit }: MultiplicationScreenOptions) {
    this.#store = store;
    this.#root = root;
    this.#record = record;
    this.#onExit = onExit;
    this.#config = {
      deck: multiplicationDeck(),
      model: multiplicationProficiencyModel(),
      // Not seeded: a real session wants genuinely varied presentation order.
      // The engine takes the source as an argument precisely so tests can pin it.
      rng: Math.random,
    };
    this.#session = startSession(record.subjects.multiplication, Date.now());
  }

  start(): void {
    this.#next();
  }

  /** Stop the clock. Called before leaving, so a stray timer cannot outlive the screen. */
  #stopClock(): void {
    if (this.#clock !== null) {
      clearInterval(this.#clock);
      this.#clock = null;
    }
  }

  /** Stop listening for the carry-on key. Idempotent, and safe to call when nothing is listening. */
  #stopContinueKey(): void {
    this.#continueKey?.abort();
    this.#continueKey = null;
  }

  #next(): void {
    this.#stopContinueKey();
    this.#session = advance(this.#session, this.#config, Date.now());
    if (this.#session.current === null) {
      // Ran out of material — everything due is done and the governor will not
      // let more in. That is a finished session and has to be closed like one,
      // or it leaves no summary behind.
      this.#ranOut = true;
      void this.#conclude();
      return;
    }
    this.#phase = "asking";
    this.#lastAnswer = null;
    this.#render();
  }

  // -------------------------------------------------------------------------
  // Answering
  // -------------------------------------------------------------------------

  async #answer(typed: string): Promise<void> {
    const question = this.#session.current;
    if (question === null || this.#phase !== "asking") return;

    // The same guard from the other direction: an empty box submitted the
    // instant the question appears is a stray repeat from the keystroke that
    // dismissed the last answer, not a considered "I don't know". A deliberate
    // blank — sat and thought about it, no idea — still goes through, and still
    // counts as a miss, which is honest and is what teaches the fact.
    if (typed.trim() === "" && Date.now() - this.#shownAt < SETTLE_MS) return;

    this.#stopClock();
    const now = Date.now();
    const correct = isCorrect(question.itemId, typed);

    this.#session = submit(
      this.#session,
      this.#config,
      {
        correct,
        answer: typed,
        elapsedMs: now - this.#shownAt,
        keystrokes: this.#keystrokes,
      },
      now,
    );

    this.#lastAnswer = {
      correct,
      expected: correctAnswer(question.itemId),
      typed,
      prompt: factPrompt(question.itemId, question.presentationRoll),
    };
    this.#phase = "feedback";
    this.#render();

    await this.#persist(now);

    // A right answer moves on by itself; a wrong one waits, so the correct
    // product is on screen long enough to actually be read.
    if (correct) setTimeout(() => this.#next(), 550);
  }

  /**
   * Write the record after every answer.
   *
   * More often than strictly needed, and deliberately: children close tabs. The
   * record is a few kilobytes and the write is off the critical path, so the
   * cost is invisible and the alternative is losing a session to a stray click.
   */
  async #persist(now: number): Promise<void> {
    this.#record = markPlayed(
      withSubject(this.#record, "multiplication", this.#session.progress),
      now,
    );
    try {
      await this.#store.save(this.#record, now);
    } catch (error) {
      this.#showError(error);
    }
  }

  /**
   * Close the session and show what it came to.
   *
   * Both ways out land here — the Stop button and running out of material —
   * because they are the same event as far as the record is concerned, and a
   * session that ends without writing its summary is one the trend lines will
   * never know happened.
   *
   * Guarded so it cannot run twice: `endSession` appends a summary, and a second
   * call would append a second one for a session that happened once.
   */
  async #conclude(): Promise<void> {
    this.#stopClock();
    this.#stopContinueKey();
    if (this.#ended) {
      this.#phase = "over";
      this.#render();
      return;
    }
    this.#ended = true;

    const now = Date.now();
    const outcome = endSession(this.#session, now);
    this.#outcome = outcome;
    this.#session = { ...this.#session, progress: outcome.progress, current: null };
    this.#record = markPlayed(withSubject(this.#record, "multiplication", outcome.progress), now);
    this.#phase = "over";
    this.#render();

    try {
      await this.#store.save(this.#record, now);
    } catch (error) {
      this.#showError(error);
    }
  }

  #showError(error: unknown): void {
    const box = this.#root.querySelector<HTMLElement>(".message");
    if (box === null) return;
    box.dataset["tone"] = "error";
    box.textContent = `Could not save progress: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  #render(): void {
    this.#root.replaceChildren();
    this.#root.append(this.#header());

    if (this.#phase === "over") this.#root.append(this.#summary());
    else if (this.#phase === "feedback") this.#root.append(this.#feedbackCard());
    else this.#root.append(this.#questionCard());

    const message = document.createElement("p");
    message.className = "message";
    this.#root.append(message);
  }

  #header(): HTMLElement {
    const header = document.createElement("header");
    header.className = "game-header";

    const who = document.createElement("div");
    who.textContent = `${this.#record.profile.name} · times tables`;
    who.className = "game-who";

    const score = document.createElement("div");
    score.className = "game-score";
    score.textContent =
      this.#session.asked === 0
        ? "just starting"
        : `${this.#session.correct} of ${this.#session.asked} right`;

    const stop = document.createElement("button");
    stop.type = "button";
    const over = this.#phase === "over";
    stop.textContent = over ? "Back" : "Stop";
    stop.addEventListener("click", () => {
      if (over) this.#onExit();
      else void this.#conclude();
    });

    header.append(who, score, stop);
    return header;
  }

  #questionCard(): HTMLElement {
    const question = this.#session.current;
    const card = document.createElement("section");
    card.className = "card";
    if (question === null) return card;

    const prompt = document.createElement("p");
    prompt.className = "prompt";
    prompt.textContent = `${factPrompt(question.itemId, question.presentationRoll)} =`;
    card.append(prompt);

    const form = document.createElement("form");
    const input = document.createElement("input");
    input.type = "text";
    input.inputMode = "numeric";
    input.autocomplete = "off";
    input.className = "answer";
    input.setAttribute("aria-label", "Answer");

    this.#shownAt = Date.now();
    this.#keystrokes = [];
    input.addEventListener("keydown", (event) => {
      // Every keydown, corrections included. Nothing interprets these yet —
      // they are recorded because they cannot be recovered later if they are not.
      this.#keystrokes.push({ t: Date.now() - this.#shownAt, key: event.key });

      // Submit on Enter explicitly rather than leaning on the form's implicit
      // submission. Enter is how this game is actually played — a child types a
      // number and hits return, hundreds of times a session — and implicit
      // submission is exactly the sort of browser default that quietly does not
      // fire in some contexts. Not worth being clever about.
      if (event.key === "Enter") {
        event.preventDefault();
        void this.#answer(input.value);
      }
    });

    const go = document.createElement("button");
    go.type = "submit";
    go.textContent = "Enter";

    form.append(input, go);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.#answer(input.value);
    });
    card.append(form);

    // The clock appears only where speed is the thing left to improve. In
    // untimed mode there is no clock at all — not a hidden one, not a score
    // against time.
    if (question.mode === "timed") card.append(this.#clockElement());

    setTimeout(() => input.focus(), 0);
    return card;
  }

  #clockElement(): HTMLElement {
    const clock = document.createElement("p");
    clock.className = "clock";
    clock.textContent = "0.0s";
    this.#stopClock();
    this.#clock = window.setInterval(() => {
      clock.textContent = `${((Date.now() - this.#shownAt) / 1000).toFixed(1)}s`;
    }, 100);
    return clock;
  }

  /** Shown between questions. Keeps the fact on screen so the answer has something to attach to. */
  #feedbackCard(): HTMLElement {
    const card = document.createElement("section");
    card.className = "card";
    const result = this.#lastAnswer;
    if (result === null) return card;

    const prompt = document.createElement("p");
    prompt.className = "prompt";
    prompt.textContent = `${result.prompt} =`;
    card.append(prompt, this.#feedback(result));
    return card;
  }

  #feedback(result: AnswerFeedback): HTMLElement {
    const box = document.createElement("div");
    box.className = "feedback";

    if (result.correct) {
      box.dataset["tone"] = "right";
      box.append(text("p", `${result.expected} — yes`));
      return box;
    }

    box.dataset["tone"] = "wrong";
    box.append(text("p", `${result.expected}`));
    box.append(
      text(
        "p",
        result.typed.trim() === ""
          ? "You left it blank. It will come round again."
          : `You said ${result.typed.trim()}. It will come round again.`,
      ),
    );

    const go = document.createElement("button");
    go.type = "button";
    go.textContent = "Next";
    go.addEventListener("click", () => this.#next());
    box.append(go);
    setTimeout(() => go.focus(), 0);

    // Enter carries on, from anywhere on the page rather than only from the
    // focused button. The child has just typed an answer and their hands are
    // still on the keyboard; making them find the mouse, or depend on where
    // focus happens to be, would break the rhythm of the whole session.
    this.#stopContinueKey();
    this.#continueKey = new AbortController();
    const shownAt = Date.now();
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Enter") return;
        // Ignore anything that arrives too soon to have been a response to what
        // is on screen. Two things land in that window and both would skip the
        // answer the child is supposed to be reading:
        //
        //  - the very keystroke that submitted the answer. This listener is
        //    attached while that keydown is still travelling up to the document,
        //    so it is delivered here as well.
        //  - key repeat, from a child holding Enter down.
        if (Date.now() - shownAt < SETTLE_MS) return;
        event.preventDefault();
        this.#next();
      },
      { signal: this.#continueKey.signal },
    );

    return box;
  }

  #summary(): HTMLElement {
    const section = document.createElement("section");
    section.className = "card";

    const outcome = this.#outcome;
    if (outcome === null || outcome.asked === 0) {
      if (this.#ranOut) {
        section.append(text("h2", "Nothing to practise right now"));
        section.append(
          text(
            "p",
            "Everything is either already learned or not due yet. Come back tomorrow and there will be more.",
          ),
        );
      } else {
        section.append(text("h2", "Stopped"));
        section.append(text("p", "No questions answered, so nothing has changed."));
      }
      return section;
    }

    section.append(text("h2", "Session done"));
    section.append(
      text(
        "p",
        `${outcome.correct} right out of ${outcome.asked}` +
          (outcome.introduced > 0
            ? `, and ${outcome.introduced} new fact${outcome.introduced === 1 ? "" : "s"} met.`
            : "."),
      ),
    );

    const counts = boxCounts(Object.values(outcome.progress.items));
    const list = document.createElement("ul");
    list.className = "boxes";
    const labels: Record<Box, string> = {
      1: "just learning",
      2: "back tomorrow",
      3: "back in 3 days",
      4: "back in a week",
      5: "back in 3 weeks",
      6: "known",
    };
    for (const box of [1, 2, 3, 4, 5, 6] as Box[]) {
      const row = document.createElement("li");
      row.textContent = `${counts[box]} ${labels[box]}`;
      list.append(row);
    }
    section.append(text("h3", "Where the facts are"), list);
    return section;
  }
}

function text(tag: string, content: string): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = content;
  return node;
}
