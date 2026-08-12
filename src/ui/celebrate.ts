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

// ---------------------------------------------------------------------------
// The parade
// ---------------------------------------------------------------------------

/**
 * How big an emoji is once it has joined the parade, and how far apart they
 * march. Pixels rather than `rem`, because the geometry below has to be
 * arithmetic and a parade that reflowed with the root font size would need
 * measuring instead.
 */
export const PARADE_SIZE_PX = 44;
export const PARADE_GAP_PX = 14;

/** How fast the parade crosses, in pixels per second. */
const PARADE_SPEED = 620;

/** Bounds on how long a crossing takes, however short or long the line is. */
const PARADE_MIN_MS = 1600;
const PARADE_MAX_MS = 7000;

/** How long the new emoji takes to swoop from the card down to the head of the line. */
const SWOOP_MS = 520;

/**
 * How long to let the new emoji bounce in the card before it flies off.
 *
 * Must match the `pop` animation in the stylesheet, plus a beat to see it land.
 * The two cannot be derived from one another — one is CSS and one is script —
 * so this is the place they are written down as being the same thing.
 */
export const POP_SETTLE_MS = 520;

/** Where the line marches, as a fraction of the viewport height. Low, so it never covers the answer. */
const PARADE_HEIGHT_FRACTION = 0.76;

export interface ParadeGeometry {
  /** Translation, in px, that puts the leader at the left edge with the rest off-screen behind it. */
  readonly fromX: number;
  /** Translation that has carried the whole line off the right edge. */
  readonly toX: number;
  readonly durationMs: number;
  /** Top of the row, in px from the top of the viewport. */
  readonly y: number;
}

/**
 * Where the line starts, where it ends, and how long it takes.
 *
 * Pulled out as arithmetic so it can be tested without a browser — the animation
 * around it is untestable in the way DOM animation always is, but the numbers
 * that decide whether the parade actually crosses the screen are not.
 *
 * The row lays its emoji out oldest-first, so the newest sits at the right-hand
 * end. That is what makes the new one the *leader*: the line travels rightward,
 * so the rightmost emoji is the one at the front.
 */
export function paradeGeometry(count: number, width: number, height: number): ParadeGeometry {
  const step = PARADE_SIZE_PX + PARADE_GAP_PX;
  // Shift the row left by everything behind the leader, so the leader — the last
  // child — lands exactly on the left edge. Written as a branch rather than a
  // negated product so that a lone emoji starts at 0 rather than -0.
  const behind = Math.max(0, count - 1);
  const fromX = behind === 0 ? 0 : -(behind * step);
  // Far enough right that the *oldest* emoji, at the row's left end, has left too.
  const toX = width;
  const distance = toX - fromX;
  const durationMs = Math.min(PARADE_MAX_MS, Math.max(PARADE_MIN_MS, (distance / PARADE_SPEED) * 1000));
  return { fromX, toX, durationMs, y: Math.round(height * PARADE_HEIGHT_FRACTION) };
}

