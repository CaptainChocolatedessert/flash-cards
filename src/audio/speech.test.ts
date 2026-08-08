import { describe, expect, it } from "vitest";
import { RepeatingSpeaker, SilentSpeaker, chooseVoice } from "./speech.js";

function voice(name: string, lang: string, localService: boolean): SpeechSynthesisVoice {
  return { name, lang, localService, default: false, voiceURI: name } as SpeechSynthesisVoice;
}

describe("choosing a voice", () => {
  it("prefers a voice that lives on the device", () => {
    // A remote voice would make the spelling game the one part of an offline
    // app that silently stops working without a network.
    const chosen = chooseVoice([
      voice("Remote US", "en-US", false),
      voice("Local GB", "en-GB", true),
    ]);
    expect(chosen?.name).toBe("Local GB");
  });

  it("prefers US English among local voices", () => {
    const chosen = chooseVoice([
      voice("Local GB", "en-GB", true),
      voice("Local US", "en-US", true),
    ]);
    expect(chosen?.name).toBe("Local US");
  });

  it("ignores voices that are not English", () => {
    const chosen = chooseVoice([
      voice("Local FR", "fr-FR", true),
      voice("Remote AU", "en-AU", false),
    ]);
    expect(chosen?.name).toBe("Remote AU");
  });

  it("returns null when there is no English voice at all", () => {
    expect(chooseVoice([voice("Local FR", "fr-FR", true)])).toBeNull();
    expect(chooseVoice([])).toBeNull();
  });
});

describe("the silent speaker", () => {
  it("reports itself unavailable and never hangs", async () => {
    const speaker = new SilentSpeaker();
    expect(speaker.available).toBe(false);
    await speaker.speak("rhythm");
    expect(speaker.spoken).toEqual(["rhythm"]);
  });
});

describe("saying a word more than once", () => {
  const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  it("says it the full number of times", async () => {
    const inner = new SilentSpeaker();
    await new RepeatingSpeaker(inner, 3, 5).speak("cut");
    await settle(60);
    expect(inner.spoken).toEqual(["cut", "cut", "cut"]);
  });

  it("resolves after the first saying, so the clock can start", async () => {
    // The child can begin as soon as they have heard it once; making them wait
    // out the reinforcement would push the timing clock several seconds late.
    const inner = new SilentSpeaker();
    await new RepeatingSpeaker(inner, 3, 30).speak("cut");
    expect(inner.spoken).toEqual(["cut"]);
  });

  it("stops the repeats when cancelled", async () => {
    const inner = new SilentSpeaker();
    const speaker = new RepeatingSpeaker(inner, 4, 10);
    await speaker.speak("cut");
    speaker.cancel();
    await settle(80);
    expect(inner.spoken).toEqual(["cut"]);
  });

  it("does not let a stale repeat talk over the next word", async () => {
    const inner = new SilentSpeaker();
    const speaker = new RepeatingSpeaker(inner, 4, 15);
    await speaker.speak("cut");
    await speaker.speak("rhythm");
    await settle(120);
    expect(inner.spoken.filter((w) => w === "cut")).toEqual(["cut"]);
    expect(inner.spoken.filter((w) => w === "rhythm")).toHaveLength(4);
  });

  it("passes availability through from whatever is underneath", () => {
    expect(new RepeatingSpeaker(new SilentSpeaker()).available).toBe(false);
  });
});
