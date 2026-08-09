import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emojiEnabled, randomEmoji, setEmojiEnabled } from "./celebrate.js";

describe("picking an emoji", () => {
  it("always returns one", () => {
    for (let i = 0; i < 200; i += 1) expect(randomEmoji()).toMatch(/\S/);
  });

  it("never repeats the one just shown", () => {
    // Twice running reads as a broken feature rather than a coincidence.
    let last = randomEmoji();
    for (let i = 0; i < 500; i += 1) {
      const next = randomEmoji(Math.random, last);
      expect(next).not.toBe(last);
      last = next;
    }
  });

  it("still returns something if asked to avoid an emoji it does not have", () => {
    expect(randomEmoji(Math.random, "not-an-emoji")).toMatch(/\S/);
  });

  it("uses the whole set rather than favouring the first", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i += 1) seen.add(randomEmoji());
    expect(seen.size).toBeGreaterThan(20);
  });

  it("is deterministic under a fixed source, so a seeded run is reproducible", () => {
    expect(randomEmoji(() => 0)).toBe(randomEmoji(() => 0));
    expect(randomEmoji(() => 0)).not.toBe(randomEmoji(() => 0.999));
  });
});

describe("the preference", () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "localStorage");
  });

  it("is on until it is turned off", () => {
    expect(emojiEnabled("sam")).toBe(true);
  });

  it("remembers being turned off, and back on", () => {
    setEmojiEnabled("sam", false);
    expect(emojiEnabled("sam")).toBe(false);
    setEmojiEnabled("sam", true);
    expect(emojiEnabled("sam")).toBe(true);
  });

  it("is per child, so one turning it off does not turn it off for the other", () => {
    setEmojiEnabled("sam", false);
    expect(emojiEnabled("sam")).toBe(false);
    expect(emojiEnabled("alex")).toBe(true);
  });
});

describe("when storage is unavailable", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("blocked");
      },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "localStorage");
  });

  it("carries on rather than failing a game over a decoration", () => {
    expect(emojiEnabled("sam")).toBe(true);
    expect(() => setEmojiEnabled("sam", false)).not.toThrow();
  });
});
