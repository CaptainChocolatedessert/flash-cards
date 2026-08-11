/**
 * Carrying on from a feedback card.
 *
 * **Every answer waits for the child, right or wrong.** An earlier build moved
 * on by itself after a right answer, on the theory that a correct answer has
 * nothing to read. It has: the word or the product is on screen, and there is a
 * silly picture to enjoy. Half a second is enough to register that something
 * happened and not enough to look at it, so the moment was spent rather than
 * given. Waiting also makes the rhythm of the game one thing instead of two —
 * every card ends the same way, and nothing is ever whipped away mid-glance.
 *
 * The cost is one keypress per question, which is the same keypress they just
 * made to answer, and it is a cost worth paying.
 */

/**
 * How long a newly drawn screen ignores Enter.
 *
 * Not a cosmetic delay — it is what stops one physical keypress from doing two
 * things. A keystroke handled on an element is still propagating to the document
 * while the next screen is being built, so a listener attached during that
 * handler receives the same keystroke; key repeat has the same effect a moment
 * later. Long enough to swallow both, short enough that nobody typing at speed
 * ever notices it.
 *
 * It guards the other direction too: an empty answer submitted the instant a
 * question appears is a stray repeat from the keystroke that dismissed the last
 * card, not a considered "I don't know".
 */
export const SETTLE_MS = 400;

export interface ContinueControl {
  /** The button, ready to append. Focused shortly after it is on screen. */
  readonly button: HTMLButtonElement;
  /** Abort this to stop listening for the key. The caller owns the lifetime. */
  readonly keys: AbortController;
}

/**
 * A "Next" button, plus Enter from anywhere on the page.
 *
 * Enter is listened for on the document rather than only on the button because
 * the child has just typed an answer and their hands are still on the keyboard;
 * making them find the mouse, or depend on wherever focus happens to have
 * landed, would break the rhythm of the whole session. The button is there for
 * the child who is using a mouse, and because a keyboard-only affordance is
 * invisible.
 */
export function continueControl(onContinue: () => void): ContinueControl {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Next";
  button.addEventListener("click", onContinue);
  setTimeout(() => button.focus(), 0);

  const keys = new AbortController();
  const shownAt = Date.now();
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Enter") return;
      // Anything this soon cannot have been a response to what is on screen:
      // it is either the keystroke that submitted the answer, still travelling
      // up to the document while this listener was being attached, or key
      // repeat from a child holding Enter down. Either would skip the card they
      // are supposed to be looking at.
      if (Date.now() - shownAt < SETTLE_MS) return;
      event.preventDefault();
      onContinue();
    },
    { signal: keys.signal },
  );

  return { button, keys };
}
