import { describe, expect, it } from "vitest";
import { slugFor, tidyArtist, wordsFrom } from "../../scripts/fetch-audio.mjs";
import raw from "./word-lists.json";
import index from "./recordings.json";
import { spellingWords } from "./words.js";

/**
 * The fetch script is plain Node and the app is TypeScript, so the script has its
 * own copy of the word normalisation. That duplication is fine as long as it is
 * checked: if the two drift, the game asks for audio that was never fetched, and
 * every affected word silently degrades to the synthesiser with nothing to say
 * why.
 */
describe("the fetcher and the app agree on what a word is", () => {
  it("extracts exactly the words the app knows about", () => {
    const fromScript = [...wordsFrom(raw)].sort();
    const fromApp = spellingWords()
      .map((w) => w.word)
      .sort();
    expect(fromScript).toEqual(fromApp);
  });

  it("gives every word a distinct filename stem", () => {
    // "don't" and "santa claus" are not filenames. Two words colliding on one
    // slug would have them overwrite each other's audio.
    const slugs = wordsFrom(raw).map(slugFor);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("slugs only where it has to", () => {
    expect(slugFor("water")).toBe("water");
    expect(slugFor("don't")).toBe("don-t");
    expect(slugFor("santa claus")).toBe("santa-claus");
    expect(slugFor("good-bye")).toBe("good-bye");
  });
});

describe("naming the person who recorded it", () => {
  it("pulls the name out of Commons' template boilerplate", () => {
    expect(
      tidyArtist(
        "No machine-readable author provided. Xnux assumed (based on copyright claims).",
      ),
    ).toBe("Xnux");
  });

  it("collapses Lingua Libre's speaker-and-recorder when they are the same person", () => {
    expect(tidyArtist("Speaker: Grendelkhan Recorder: Grendelkhan")).toBe("Grendelkhan");
    expect(tidyArtist("Speaker: Alice Recorder: Bob")).toBe("Alice (recorded by Bob)");
  });

  it("leaves an ordinary name alone", () => {
    expect(tidyArtist("Dvortygirl")).toBe("Dvortygirl");
  });
});

describe("the recordings index", () => {
  const words = index.words as Record<string, { slug: string; count: number }>;
  const entries = Object.entries(words);

  it("only indexes words the game can actually ask for", () => {
    const known = new Set(spellingWords().map((w) => w.word));
    for (const [word] of entries) expect(known.has(word)).toBe(true);
  });

  it("agrees with the slug rule and claims at least one recording each", () => {
    for (const [word, entry] of entries) {
      expect(entry.slug).toBe(slugFor(word));
      expect(entry.count).toBeGreaterThan(0);
    }
  });
});
