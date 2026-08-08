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

/** How a word gets said. `speak` resolves when the word has finished being said. */
export interface Speaker {
  /** False when this device cannot speak at all, which the game has to handle rather than hang on. */
  readonly available: boolean;
  speak(word: string): Promise<void>;
  /** Stop anything in progress. Called when leaving a question, so a stale word cannot arrive late. */
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
