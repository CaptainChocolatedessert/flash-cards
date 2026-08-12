import { describe, expect, it, vi } from "vitest";
import { chooseRecording, recordingUrl, recordingsFor, SpokenWords } from "./recordings.js";
import { SilentSpeaker } from "./speech.js";
import type { Speaker } from "./speech.js";
import index from "../content/recordings.json";

const HAS_AUDIO = Object.keys(index.words).length > 0;
/** Any word that actually has recordings, so these run against the real index. */
const RECORDED = Object.keys(index.words)[0] ?? "";

/** A speaker that records what it was asked to say and always succeeds. */
class Spy implements Speaker {
  readonly available = true;
  spoken: string[] = [];
  speak(word: string): Promise<void> {
    this.spoken.push(word);
    return Promise.resolve();
  }
  cancel(): void {}
}

describe("choosing a recording", () => {
  it("returns nothing for a word with no recordings", () => {
    expect(recordingsFor("thiswordisnotinthelist")).toEqual([]);
    expect(chooseRecording("thiswordisnotinthelist", new Set())).toBeNull();
  });

  it.runIf(HAS_AUDIO)("names files in preference order", () => {
    const ids = recordingsFor(RECORDED);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids[0]).toMatch(/-1\.mp3$/);
    // Numbering is dense and starts at one: gaps would mean a file the index
    // claims exists and the fetcher never wrote.
    ids.forEach((id, i) => expect(id).toMatch(new RegExp(`-${i + 1}\\.mp3$`)));
  });

  it.runIf(HAS_AUDIO)("skips blocked recordings and falls through when all are blocked", () => {
    const ids = recordingsFor(RECORDED);
    expect(chooseRecording(RECORDED, new Set())).toBe(ids[0]);
    expect(chooseRecording(RECORDED, new Set([ids[0]!]))).toBe(ids[1] ?? null);
    // Every recording rejected means synthesis, which is what null asks for.
    expect(chooseRecording(RECORDED, new Set(ids))).toBeNull();
  });

  it("serves audio from under the app's base path", () => {
    // The app is deployed to a subpath on Pages, so a root-relative URL would
    // 404 in production while working perfectly in dev.
    expect(recordingUrl("cat-1.mp3")).toBe(`${import.meta.env.BASE_URL}audio/cat-1.mp3`);
  });
});

describe("falling back to the synthesiser", () => {
  it("synthesises a word that has no recording", async () => {
    const synth = new Spy();
    const words = new SpokenWords(synth, () => new Set());
    await words.speak("thiswordisnotinthelist");
    expect(synth.spoken).toEqual(["thiswordisnotinthelist"]);
  });

  it.runIf(HAS_AUDIO)("synthesises when every recording is blocked", async () => {
    const synth = new Spy();
    const blocked = new Set(recordingsFor(RECORDED));
    const words = new SpokenWords(synth, () => blocked);
    expect(words.sourceFor(RECORDED)).toBeNull();
    await words.speak(RECORDED);
    expect(synth.spoken).toEqual([RECORDED]);
  });

  it("reads the blocked set fresh on every word", () => {
    const blocked = new Set<string>();
    const words = new SpokenWords(new Spy(), () => blocked);
    const before = words.sourceFor(RECORDED);
    if (before === null) return; // no corpus fetched; nothing to assert
    blocked.add(before);
    // Blocking has to take effect on the next word said, without the speaker
    // being rebuilt — otherwise the child presses the button and hears the same
    // unintelligible recording again.
    expect(words.sourceFor(RECORDED)).not.toBe(before);
  });

  it("stays available when the synthesiser is not, if there are recordings", () => {
    const words = new SpokenWords(new SilentSpeaker(), () => new Set());
    expect(words.available).toBe(HAS_AUDIO);
  });

  it("cancels both layers, since either could be making noise", () => {
    const synth = new Spy();
    const cancel = vi.spyOn(synth, "cancel");
    new SpokenWords(synth, () => new Set()).cancel();
    expect(cancel).toHaveBeenCalled();
  });
});
