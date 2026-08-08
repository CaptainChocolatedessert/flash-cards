import { describe, expect, it } from "vitest";
import { SilentSpeaker, chooseVoice } from "./speech.js";

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
