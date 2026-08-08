/**
 * Saying a word out loud.
 *
 * One narrow interface, for the same reason `ProgressStore` is one narrow
 * interface: today the browser's built-in synthesiser says the word, and later a
 * fetched human recording will, with speech synthesis remaining the fallback for
 * words no recording exists for. The game must not learn which it is talking to.
 * See DESIGN.md, "Audio".
 *
 * Synthesis is deliberately first. It needs no corpus, no build step and no
 * licensing research, so the spelling game becomes playable now and the
 * recordings become an upgrade rather than a prerequisite.
 */

/**
 * How a word gets said.
 *
 * `speak` resolves **once the word has been said and the child could begin** —
 * not necessarily when all sound has stopped. A speaker that repeats the word
 * for clarity keeps going after resolving, because making the caller wait for
 * reinforcement it did not ask for would delay the timing clock behind sound the
 * child stopped needing after the first pass.
 */
export interface Speaker {
  /** False when this device cannot speak at all, which the game has to handle rather than hang on. */
  readonly available: boolean;
  speak(word: string): Promise<void>;
  /** Stop anything in progress, including repeats still to come. */
  cancel(): void;
}

/**
 * Slower than conversational.
 *
 * A child is not listening for meaning, they are listening for the sounds they
 * have to write down, and the default rate runs the syllables together. Slower
 * still starts to distort the vowels, which is worse than fast.
 */
const RATE = 0.85;

/**
 * Give up waiting for the synthesiser after this long and carry on.
 *
 * `onend` is not reliably delivered — a cancelled or failed utterance can
 * silently never fire — and a question that waits forever for a word that will
 * never arrive is a hung game. The timeout only releases the *waiting*; if the
 * word does arrive late it is still heard.
 */
const SPEAK_TIMEOUT_MS = 8000;

function isEnglish(voice: SpeechSynthesisVoice): boolean {
  return voice.lang.toLowerCase().startsWith("en");
}

/**
 * Pick a voice: English, and preferring one that lives on the device.
 *
 * A local voice keeps working with no network, which matters because the whole
 * app is meant to run offline once installed — a remote voice would make the
 * spelling game the one part that silently stops working on a plane.
 */
export function chooseVoice(voices: readonly SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  const english = voices.filter(isEnglish);
  if (english.length === 0) return null;
  const score = (v: SpeechSynthesisVoice): number =>
    (v.localService ? 2 : 0) + (v.lang.toLowerCase() === "en-us" ? 1 : 0);
  return [...english].sort((a, b) => score(b) - score(a))[0] ?? null;
}

export class BrowserSpeaker implements Speaker {
  readonly available: boolean;
  #voice: SpeechSynthesisVoice | null = null;

  constructor() {
    this.available =
      typeof globalThis.speechSynthesis !== "undefined" &&
      typeof globalThis.SpeechSynthesisUtterance !== "undefined";
    if (this.available) this.#watchVoices();
  }

  /**
   * Voices arrive asynchronously and `getVoices()` is empty on the first call in
   * most browsers. Listening for `voiceschanged` as well as reading once covers
   * both the browsers that populate immediately and those that do not.
   */
  #watchVoices(): void {
    const load = (): void => {
      this.#voice = chooseVoice(speechSynthesis.getVoices());
    };
    load();
    speechSynthesis.addEventListener("voiceschanged", load);
  }

  speak(word: string): Promise<void> {
    if (!this.available) return Promise.resolve();

    // Anything still speaking is stale by definition — the game only ever wants
    // the current word — and without this the utterances queue up and play in a
    // row after the child has moved on.
    speechSynthesis.cancel();

    return new Promise<void>((resolve) => {
      const utterance = new SpeechSynthesisUtterance(word);
      utterance.rate = RATE;
      if (this.#voice !== null) {
        utterance.voice = this.#voice;
        utterance.lang = this.#voice.lang;
      }

      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, SPEAK_TIMEOUT_MS);

      utterance.addEventListener("end", finish);
      utterance.addEventListener("error", finish);
      speechSynthesis.speak(utterance);
    });
  }

  cancel(): void {
    if (this.available) speechSynthesis.cancel();
  }
}

/**
 * How many times a word is said.
 *
 * Three, because a short word is over almost before it registers — a synthesised
 * "cut" gives a child perhaps a third of a second of signal, and asking them to
 * spell what they only half heard tests their hearing rather than their
 * spelling. Long words do not need it and get it anyway; the cost is a few
 * seconds of sound they can type straight through, which is cheaper than a
 * rule that has to decide what counts as short.
 */
export const SAY_TIMES = 3;

/**
 * The gap between repeats.
 *
 * Long enough that the repeats are heard as separate sayings rather than a
 * stutter, short enough not to feel like waiting. Reduce it and the word runs
 * into itself; lengthen it and the child sits through silence.
 */
export const SAY_GAP_MS = 700;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Says a word several times over, whatever the underlying speaker is.
 *
 * A wrapper rather than something baked into `BrowserSpeaker`, because the
 * problem it solves is not a synthesis problem: a short *recording* of "cut" is
 * just as easy to miss, so the repetition should survive the arrival of human
 * recordings rather than having to be written again.
 *
 * It resolves after the **first** saying and keeps going in the background. That
 * is what lets the timing clock start when the child could actually begin,
 * rather than trailing several seconds of reinforcement they may not have
 * needed.
 */
export class RepeatingSpeaker implements Speaker {
  readonly #inner: Speaker;
  readonly #times: number;
  readonly #gapMs: number;
  /** Bumped on every new word and on cancel, so an in-flight sequence knows it is stale. */
  #run = 0;

  constructor(inner: Speaker, times: number = SAY_TIMES, gapMs: number = SAY_GAP_MS) {
    this.#inner = inner;
    this.#times = times;
    this.#gapMs = gapMs;
  }

  get available(): boolean {
    return this.#inner.available;
  }

  async speak(word: string): Promise<void> {
    const run = ++this.#run;
    await this.#inner.speak(word);
    if (run !== this.#run) return;
    void this.#repeat(word, run);
  }

  async #repeat(word: string, run: number): Promise<void> {
    for (let said = 1; said < this.#times; said += 1) {
      await delay(this.#gapMs);
      // A new word, or a cancel, retires this sequence. Without the check a
      // stale repeat would talk over the next question.
      if (run !== this.#run) return;
      await this.#inner.speak(word);
      if (run !== this.#run) return;
    }
  }

  cancel(): void {
    this.#run += 1;
    this.#inner.cancel();
  }
}

/** A speaker that says nothing, for tests and for devices with no synthesiser. */
export class SilentSpeaker implements Speaker {
  readonly available = false;
  spoken: string[] = [];

  speak(word: string): Promise<void> {
    this.spoken.push(word);
    return Promise.resolve();
  }

  cancel(): void {
    // Nothing to stop.
  }
}
