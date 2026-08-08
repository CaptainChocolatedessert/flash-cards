/**
 * The spelling game screen.
 *
 * The same session engine as multiplication, with a different deck and one extra
 * thing to do: say the word. Everything about *what* to ask stays in the engine
 * — see `src/game/session.ts` — so this file is the word being spoken, the box
 * to type in, and the timing of the two.
 */

import { boxCounts } from "../core/index.js";
import type { Box } from "../core/index.js";
import { askableWords, spellingDeck, spellingProficiencyModel } from "../content/words.js";
import {
  advance,
  endSession,
  startSession,
  submit,
  typingSpeed,
} from "../game/index.js";
import type { Session, SessionConfig, SessionOutcome } from "../game/index.js";
import type { Speaker } from "../audio/speech.js";
import { markPlayed, withSubject } from "../storage/index.js";
import type { Keystroke, ProgressRecord, ProgressStore } from "../storage/index.js";

export interface SpellingScreenOptions {
  readonly store: ProgressStore;
  readonly root: HTMLElement;
  readonly record: ProgressRecord;
  readonly speaker: Speaker;
  readonly onExit: () => void;
}

/** See the multiplication screen: a newly drawn screen ignores Enter for a moment. */
const SETTLE_MS = 400;

type Phase = "asking" | "feedback" | "over";

interface AnswerFeedback {
  readonly correct: boolean;
  readonly expected: string;
  readonly typed: string;
}

export class SpellingScreen {
  readonly #store: ProgressStore;
  readonly #root: HTMLElement;
  readonly #speaker: Speaker;
  readonly #onExit: () => void;
  readonly #config: SessionConfig;

  #record: ProgressRecord;
  #session: Session;
  #phase: Phase = "asking";
  #lastAnswer: AnswerFeedback | null = null;
  #outcome: SessionOutcome | null = null;

  #shownAt = 0;
  #keystrokes: Keystroke[] = [];
  #continueKey: AbortController | null = null;
  #ended = false;
  #ranOut = false;

