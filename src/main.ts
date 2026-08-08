/**
 * Entry point. Wires the one concrete store to the one screen that exists.
 *
 * This is the only file that names `IndexedDbProgressStore`. Everything else
 * takes a `ProgressStore`, which is what keeps a different implementation a
 * drop-in rather than a rewrite — see DESIGN.md, "The storage interface".
 */

import "./ui/styles.css";
import { IndexedDbProgressStore } from "./storage/index.js";
import { App } from "./ui/app.js";

const root = document.querySelector<HTMLElement>("#app");
if (root === null) throw new Error("Missing #app");

const app = new App(new IndexedDbProgressStore(), root);

app.start().catch((error: unknown) => {
  // Almost always one thing: a browser with IndexedDB blocked, which private
  // windows and some privacy settings do. Say so rather than showing a page
  // that silently does nothing.
  root.replaceChildren();
  const heading = document.createElement("h1");
  heading.textContent = "Flash Cards";
  const message = document.createElement("p");
  message.className = "message";
  message.dataset["tone"] = "error";
  message.textContent = `Could not open local storage, so progress cannot be saved. This usually means the browser is blocking site data — a private window will do it. Details: ${
    error instanceof Error ? error.message : String(error)
  }`;
  root.append(heading, message);
});
