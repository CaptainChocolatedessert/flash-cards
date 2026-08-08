/**
 * The profile screen: pick a child, create one, back the record up, restore it.
 *
 * Build order step 2. Deliberately unstyled and unpolished — its job right now
 * is to make persistence *visible* so it can be proven before anything is built
 * on top of it. The counts it prints are the ones that would be wrong if a save
 * were silently dropping part of the record.
 *
 * It talks to a `ProgressStore` and never to IndexedDB. Everything below this
 * file could be swapped for a network-backed store without a line changing here.
 */

import type { ProfileSummary, ProgressRecord, ProgressStore, SubjectId } from "../storage/index.js";
import { BackupError, backupFilename, parseBackup, serialiseBackup } from "../storage/index.js";

/**
 * Which child is currently picked. Deliberately *not* in the progress record:
 * it is a UI preference, it means nothing on another device, and it should not
 * travel in a backup file. `localStorage` is the right home for exactly this
 * kind of thing and the wrong home for the record itself.
 */
const SELECTED_KEY = "flash-cards:selected-profile";

export interface ProfileScreenOptions {
  readonly store: ProgressStore;
  readonly root: HTMLElement;
  /** Start a game for this child. The app shell decides what that means. */
  readonly onPlay: (profileId: string, subject: SubjectId) => void;
}

export class ProfileScreen {
  readonly #store: ProgressStore;
  readonly #root: HTMLElement;
  readonly #onPlay: (profileId: string, subject: SubjectId) => void;
  #profiles: ProfileSummary[] = [];
  #records = new Map<string, ProgressRecord>();
  #selected: string | null = null;

  constructor({ store, root, onPlay }: ProfileScreenOptions) {
    this.#store = store;
    this.#root = root;
    this.#onPlay = onPlay;
    this.#selected = localStorage.getItem(SELECTED_KEY);
  }

  async start(): Promise<void> {
    await this.#refresh();
  }