  constructor({ store, root, record, speaker, onExit }: SpellingScreenOptions) {
    this.#store = store;
    this.#root = root;
    this.#record = record;
    this.#speaker = speaker;
    this.#onExit = onExit;
    this.#config = {
      deck: spellingDeck(),
      model: spellingProficiencyModel(),
      rng: Math.random,
      tracksTyping: true,
    };
    this.#session = startSession(record.subjects.spelling, Date.now());
  }

  start(): void {
    this.#next();
  }

  #stopContinueKey(): void {
    this.#continueKey?.abort();
    this.#continueKey = null;
  }

  #next(): void {
    this.#stopContinueKey();
    this.#session = advance(this.#session, this.#config, Date.now());
    if (this.#session.current === null) {
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

  /**
   * Spelling is judged on the letters, not on presentation. Case and surrounding
   * space are forgiven; everything else is not. Marking a child wrong for a
   * missing capital would teach nothing about spelling.
   */
  #isCorrect(word: string, typed: string): boolean {
    return typed.trim().toLowerCase() === word.toLowerCase();
  }

  async #answer(typed: string): Promise<void> {
    const question = this.#session.current;
    if (question === null || this.#phase !== "asking") return;
    if (typed.trim() === "" && Date.now() - this.#shownAt < SETTLE_MS) return;

    this.#speaker.cancel();
    const now = Date.now();
    const correct = this.#isCorrect(question.itemId, typed);

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

    this.#lastAnswer = { correct, expected: question.itemId, typed };
    this.#phase = "feedback";
    this.#render();

    await this.#persist(now);
    if (correct) setTimeout(() => this.#next(), 700);
  }

  async #persist(now: number): Promise<void> {
    this.#record = markPlayed(withSubject(this.#record, "spelling", this.#session.progress), now);
    try {
      await this.#store.save(this.#record, now);
    } catch (error) {
      this.#showError(error);
    }
  }

  async #conclude(): Promise<void> {
    this.#speaker.cancel();
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
    this.#record = markPlayed(withSubject(this.#record, "spelling", outcome.progress), now);
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

    if (!this.#speaker.available && this.#phase !== "over") {
      this.#root.append(this.#noVoice());
    } else if (this.#phase === "over") {
      this.#root.append(this.#summary());
    } else if (this.#phase === "feedback") {
      this.#root.append(this.#feedbackCard());
    } else {
      this.#root.append(this.#questionCard());
    }

    const message = document.createElement("p");
    message.className = "message";
    this.#root.append(message);
  }

  #header(): HTMLElement {
    const header = document.createElement("header");
    header.className = "game-header";

    const who = document.createElement("div");
    who.textContent = `${this.#record.profile.name} · spelling`;
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

  /** No synthesiser and no recordings yet means no spelling game. Say so plainly. */
  #noVoice(): HTMLElement {
    const card = document.createElement("section");
    card.className = "card";
    card.append(text("h2", "This browser cannot say the words"));
    card.append(
      text(
        "p",
        "The spelling game reads each word aloud, and this browser has no speech built in. Try Chrome or Edge. Times tables still work.",
      ),
    );
    return card;
  }

  #questionCard(): HTMLElement {
    const question = this.#session.current;
    const card = document.createElement("section");
    card.className = "card";
    if (question === null) return card;

    card.append(text("p", "Listen, then type the word."), this.#prompt());

    const form = document.createElement("form");
    const input = document.createElement("input");
    input.type = "text";
    input.autocomplete = "off";
    input.autocapitalize = "off";
    input.spellcheck = false;
    input.className = "answer answer-word";
    input.setAttribute("aria-label", "Type the word you heard");

    this.#keystrokes = [];
    input.addEventListener("keydown", (event) => {
      this.#keystrokes.push({ t: Date.now() - this.#shownAt, key: event.key });
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

    if (question.mode === "timed") card.append(text("p", "Quick as you can."));

    // Say the word, then start the clock. Timing from when the word *starts*
    // would fold the synthesiser's speaking rate into the child's typing speed,
    // and a slower voice would look like a slower typist.
    //
    // The guard matters: answering before the word finishes cancels it, which
    // resolves this promise late. Without the check it would reset the clock and
    // wipe the keystrokes of whichever question happened to be on screen by then.
    this.#shownAt = Date.now();
    const asked = question.itemId;
    void this.#speaker.speak(asked).then(() => {
      if (this.#phase !== "asking" || this.#session.current?.itemId !== asked) return;
      this.#shownAt = Date.now();
      this.#keystrokes = [];
      input.focus();
    });

    return card;
  }

  /** The speaker button. The word is never shown — that is the whole game. */
  #prompt(): HTMLElement {
    const row = document.createElement("div");
    row.className = "say-row";
    const again = document.createElement("button");
    again.type = "button";
    again.className = "say-again";
    again.textContent = "🔊 Say it again";
    again.addEventListener("click", () => {
      const question = this.#session.current;
      if (question !== null) void this.#speaker.speak(question.itemId);
    });
    row.append(again);
    return row;
  }

  #feedbackCard(): HTMLElement {
    const card = document.createElement("section");
    card.className = "card";
    const result = this.#lastAnswer;
    if (result === null) return card;

    const box = document.createElement("div");
    box.className = "feedback";

    if (result.correct) {
      box.dataset["tone"] = "right";
      box.append(text("p", result.expected));
      card.append(box);
      return card;
    }

    box.dataset["tone"] = "wrong";
    box.append(text("p", result.expected));
    box.append(
      text(
        "p",
        result.typed.trim() === ""
          ? "You left it blank. It will come round again."
          : `You wrote ${result.typed.trim()}. It will come round again.`,
      ),
    );

    const go = document.createElement("button");
    go.type = "button";
    go.textContent = "Next";
    go.addEventListener("click", () => this.#next());
    box.append(go);
    setTimeout(() => go.focus(), 0);

    this.#stopContinueKey();
    this.#continueKey = new AbortController();
    const shownAt = Date.now();
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Enter") return;
        if (Date.now() - shownAt < SETTLE_MS) return;
        event.preventDefault();
        this.#next();
      },
      { signal: this.#continueKey.signal },
    );

    card.append(box);
    return card;
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
        section.append(text("p", "No words answered, so nothing has changed."));
      }
      return section;
    }

    section.append(text("h2", "Session done"));
    section.append(
      text(
        "p",
        `${outcome.correct} right out of ${outcome.asked}` +
          (outcome.introduced > 0
            ? `, and ${outcome.introduced} new word${outcome.introduced === 1 ? "" : "s"} met.`
            : "."),
      ),
    );

    const summary = outcome.progress.sessions.at(-1);
    const cpm = summary ? typingSpeed(summary.correctChars, summary.typingMs) : null;
    if (cpm !== null) {
      section.append(text("p", `Typing: ${Math.round(cpm)} correct letters a minute.`));
    }

    const counts = boxCounts(Object.values(outcome.progress.items));
    const labels: Record<Box, string> = {
      1: "just learning",
      2: "back tomorrow",
      3: "back in 3 days",
      4: "back in a week",
      5: "back in 3 weeks",
      6: "known",
    };
    const list = document.createElement("ul");
    list.className = "boxes";
    for (const box of [1, 2, 3, 4, 5, 6] as Box[]) {
      const row = document.createElement("li");
      row.textContent = `${counts[box]} ${labels[box]}`;
      list.append(row);
    }
    section.append(text("h3", "Where the words are"), list);

    const met = Object.keys(outcome.progress.items).length;
    const total = text("p", `${met} of ${askableWords().length} words met so far.`);
    total.className = "note";
    section.append(total);
    return section;
  }
}

function text(tag: string, content: string): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = content;
  return node;
}
