/**
 * The shell: which screen is on, and nothing else.
 *
 * No router and no history handling. There are two screens, the game is a
 * modal thing a child enters and leaves, and a back button that dropped them out
 * of a half-finished session would be a bug rather than a feature. If the app
 * ever grows a third screen worth linking to, this is where that decision goes.
 */

import type { ProgressStore, SubjectId } from "../storage/index.js";
import { BrowserSpeaker } from "../audio/speech.js";
import type { Speaker } from "../audio/speech.js";
import { MultiplicationScreen } from "./multiplication.js";
import { ProfileScreen } from "./profiles.js";
import { SpellingScreen } from "./spelling.js";

export class App {
  readonly #store: ProgressStore;
  readonly #root: HTMLElement;
  /**
   * One speaker for the whole app, built once. Voices load asynchronously, so a
   * speaker created fresh at the start of each session would spend the first
   * word or two without a chosen voice.
   */
  readonly #speaker: Speaker = new BrowserSpeaker();

  constructor(store: ProgressStore, root: HTMLElement) {
    this.#store = store;
    this.#root = root;
  }

  async start(): Promise<void> {
    await this.#showProfiles();
  }

  async #showProfiles(): Promise<void> {
    const screen = new ProfileScreen({
      store: this.#store,
      root: this.#root,
      onPlay: (profileId, subject) => void this.#play(profileId, subject),
    });
    await screen.start();
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
      }).start();
      return;
    }

    new MultiplicationScreen({ store: this.#store, root: this.#root, record, onExit }).start();
  }
}