  async #refresh(): Promise<void> {
    this.#profiles = await this.#store.listProfiles();
    // Loading every record to show counts is fine at two children and would not
    // be at two hundred. If a profile list ever gets long, the counts move into
    // the summary instead.
    this.#records = new Map(
      (
        await Promise.all(
          this.#profiles.map(async (p) => [p.id, await this.#store.load(p.id)] as const),
        )
      ).flatMap(([id, record]) => (record ? [[id, record] as const] : [])),
    );
    if (this.#selected !== null && !this.#records.has(this.#selected)) {
      this.#select(null);
    }
    this.#render();
  }

  #select(id: string | null): void {
    this.#selected = id;
    if (id === null) localStorage.removeItem(SELECTED_KEY);
    else localStorage.setItem(SELECTED_KEY, id);
  }

  #message(text: string, tone: "info" | "error" = "info"): void {
    const box = this.#root.querySelector<HTMLElement>(".message");
    if (box === null) return;
    box.textContent = text;
    box.dataset["tone"] = tone;
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  #render(): void {
    this.#root.replaceChildren();

    const heading = el("h1", "Flash Cards");
    const lede = el(
      "p",
      "Times tables are ready to play. Spelling is not built yet. Progress is saved on this computer — use Export now and then, so it is not the only copy.",
    );
    lede.className = "lede";

    this.#root.append(heading, lede, this.#profileSection());
    if (this.#selected !== null) this.#root.append(this.#playSection(this.#selected));
    this.#root.append(this.#backupSection());

    const message = document.createElement("p");
    message.className = "message";
    this.#root.append(message);

    void this.#renderStorageStatus();
  }

  #profileSection(): HTMLElement {
    const section = document.createElement("section");
    section.append(el("h2", "Who is playing?"));

    if (this.#profiles.length === 0) {
      const empty = el("p", "No profiles yet. Add one below.");
      empty.className = "empty";
      section.append(empty);
    } else {
      const list = document.createElement("ul");
      list.className = "profiles";
      for (const profile of this.#profiles) list.append(this.#profileRow(profile));
      section.append(list);
    }

    section.append(this.#createForm());
    return section;
  }

  #profileRow(profile: ProfileSummary): HTMLElement {
    const row = document.createElement("li");
    row.className = "profile";
    row.setAttribute("aria-current", String(profile.id === this.#selected));

    const text = document.createElement("div");
    const name = el("div", profile.name);
    name.className = "profile-name";
    const detail = el("div", this.#describe(profile));
    detail.className = "profile-detail";
    text.append(name, detail);

    const actions = document.createElement("div");
    actions.className = "profile-actions";

    const choose = button(profile.id === this.#selected ? "Selected" : "Select", () => {
      this.#select(profile.id);
      this.#render();
    });
    choose.disabled = profile.id === this.#selected;

    const remove = button("Delete", () => {
      void this.#deleteProfile(profile);
    });

    actions.append(choose, remove);
    row.append(text, actions);
    return row;
  }

  /**
   * The line that does the actual work of this screen: after a browser restart,
   * these counts and dates either come back or they do not.
   */
  #describe(profile: ProfileSummary): string {
    const record = this.#records.get(profile.id);
    const parts = [`created ${formatDate(profile.createdAt)}`];
    parts.push(
      profile.lastPlayedAt === null
        ? "never played"
        : `last played ${formatDate(profile.lastPlayedAt)}`,
    );
    parts.push(`saved ${formatDateTime(profile.updatedAt)}`);
    if (record !== undefined) {
      for (const subject of ["spelling", "multiplication"] as SubjectId[]) {
        const s = record.subjects[subject];
        parts.push(
          `${subject}: ${Object.keys(s.items).length} items, ${s.attempts.length} attempts, ${s.sessions.length} sessions`,
        );
      }
    }
    return parts.join(" · ");
  }

  #createForm(): HTMLElement {
    const form = document.createElement("form");
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Name";
    input.setAttribute("aria-label", "New profile name");
    input.maxLength = 40;

    const add = document.createElement("button");
    add.type = "submit";
    add.textContent = "Add profile";

    form.append(input, add);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const name = input.value.trim();
      if (name === "") {
        this.#message("Give the profile a name first.", "error");
        return;
      }
      input.value = "";
      void this.#createProfile(name);
    });
    return form;
  }

  /** The subject picker. */
  #playSection(profileId: string): HTMLElement {
    const section = document.createElement("section");
    section.append(el("h2", "Play"));

    const row = document.createElement("div");
    row.className = "row";
    const times = button("Times tables", () => this.#onPlay(profileId, "multiplication"));
    times.className = "play";
    const spelling = button("Spelling", () => this.#onPlay(profileId, "spelling"));
    spelling.className = "play";
    row.append(times, spelling);
    section.append(row);

    const record = this.#records.get(profileId);
    if (record !== undefined) {
      for (const line of [
        this.#dueLine(record, "multiplication", "fact"),
        this.#dueLine(record, "spelling", "word"),
      ]) {
        const note = el("p", line);
        note.className = "note";
        section.append(note);
      }
    }
    return section;
  }

  /** What is waiting, so starting a session is not a blind click. */
  #dueLine(record: ProgressRecord, subject: SubjectId, noun: string): string {
    const label = subject === "spelling" ? "Spelling" : "Times tables";
    const now = Date.now();
    const items = Object.values(record.subjects[subject].items);
    if (items.length === 0) return `${label}: nothing met yet — the first session starts fresh.`;
    const due = items.filter((s) => s.dueAt !== null && s.dueAt <= now).length;
    return due === 0
      ? `${label}: ${items.length} ${noun}s met, none due right now — a session will bring in new ones.`
      : `${label}: ${due} ${noun}${due === 1 ? "" : "s"} due for review, out of ${items.length} met.`;
  }

  #backupSection(): HTMLElement {
    const section = document.createElement("section");
    section.append(el("h2", "Backup"));

    const row = document.createElement("div");
    row.className = "row";
    row.append(
      button("Export to a file", () => void this.#export()),
      button("Restore from a file", () => void this.#import("replace")),
      button("Merge in a file", () => void this.#import("merge")),
    );

    const note = el(
      "p",
      "Export downloads everything — both children, every subject. Restore replaces what is here with what is in the file; merge keeps whichever version of each profile was saved most recently.",
    );
    note.className = "note";

    const status = document.createElement("p");
    status.className = "note";
    status.id = "storage-status";

    section.append(row, note, status);
    return section;
  }

  /**
   * Whether the browser has marked this origin's storage as persistent.
   *
   * Read-only here on purpose. *Requesting* persistence is build order step 8,
   * where it belongs with the PWA install that makes a grant likely; reporting
   * the current answer costs nothing and is the fastest way to tell whether a
   * disappearance was eviction or a bug.
   */
  async #renderStorageStatus(): Promise<void> {
    const status = this.#root.querySelector<HTMLElement>("#storage-status");
    if (status === null) return;
    if (navigator.storage === undefined) {
      status.textContent = "This browser does not report storage status.";
      return;
    }
    const persisted = await navigator.storage.persisted();
    const estimate = await navigator.storage.estimate();
    const used = estimate.usage === undefined ? "unknown" : `${(estimate.usage / 1024).toFixed(0)} KB`;
    status.textContent = persisted
      ? `Storage is marked persistent. Using ${used}.`
      : `Storage is best-effort — the browser may clear it if the disk fills. Using ${used}.`;
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  async #createProfile(name: string): Promise<void> {
    try {
      const record = await this.#store.createProfile(name);
      this.#select(record.profile.id);
      await this.#refresh();
      this.#message(`Added ${name}.`);
    } catch (error) {
      this.#fail("Could not create that profile", error);
    }
  }

  async #deleteProfile(profile: ProfileSummary): Promise<void> {
    const confirmed = window.confirm(
      `Delete ${profile.name} and all of their progress? This cannot be undone. Export a backup first if you are not sure.`,
    );
    if (!confirmed) return;
    try {
      await this.#store.deleteProfile(profile.id);
      if (this.#selected === profile.id) this.#select(null);
      await this.#refresh();
      this.#message(`Deleted ${profile.name}.`);
    } catch (error) {
      this.#fail("Could not delete that profile", error);
    }
  }

  async #export(): Promise<void> {
    try {
      const now = Date.now();
      const text = serialiseBackup(await this.#store.exportAll(now));
      download(backupFilename(now), text);
      this.#message(`Exported ${this.#profiles.length} profile(s).`);
    } catch (error) {
      this.#fail("Could not export", error);
    }
  }

  async #import(mode: "replace" | "merge"): Promise<void> {
    const file = await pickFile();
    if (file === null) return;

    let backup;
    try {
      backup = parseBackup(await file.text());
    } catch (error) {
      this.#message(
        error instanceof BackupError ? error.message : "Could not read that file.",
        "error",
      );
      return;
    }

    if (mode === "replace") {
      const confirmed = window.confirm(
        `Replace everything currently saved with the ${backup.profiles.length} profile(s) in this file? Anything not in the file will be deleted.`,
      );
      if (!confirmed) return;
    }

    try {
      await this.#store.importAll(backup, mode);
      await this.#refresh();
      this.#message(
        mode === "replace"
          ? `Restored ${backup.profiles.length} profile(s) from ${file.name}.`
          : `Merged ${backup.profiles.length} profile(s) from ${file.name}.`,
      );
    } catch (error) {
      this.#fail("Could not import that file", error);
    }
  }

  #fail(what: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.#message(`${what}: ${detail}`, "error");
  }
}

// ---------------------------------------------------------------------------
// Small DOM helpers
// ---------------------------------------------------------------------------

function el(tag: string, text: string): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.textContent = label;
  node.addEventListener("click", onClick);
  return node;
}

function formatDate(at: number): string {
  return new Date(at).toLocaleDateString();
}

function formatDateTime(at: number): string {
  return new Date(at).toLocaleString();
}

function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  // Revoking immediately would race the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Null when the picker is dismissed. */
function pickFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null), { once: true });
    // A dismissed picker fires no event in most browsers, so nothing resolves and
    // the promise is simply dropped. That is fine here: no state is held open.
    input.click();
  });
}
