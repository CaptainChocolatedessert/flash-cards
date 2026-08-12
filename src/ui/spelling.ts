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
import { celebration, emojiEnabled, emojiToggle, randomEmoji } from "./celebrate.js";
import { SETTLE_MS, continueControl } from "./continue.js";
import { markPlayed, withSubject } from "../storage/index.js";
import type { Keystroke, ProgressRecord, ProgressStore } from "../storage/index.js";

export interface SpellingScreenOptions {
  readonly store: ProgressStore;
  readonly root: HTMLElement;
  readonly record: ProgressRecord;
  readonly speaker: Speaker;
  readonly onExit: () => void;
  /**
   * Which recording this word will be said with, or null when it will be
   * synthesised.
   *
   * The screen needs this for one reason only: the "I can't understand it"
   * button has nothing to reject when a word is being synthesised, so it should
   * not be offered. The `Speaker` itself stays narrow — the game still does not
   * learn *how* a word is being said in order to say it.
   */
  readonly sourceFor?: (word: string) => string | null;
  /** Remember that a recording was unintelligible. Shared across both children. */
  readonly onBlockRecording?: (id: string) => Promise<void>;
}

type Phase = "asking" | "feedback" | "over";

interface AnswerFeedback {
  readonly correct: boolean;
  readonly expected: string;
  readonly typed: string;
  /** Chosen when the answer was judged, so a re-render cannot reshuffle it. */
  readonly emoji: string | null;
}

export class SpellingScreen {
  readonly #store: ProgressStore;
  readonly #root: HTMLElement;
  readonly #speaker: Speaker;
  readonly #onExit: () => void;
  readonly #config: SessionConfig;
  readonly #sourceFor: (word: string) => string | null;
  readonly #onBlockRecording: (id: string) => Promise<void>;

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
  /** So the same silly picture never turns up twice running. */
  #lastEmoji: string | null = null;

  constructor({
    store,
    root,
    record,
    speaker,
    onExit,
    sourceFor,
    onBlockRecording,
  }: SpellingScreenOptions) {
    this.#store = store;
    this.#root = root;
    this.#record = record;
    this.#speaker = speaker;
    this.#onExit = onExit;
    // Defaults that say "no recordings here". The screen is then exactly what it
    // was before recordings existed, which is what the tests run against.
    this.#sourceFor = sourceFor ?? ((): null => null);
    this.#onBlockRecording = onBlockRecording ?? ((): Promise<void> => Promise.resolve());
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

    const emoji =
      correct && emojiEnabled(this.#record.profile.id)
        ? randomEmoji(Math.random, this.#lastEmoji ?? undefined)
        : null;
    if (emoji !== null) this.#lastEmoji = emoji;

    this.#lastAnswer = { correct, expected: question.itemId, typed, emoji };
    this.#phase = "feedback";
    this.#render();

    await this.#persist(now);
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

    header.append(who, score, emojiToggle(this.#record.profile.id, () => undefined), stop);
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

    const asked = question.itemId;
    card.append(
      text("p", "Listen, then type the word."),
      // Focus goes back to the box *before* the repeat starts, not after it
      // ends — the same mistake as above. Clicking the button moves focus to
      // it, and a child listening to the repeat is typing the moment they
      // recognise the word, not once the voice has stopped.
      this.#prompt(asked, () => {
        input.focus();
        void this.#speaker.speak(asked);
      }),
      form,
    );

    if (question.mode === "timed") card.append(text("p", "Quick as you can."));

    this.#shownAt = Date.now();
    this.#keystrokes = [];

    // Focus immediately, not when the word finishes.
    //
    // This is the whole bug: a child who starts typing on the first syllable was
    // typing into nothing, because focus only arrived with the `end` event.
    // Nobody waits politely for a synthesiser to finish before spelling a word
    // they already recognised.
    setTimeout(() => input.focus(), 0);

    void this.#speaker.speak(asked).then(() => {
      // Answering early cancels the speech, which resolves this late; without
      // the guard it would act on whatever question is on screen by then.
      if (this.#phase !== "asking" || this.#session.current?.itemId !== asked) return;
      input.focus();

      // Start the clock when the word finishes — but only if they have not
      // already started. Timing from the word's *start* would fold the
      // synthesiser's rate into the child's typing speed, and a slower voice
      // would read as a slower typist; rebasing on someone already mid-word
      // would credit them with the letters they typed before the clock existed.
      if (this.#keystrokes.length === 0) this.#shownAt = Date.now();
    });

    return card;
  }

  /** The speaker button. The word is never shown — that is the whole game. */
  #prompt(word: string, onRepeat: () => void): HTMLElement {
    const row = document.createElement("div");
    row.className = "say-row";
    const again = document.createElement("button");
    again.type = "button";
    again.className = "say-again";
    again.textContent = "🔊 Say it again";
    // Not a submit button, and not inside the form: Enter must always mean
    // "answer", never "say it again", however focus happens to be sitting.
    again.addEventListener("click", onRepeat);
    row.append(again);

    const reject = this.#rejectButton(word, onRepeat);
    if (reject !== null) row.append(reject);
    return row;
  }

  /**
   * "I can't understand it" — reject this recording and hear another.
   *
   * The recordings are volunteer-made and some of them are duds; without an
   * escape hatch a single bad file makes a word permanently unanswerable. See
   * DESIGN.md, "'I can't understand it' — the blacklist".
   *
   * Only offered when a *recording* is playing. A synthesised word has nothing
   * to reject, and a button that visibly does nothing is worse than no button.
   */
  #rejectButton(word: string, onRepeat: () => void): HTMLButtonElement | null {
    if (this.#sourceFor(word) === null) return null;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "say-reject";
    button.textContent = "🤔 I can't understand it";

    button.addEventListener("click", () => {
      const id = this.#sourceFor(word);
      if (id === null) return;
      void this.#onBlockRecording(id).then(() => {
        // Deliberately no re-render: redrawing the screen restarts the question,
        // which would say the word from the top and reset the state around it.
        // The button removes itself when the last recording is gone, and the
        // repeat handler already hands focus back to the answer box.
        if (this.#sourceFor(word) === null) button.remove();
        onRepeat();
      });
    });

    return button;
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
      // Below the word, not above it: the spelling is what they came for, and a
      // big picture landing on top of it pushes the answer off where they were
      // looking.
      if (result.emoji !== null) box.append(celebration(result.emoji));
      box.append(this.#continue());
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
    box.append(this.#continue());

    card.append(box);
    return card;
  }

  /** The control that ends a feedback card — the same one whatever the answer was. */
  #continue(): HTMLElement {
    this.#stopContinueKey();
    const { button, keys } = continueControl(() => this.#next());
    this.#continueKey = keys;
    return button;
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
