/**
 * Who recorded the words, and under what licence.
 *
 * Not optional and not decoration. The recordings are reused under CC-BY-SA,
 * CC-BY and CC0, and all but the CC0 ones require the author to be named
 * wherever the work is used. See DESIGN.md, "Attribution".
 *
 * **Generated, never hand-maintained.** The list is written by the same script
 * that fetches the audio, because a credits page maintained by hand survives
 * exactly until the first re-fetch and then quietly starts lying.
 *
 * It is fetched rather than bundled: three thousand attributions are far larger
 * than the rest of the app, and nobody needs them in order to spell "cat".
 */

import { GENERATED_AT } from "../audio/recordings.js";

interface Credit {
  readonly file: string;
  readonly word: string;
  readonly accent: string;
  readonly title: string;
  readonly page: string;
  readonly artist: string;
  readonly licence: string;
  readonly licenceUrl: string;
}

interface CreditsFile {
  readonly generatedAt: string;
  readonly recordings: readonly Credit[];
}

export interface CreditsScreenOptions {
  readonly root: HTMLElement;
  readonly onExit: () => void;
}

function el(tag: string, content?: string): HTMLElement {
  const node = document.createElement(tag);
  if (content !== undefined) node.textContent = content;
  return node;
}

function link(href: string, text: string): HTMLAnchorElement {
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.textContent = text;
  anchor.rel = "noreferrer";
  anchor.target = "_blank";
  return anchor;
}

export class CreditsScreen {
  readonly #root: HTMLElement;
  readonly #onExit: () => void;

  constructor({ root, onExit }: CreditsScreenOptions) {
    this.#root = root;
    this.#onExit = onExit;
  }

  async start(): Promise<void> {
    this.#render(el("p", "Loading…"));
    try {
      const response = await fetch(`${import.meta.env.BASE_URL}audio/credits.json`);
      if (!response.ok) throw new Error(`${response.status}`);
      this.#render(this.#list((await response.json()) as CreditsFile));
    } catch {
      // The credits file lives beside the audio, so if it cannot be loaded the
      // recordings are almost certainly missing too. Say what is true rather
      // than showing an empty page that looks like "nobody to credit".
      this.#render(
        el(
          "p",
          "The credits list could not be loaded. It is written by the audio fetch script and lives beside the recordings.",
        ),
      );
    }
  }

  #render(body: HTMLElement): void {
    this.#root.replaceChildren();

    const header = document.createElement("header");
    header.className = "game-header";
    const title = el("div", "Credits and licences");
    title.className = "game-who";
    const back = document.createElement("button");
    back.type = "button";
    back.textContent = "Back";
    back.addEventListener("click", () => this.#onExit());
    const spacer = document.createElement("div");
    spacer.className = "game-score";
    header.append(title, spacer, back);

    const section = document.createElement("section");
    section.append(
      el(
        "p",
        "The spoken words are volunteer recordings from Wikimedia Commons, including the Lingua Libre project. Each one is reused under the licence named against it, and the person who recorded it is named beside it.",
      ),
    );
    section.append(body);

    this.#root.append(header, section);
  }

  #list(credits: CreditsFile): HTMLElement {
    const wrapper = document.createElement("div");

    const byLicence = new Map<string, number>();
    for (const credit of credits.recordings) {
      byLicence.set(credit.licence, (byLicence.get(credit.licence) ?? 0) + 1);
    }

    const summary = el(
      "p",
      `${credits.recordings.length} recordings, fetched ${credits.generatedAt || GENERATED_AT}.`,
    );
    summary.className = "lede";
    wrapper.append(summary);

    const licences = document.createElement("ul");
    licences.className = "boxes";
    for (const [licence, count] of [...byLicence].sort((a, b) => b[1] - a[1])) {
      licences.append(el("li", `${count} under ${licence}`));
    }
    wrapper.append(el("h3", "Licences"), licences);

    // One row per recording. Long, and that is the point — this is the
    // attribution, not a summary of it.
    const table = document.createElement("ul");
    table.className = "credits";
    for (const credit of credits.recordings) {
      const row = document.createElement("li");
      const word = el("strong", credit.word);
      const by = el("span", ` — ${credit.artist}, `);
      const licence =
        credit.licenceUrl === ""
          ? el("span", credit.licence)
          : link(credit.licenceUrl, credit.licence);
      row.append(word, by, licence, el("span", " · "), link(credit.page, "file"));
      table.append(row);
    }
    wrapper.append(el("h3", "Every recording"), table);

    return wrapper;
  }
}
