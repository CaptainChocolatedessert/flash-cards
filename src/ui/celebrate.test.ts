import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EmojiParade,
  PARADE_GAP_PX,
  PARADE_SIZE_PX,
  emojiEnabled,
  paradeGeometry,
  randomEmoji,
  setEmojiEnabled,
} from "./celebrate.js";

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

describe("the parade's geometry", () => {
  const WIDTH = 1000;
  const HEIGHT = 800;

  it("starts with the newest emoji on the left edge, whatever is behind it", () => {
    // The leader is the row's last child, so the row is shifted left by exactly
    // the run of emoji behind it — putting the leader on the edge, not the row.
    expect(paradeGeometry(1, WIDTH, HEIGHT).fromX).toBe(0);
    const step = PARADE_SIZE_PX + PARADE_GAP_PX;
    expect(paradeGeometry(2, WIDTH, HEIGHT).fromX).toBe(-step);
    expect(paradeGeometry(10, WIDTH, HEIGHT).fromX).toBe(-9 * step);
  });

  it("carries the whole line off the far edge, including the oldest", () => {
    // The oldest sits at the row's left end, so the row has to travel a full
    // viewport width past its own start for everything to have left.
    for (const count of [1, 5, 40]) {
      const g = paradeGeometry(count, WIDTH, HEIGHT);
      expect(g.toX).toBe(WIDTH);
      expect(g.toX - g.fromX).toBeGreaterThanOrEqual(WIDTH);
    }
  });

  it("takes longer for a longer line, within bounds", () => {
    const short = paradeGeometry(1, WIDTH, HEIGHT).durationMs;
    const long = paradeGeometry(30, WIDTH, HEIGHT).durationMs;
    expect(long).toBeGreaterThan(short);
    // A first win should not crawl, and a hundred wins should not hold the
    // screen hostage — a child who wants the next question is entitled to it.
    expect(paradeGeometry(1, WIDTH, HEIGHT).durationMs).toBeGreaterThanOrEqual(1600);
    expect(paradeGeometry(500, WIDTH, HEIGHT).durationMs).toBeLessThanOrEqual(7000);
  });

  it("marches low enough to leave the answer readable", () => {
    const g = paradeGeometry(3, WIDTH, HEIGHT);
    expect(g.y).toBeGreaterThan(HEIGHT / 2);
    expect(g.y).toBeLessThan(HEIGHT);
  });
});

describe("collecting over a session", () => {
  it("keeps every win in the order they were won", () => {
    const parade = new EmojiParade();
    expect(parade.collected).toEqual([]);
    parade.add("🐙");
    parade.add("🦄");
    parade.add("🐙");
    // Repeats are kept: it is a haul, not a set, and two octopuses are two wins.
    expect(parade.collected).toEqual(["🐙", "🦄", "🐙"]);
  });
});
