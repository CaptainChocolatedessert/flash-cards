/**
 * The shell: which screen is on, and nothing else.
 *
 * No router and no history handling. There are two screens, the game is a
 * modal thing a child enters and leaves, and a back button that dropped them out
 * of a half-finished session would be a bug rather than a feature. If the app
 * ever grows a third screen worth linking to, this is where that decision goes.
 */

import type { ProgressStore } from "../storage/index.js";
import { MultiplicationScreen } from "./multiplication.js";
import { ProfileScreen } from "./profiles.js";

export class App {
  readonly #store: ProgressStore;
  readonly #root: HTMLElement;

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
      onPlay: (profileId) => void this.#play(profileId),
    });
    await screen.start();
  }

  async #play(profileId: string): Promise<void> {
    const record = await this.#store.load(profileId);
    if (record === null) {
      // The profile went away between the click and the load — deleted in
      // another tab, most likely. Falling back to the picker is the whole fix.
      await this.#showProfiles();
      return;
    }

    new MultiplicationScreen({
      store: this.#store,
      root: this.#root,
      record,
      onExit: () => void this.#showProfiles(),
    }).start();
  }
}
