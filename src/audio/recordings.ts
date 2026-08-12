/**
 * Human recordings, and which one a word gets.
 *
 * The recordings themselves are static files under `public/audio/`, fetched from
 * Wikimedia Commons at build time by `scripts/fetch-audio.mjs` and committed. See
 * DESIGN.md, "Audio". Nothing here talks to the network beyond loading a file the
 * service worker is free to cache.
 *
 * **What is bundled is only the index** — word to how many recordings it has. The
 * licence and author of every single file are far larger than the index and are
 * needed by exactly one screen, so they live in `public/audio/credits.json` and
 * are fetched when someone opens the credits page. Attribution is a legal
 * requirement; making every child download three thousand of them to spell "cat"
 * is not.
 */

import index from "../content/recordings.json";
import type { Speaker } from "./speech.js";

interface IndexEntry {
  /** Filename stem. Differs from the word for the seven words that are not plain letters. */
  readonly slug: string;
  readonly count: number;
}

const WORDS = index.words as Readonly<Record<string, IndexEntry>>;

/** When this index was built. Shown on the credits page so a stale fetch is visible. */
export const GENERATED_AT: string = index.generatedAt;

/**
 * Give up on a recording that will not play and let the synthesiser take over.
 *
 * The same reasoning as the synthesiser's own timeout: `ended` is not guaranteed
 * to arrive, and a question that waits forever for a sound that never comes is a
 * hung game. A pronunciation is about a second long, so this is generous.
 */
const PLAY_TIMEOUT_MS = 6000;

/**
 * Every recording for a word, best first.
 *
 * The ordering is the fetcher's: a US Wiktionary recording where one exists, then
 * other accents it could name from the filename, then Lingua Libre. The ids are
 * filenames — stable, unique, and readable in a backup file, which matters
 * because this is what the blocked list stores.
 */
export function recordingsFor(word: string): string[] {
  const entry = WORDS[word];
  if (entry === undefined) return [];
  return Array.from({ length: entry.count }, (_, i) => `${entry.slug}-${i + 1}.mp3`);
}

/**
 * The recording a word should be said with, or null to fall through to synthesis.
 *
 * Null means one of two different things and deliberately does not distinguish
 * them: no recording was ever fetched for this word, or the child has rejected
 * every one there is. Both end at the synthesiser, and the caller has no reason
 * to care which.
 */
export function chooseRecording(word: string, blocked: ReadonlySet<string>): string | null {
  return recordingsFor(word).find((id) => !blocked.has(id)) ?? null;
}

/** Where a recording actually lives. `BASE_URL` because the app is served from a subpath. */
export function recordingUrl(id: string): string {
  return `${import.meta.env.BASE_URL}audio/${id}`;
}

/** How many words have at least one recording. For the credits page and the tests. */
export function recordedWordCount(): number {
  return Object.keys(WORDS).length;
}

/**
 * Plays one recording.
 *
 * Not a `Speaker` — it takes a recording id rather than a word, because deciding
 * *which* recording a word gets is the blocked list's business and belongs in one
 * place rather than two. `SpokenWords` below is the `Speaker`.
 */
export class RecordingPlayer {
  #audio: HTMLAudioElement | null = null;

  play(id: string): Promise<void> {
    this.cancel();
    return new Promise<void>((resolve, reject) => {
      const audio = new Audio(recordingUrl(id));
      this.#audio = audio;

      let settled = false;
      const finish = (fail?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (fail === undefined) resolve();
        else reject(fail instanceof Error ? fail : new Error(String(fail)));
      };
      // A timeout that *resolves* rather than rejecting: by the time it fires the
      // sound has either been heard or been lost, and dropping the child into a
      // synthesised repeat of a word they already heard is worse than moving on.
      const timer = setTimeout(() => finish(), PLAY_TIMEOUT_MS);

      audio.addEventListener("ended", () => finish());
      audio.addEventListener("error", () => finish(new Error(`Could not play ${id}`)));
      // A rejected `play()` is the autoplay policy or a missing file. Either way
      // the caller wants to know, so it can fall back rather than sit in silence.
      audio.play().catch((error: unknown) => finish(error));
    });
  }

  cancel(): void {
    if (this.#audio === null) return;
    this.#audio.pause();
    this.#audio = null;
  }
}

/**
 * The speaker the game actually holds: a recording if there is a usable one, the
 * synthesiser otherwise.
 *
 * The fallback is not only for words with no recording. A recording that fails to
 * load — a bad deploy, a cache miss offline, a file that was never committed —
 * lands on the synthesiser too, because a child staring at silence has no way to
 * answer the question and no way to know why.
 *
 * `blocked` is read on every word rather than captured, so blocking a recording
 * takes effect on the very next thing said without rebuilding the speaker.
 */
export class SpokenWords implements Speaker {
  readonly #player = new RecordingPlayer();
  readonly #synth: Speaker;
  readonly #blocked: () => ReadonlySet<string>;

  constructor(synth: Speaker, blocked: () => ReadonlySet<string>) {
    this.#synth = synth;
    this.#blocked = blocked;
  }

  /**
   * True when *something* can say a word. Recordings work on a device with no
   * synthesiser at all, so this is deliberately an "or" — the spelling game's
   * "this browser cannot say the words" screen should only appear when neither
   * route exists.
   */
  get available(): boolean {
    return this.#synth.available || recordedWordCount() > 0;
  }

  /** The recording this word will be said with, or null if it will be synthesised. */
  sourceFor(word: string): string | null {
    return chooseRecording(word, this.#blocked());
  }

  async speak(word: string): Promise<void> {
    const id = this.sourceFor(word);
    if (id === null) {
      await this.#synth.speak(word);
      return;
    }
    try {
      await this.#player.play(id);
    } catch {
      await this.#synth.speak(word);
    }
  }

  cancel(): void {
    this.#player.cancel();
    this.#synth.cancel();
  }
}