/** Whether the device has asked for less movement. A screen-crossing parade is exactly what that means. */
function wantsLessMotion(): boolean {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/**
 * Everything won so far, marching across the screen behind the newest one.
 *
 * One of these per game screen, holding the whole session's haul. It is
 * decoration and is never persisted: the collection is the fun of a single
 * sitting, and a parade that resumed from last Tuesday would be a different and
 * stranger feature.
 */
export class EmojiParade {
  readonly #collected: string[] = [];
  #layer: HTMLElement | null = null;
  #running: Animation[] = [];
  #cleanup: ReturnType<typeof setTimeout> | null = null;
  /** The card's own emoji, hidden while its double is out marching. */
  #borrowed: HTMLElement | null = null;

  /** Everything won this session, oldest first. */
  get collected(): readonly string[] {
    return this.#collected;
  }

  add(emoji: string): void {
    this.#collected.push(emoji);
  }

  /**
   * Send the newest emoji from `from` down to the head of the line, then march
   * the whole line across.
   *
   * `from` is the emoji already sitting in the feedback card, mid-bounce. It is
   * hidden rather than removed once the flight starts, so the card does not
   * jump: the space stays exactly as it was and the emoji simply leaves it.
   */
  run(from: HTMLElement): void {
    this.cancel();
    if (this.#collected.length === 0) return;
    // No flight and no march. The bounce in the card is already suppressed by
    // the stylesheet under the same query, so what is left is a still emoji —
    // which is the right answer to "less motion", not a smaller parade.
    if (wantsLessMotion()) return;

    const width = window.innerWidth;
    const geometry = paradeGeometry(this.#collected.length, width, window.innerHeight);
    const start = from.getBoundingClientRect();
    // A zero-sized rect means the card is not laid out — mid-teardown, or a
    // display:none ancestor. There is nowhere to fly from, so do not.
    if (start.width === 0 || start.height === 0) return;

    // Hidden rather than removed, so the card keeps its shape while the emoji is
    // away and nothing below it jumps. It comes back when the parade is over —
    // see `cancel`.
    from.style.visibility = "hidden";
    this.#borrowed = from;

    const layer = document.createElement("div");
    layer.className = "parade-layer";
    layer.setAttribute("aria-hidden", "true");
    this.#layer = layer;

    const row = document.createElement("div");
    row.className = "parade-row";
    row.style.top = `${geometry.y}px`;
    for (const emoji of this.#collected) {
      const cell = document.createElement("span");
      cell.className = "parade-emoji";
      cell.textContent = emoji;
      row.append(cell);
    }
    // The leader flies in separately, so its place in the line stays empty until
    // the flight lands. Without this the line would show two copies of the newest
    // emoji for half a second.
    const leader = row.lastElementChild as HTMLElement | null;

    const flyer = document.createElement("span");
    flyer.className = "parade-emoji parade-flyer";
    flyer.textContent = this.#collected[this.#collected.length - 1] ?? "";

    layer.append(row, flyer);
    document.body.append(layer);

    // The card's emoji is far bigger than a marching one; scale the flyer up to
    // match where it starts, so the handover is invisible.
    const scale = start.height / PARADE_SIZE_PX;

    // Everything below is sequenced by the animation timeline rather than by
    // waiting for one animation to finish and then starting the next.
    //
    // The event-driven version of this worked but was fragile: `finish` events
    // are delivered on a rendering frame, so anywhere frames stop — a
    // backgrounded tab, a pane that is not compositing — the flight would land
    // and the march would simply never begin. Declaring the whole sequence up
    // front means the browser owns the timing and there is no moment where the
    // effect depends on a callback arriving.
    this.#running.push(
      flyer.animate(
        [
          { transform: `translate(${start.left}px, ${start.top}px) scale(${scale})`, offset: 0 },
          // A midpoint above the straight line, so it arcs over rather than slides.
          {
            transform: `translate(${start.left * 0.45}px, ${
              (start.top + geometry.y) / 2 - 70
            }px) scale(${(scale + 1) / 2})`,
            offset: 0.55,
          },
          { transform: `translate(0px, ${geometry.y}px) scale(1)`, offset: 1 },
        ],
        { duration: SWOOP_MS, easing: "cubic-bezier(0.4, 0, 0.2, 1)", fill: "both" },
      ),
    );

    // The flyer blinks out and the leader blinks in on the same frame, so the
    // swap reads as one continuous emoji rather than two.
    //
    // **Both lists start at offset 0 on purpose.** A keyframe list whose first
    // entry sits at 0.999 does not hold still until then — it interpolates from
    // the element's underlying value, so the leader would fade from fully
    // visible down to nothing across the whole flight and the line would show a
    // second copy of the new emoji throughout. Which is the exact thing this
    // pair of animations exists to avoid.
    this.#running.push(
      flyer.animate(
        [
          { opacity: 1, offset: 0 },
          { opacity: 1, offset: 0.999 },
          { opacity: 0, offset: 1 },
        ],
        { duration: SWOOP_MS, fill: "forwards" },
      ),
    );
    if (leader !== null) {
      this.#running.push(
        leader.animate(
          [
            { opacity: 0, offset: 0 },
            { opacity: 0, offset: 0.999 },
            { opacity: 1, offset: 1 },
          ],
          { duration: SWOOP_MS, fill: "both" },
        ),
      );
    }

    // `fill: "both"` matters here: without it the row would sit at its untranslated
    // position — the whole line stranded across the middle of the screen — for the
    // half second the flight takes.
    this.#running.push(
      row.animate(
        [
          { transform: `translateX(${geometry.fromX}px)` },
          { transform: `translateX(${geometry.toX}px)` },
        ],
        {
          duration: geometry.durationMs,
          delay: SWOOP_MS,
          easing: "linear",
          fill: "both",
        },
      ),
    );

    // Clearing up on a timer rather than on the march's `finish`, for the same
    // reason the sequence is declared up front: a timer fires whether or not the
    // page is drawing. The worst case is a layer that lingers, and the next
    // question cancels it anyway.
    this.#cleanup = setTimeout(() => {
      if (this.#layer === layer) this.cancel();
    }, SWOOP_MS + geometry.durationMs + 100);
  }

  /**
   * Stop and clear up.
   *
   * Called whenever the next question is drawn or the session ends, so a parade
   * can never outlive the answer it was celebrating or overlap the next one.
   */
  /**
   * Stop, clear up, and give the card its emoji back.
   *
   * The emoji coming home is the part worth stating. The alternative — it flies
   * off and the card is left with a hole where the reward was — is what the
   * first build did, and it reads as the prize being taken away rather than
   * taken for a lap. A child who sits and reads the feedback should still have
   * something to look at.
   */
  cancel(): void {
    if (this.#cleanup !== null) clearTimeout(this.#cleanup);
    this.#cleanup = null;
    for (const animation of this.#running) animation.cancel();
    this.#running = [];
    this.#layer?.remove();
    this.#layer = null;

    const borrowed = this.#borrowed;
    this.#borrowed = null;
    if (borrowed === null) return;
    borrowed.style.visibility = "";
    // Fading rather than snapping back, and only when it is still on screen —
    // if the next question has already been drawn there is nobody to fade for.
    if (borrowed.isConnected) {
      borrowed.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: "ease-out" });
    }
  }
}
