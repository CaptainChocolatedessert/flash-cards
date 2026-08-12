/**
 * The shell: which screen is on, and nothing else.
 *
 * No router and no history handling. There are two screens, the game is a
 * modal thing a child enters and leaves, and a back button that dropped them out
 * of a half-finished session would be a bug rather than a feature. If the app
 * ever grows a third screen worth linking to, this is where that decision goes.
 */

import { newSharedState } from "../storage/index.js";
import type { ProgressStore, SharedState, SubjectId } from "../storage/index.js";
import { BrowserSpeaker, RepeatingSpeaker } from "../audio/speech.js";
import type { Speaker } from "../audio/speech.js";
import { SpokenWords } from "../audio/recordings.js";
import { CreditsScreen } from "./credits.js";
import { MultiplicationScreen } from "./multiplication.js";
import { ProfileScreen } from "./profiles.js";
import { SpellingScreen } from "./spelling.js";

export class App {
  readonly #store: ProgressStore;
  readonly #root: HTMLElement;

  /**
   * Recordings a child could not understand, shared across both children.
   *
   * Held here rather than in either game because it is not one child's progress
   * — a bad recording is bad for both — and because the speaker has to consult
   * it on every single word. Kept as a live `Set` the speaker reads through a
   * closure, so blocking one takes effect on the very next word said.
   */
  #shared: SharedState = newSharedState();
  #blocked = new Set<string>();

  /**
   * One speaker for the whole app, built once. Voices load asynchronously, so a
   * speaker created fresh at the start of each session would spend the first
   * word or two without a chosen voice.
   *
   * Two layers under the repeater: a human recording when there is a usable one,
   * and the synthesiser behind it for every word there is not — and for any
   * recording that fails to play.
   */
  readonly #words = new SpokenWords(new BrowserSpeaker(), () => this.#blocked);
  readonly #speaker: Speaker = new RepeatingSpeaker(this.#words);

  constructor(store: ProgressStore, root: HTMLElement) {
    this.#store = store;
    this.#root = root;
  }

  async start(): Promise<void> {
    this.#shared = await this.#store.loadShared();
    this.#blocked = new Set(this.#shared.blockedRecordings);
    await this.#showProfiles();
  }

  /**
   * Remember that a recording is unintelligible, and write it through.
   *
   * The in-memory set is updated first so the next word is said correctly even
   * if the write fails: a failed save costs the preference at the next restart,
   * which is a great deal better than the child pressing the button and hearing
   * the same unintelligible recording again.
   */
  async #blockRecording(id: string): Promise<void> {
    if (this.#blocked.has(id)) return;
    this.#blocked.add(id);
    this.#shared = { ...this.#shared, blockedRecordings: [...this.#blocked].sort() };
    try {
      await this.#store.saveShared(this.#shared);
    } catch {
      // Nothing useful to say to a child here, and the game carries on either way.
    }
  }

  async #showProfiles(): Promise<void> {
    const screen = new ProfileScreen({
      store: this.#store,
      root: this.#root,
      onPlay: (profileId, subject) => void this.#play(profileId, subject),
      onCredits: () => void this.#showCredits(),
    });
    await screen.start();
  }

  async #showCredits(): Promise<void> {
    await new CreditsScreen({
      root: this.#root,
      onExit: () => void this.#showProfiles(),
    }).start();
  }

  async #play(profileId: string, subject: SubjectId): Promise<void> {
    const record = await this.#store.load(profileId);
    if (record === null) {
      // The profile went away between the click and the load — deleted in
      // another tab, most likely. Falling back to the picker is the whole fix.
      await this.#showProfiles();
      return;
    }

    const onExit = (): void => void this.#showProfiles();
    if (subject === "spelling") {
      new SpellingScreen({
        store: this.#store,
        root: this.#root,
        record,
        speaker: this.#speaker,
        onExit,
        sourceFor: (word) => this.#words.sourceFor(word),
        onBlockRecording: (id) => this.#blockRecording(id),
      }).start();
      return;
    }

    new MultiplicationScreen({ store: this.#store, root: this.#root, record, onExit }).start();
  }
}
