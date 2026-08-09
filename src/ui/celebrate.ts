/**
 * A silly emoji when you get one right.
 *
 * No effect on scheduling, scoring or the record — it is decoration, and it is
 * meant to be. The design's one worry about dropping the level ladder was losing
 * the moment of celebration; this is a very small down-payment on that, and a
 * cheap way to make a right answer feel like something.
 */

/**
 * Deliberately absurd rather than congratulatory. A rocket and a party popper
 * get old by the twentieth question; a hedgehog is still faintly funny at the
 * hundredth, because the joke is the randomness rather than the praise.
 */
const EMOJI: readonly string[] = [
  "🎉", "🎈", "🐙", "🦄", "🐸", "🚀", "🌟", "🍕", "🦕", "🐢",
  "🎸", "🧦", "🦖", "🍩", "🐧", "🎩", "🪅", "🦔", "🐳", "🍄",
  "🛸", "🦩", "🧁", "🐝", "🎺", "🦦", "🪐", "🍉", "🐴", "🧩",
  "🦥", "🐡", "🥁", "🌈", "🦜", "🍿", "🐌", "🎪", "🦉", "🥑",
];

/**
 * Pick one, never the same as last time.
 *
 * The repeat guard matters more than it sounds: the same emoji twice running
 * reads as a broken feature rather than a coincidence, and the whole point is
 * that you cannot guess what is coming.
 */
export function randomEmoji(rng: () => number = Math.random, avoid?: string): string {
  const pool = avoid === undefined ? EMOJI : EMOJI.filter((e) => e !== avoid);
  const choices = pool.length > 0 ? pool : EMOJI;
  return choices[Math.floor(rng() * choices.length)] ?? choices[0] ?? "🎉";
}

/**
 * Per child, and in `localStorage` rather than the progress record.
 *
 * It is a display preference: it means nothing on another device and has no
 * business travelling in a backup file. Per child rather than global because two
 * children share the machine and one of them turning it off should not turn it
 * off for the other.
 */
function key(profileId: string): string {
  return `flash-cards:emoji:${profileId}`;
}

/** On unless it has been turned off — they asked for it, so it should be there without hunting. */
export function emojiEnabled(profileId: string): boolean {
  try {
    return localStorage.getItem(key(profileId)) !== "off";
  } catch {
    // Storage can be unavailable in a locked-down browser. A missing preference
    // is not worth failing a game over.
    return true;
  }
}

export function setEmojiEnabled(profileId: string, on: boolean): void {
  try {
    localStorage.setItem(key(profileId), on ? "on" : "off");
  } catch {
    // Same: the toggle still works for this session, it just will not be remembered.
  }
}

/**
 * The toggle, for the question screen's header.
 *
 * It deliberately **does not re-render the screen**. In the spelling game a
 * re-render restarts the question, which would say the word again from the top —
 * so the button updates itself in place. And it hands focus straight back to the
 * answer box, because a control that quietly steals focus mid-question is the
 * bug this project has already hit twice.
 */
export function emojiToggle(profileId: string, onChange: (on: boolean) => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "emoji-toggle";

  const paint = (): void => {
    const on = emojiEnabled(profileId);
    button.textContent = on ? "🎉" : "🚫";
    button.setAttribute("aria-pressed", String(on));
    button.setAttribute("aria-label", on ? "Silly pictures on" : "Silly pictures off");
    button.title = on ? "Silly pictures on" : "Silly pictures off";
  };
  paint();

  button.addEventListener("click", () => {
    const on = !emojiEnabled(profileId);
    setEmojiEnabled(profileId, on);
    paint();
    onChange(on);
    document.querySelector<HTMLInputElement>("input.answer")?.focus();
  });

  return button;
}

/**
 * The emoji itself, for a correct answer.
 *
 * Hidden from screen readers: it carries no information the feedback text does
 * not already give, and "party popper" read aloud after every right answer would
 * be noise.
 */
export function celebration(emoji: string): HTMLElement {
  const node = document.createElement("div");
  node.className = "celebration";
  node.textContent = emoji;
  node.setAttribute("aria-hidden", "true");
  return node;
}
