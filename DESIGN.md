# Design — Flash Cards

A question-and-answer study game for two kids: **spelling** (spoken word, typed answer) and
**multiplication facts**. Spaced repetition underneath both, per-child progress, runs in a browser
with no backend.

Status: **planning only.** Nothing is built. The repo carries the build toolchain and a placeholder
page so the deployment path is proven end to end, and no application code at all.

This file is the design record and the thing that carries context between sessions. Keep it current
as work lands. When a decision is superseded, **replace it and say it was replaced** — do not stack
a new layer on top and leave the old one to be scanned past.

---

## Who it is for

Two kids, going into **6th and 8th grade** in New Jersey (autumn 2026). Both may be below grade
level in spelling. The useful discrimination range is therefore roughly **grade 3 through early
high school** — the ladder has to reach well below their nominal grade without being condescending
at the start, and well above it so a strong session still has somewhere to go.

A secondary goal the parent asked for: **the game should build typing speed too.** That is not a
side effect to tolerate, it is a wanted outcome, and it shapes the measurement design below.

---

## Scope

**Two games behind a picker**, not one unified game. Spelling and multiplication share the
scheduler, the profile store and the session shell, and nothing else. Mixing the two subjects in a
single session is a possible future feature, deliberately not designed for now.

**No parent view.** The kids see the same progress readout a parent would. There is no separate
authenticated surface, no gating, no hidden metrics.

**No placement test.** Decided in conversation: both kids start at a low band and get easy wins in
the first session. See "Climbing the ladder" for why this costs almost nothing given the scheduler.

---

## Platform and persistence

### The shape

A static site — Vite + TypeScript, no framework — built to plain files and served from **GitHub
Pages**. All state lives in the browser. There is no server, no account, no network dependency at
runtime.

### Why local-only is enough

The deciding question was how many devices need to see the same progress. The answer is **one
family desktop**, so the entire class of cloud-persistence problems (auth, security rules, free-tier
projects that pause after a week of inactivity, API keys in public client code) is avoided rather
than solved.

That is a decision about *today's* requirement, not a bet that it will never change — hence the
storage interface below.

### The storage interface

All persistence goes through one narrow interface, something like:

```
ProgressStore
  load(profileId)   -> Progress
  save(profileId, p) -> void
  listProfiles()    -> ProfileSummary[]
```

**One implementation to start: IndexedDB.** If cross-device sync is ever wanted, a second
implementation (Firestore is the path of least resistance) slots in behind the same interface and
nothing else in the app changes. Do not let storage concerns leak past this boundary — the moment
game code knows it is talking to IndexedDB, the option is gone.

IndexedDB rather than `localStorage`: the progress record is structured and will grow (per-word
history for two kids across thousands of words), `localStorage` is synchronous and string-only, and
the 5MB-ish quota is a real ceiling here. Use a thin wrapper (`idb-keyval` or similar) rather than
raw IndexedDB, which is a famously unpleasant API.

### Storage durability — the part that will bite

**Browsers evict script-writable storage.** Two mechanisms matter, and only one applies here today:

- **Safari's ITP** deletes local storage after 7 days without a visit. Not a concern on a Windows
  desktop, but it is why the PWA decision below is not purely cosmetic.
- **Storage-pressure eviction** applies everywhere including Chrome/Edge on Windows. Best-effort
  storage can be cleared when the disk fills.

Two mitigations, both cheap, both should be built:

1. **Call `navigator.storage.persist()`** on first run. It asks the browser to mark the origin's
   storage as persistent — exempt from pressure eviction. Chrome grants it based on engagement
   heuristics, and an installed PWA is one of the strongest signals. It can be refused; check the
   return value and don't assume.
2. **Export / import as a JSON file.** A button that downloads the whole progress record, and one
   that reads it back. This is the actual backup story and it is the only one that survives a
   reinstalled OS. It is also the manual sync path if a second device ever shows up before a real
   backend does.

### PWA — installable, offline

Ship a web app manifest and a service worker. Two payoffs: a real desktop shortcut and its own
window (which is how the kids should launch it, not by finding a bookmark), and full offline
operation.

**Do not precache the audio.** The word audio will run to tens of megabytes; precaching it makes
install slow and pointless. Precache the app shell and the word lists; cache audio on demand as
words are encountered.

### Running it locally

The kids should not need a dev server. Installing the PWA once gives them an offline app with a
desktop icon, which is strictly better than a terminal window they have to remember to open.

For development, `npm run dev` (Vite on :5173). If a double-clickable local launch is ever wanted
anyway, a `start.cmd` that opens the browser and runs the dev server is a three-line file — but
treat it as a fallback, not the plan.

---

## The scheduler — Leitner boxes

Chosen over SM-2/FSRS deliberately. A real scheduler is more efficient; **Leitner is visible**, and
for children that is worth more. Boxes can be drawn on screen, and moving a word up a box is a
reward in itself. Efficiency is not the binding constraint when the hard part is getting them to
play at all.

### Boxes and intervals

| Box | Next review | Meaning |
|---|---|---|
| 1 | later this session | just missed, or brand new |
| 2 | 1 day | |
| 3 | 3 days | |
| 4 | 7 days | counts as "handled" for frontier purposes |
| 5 | 21 days | |
| 6 | retired | stops appearing; still counted in the readout |

Box 1's "later this session" means re-asked after roughly five other items — near enough to still
be learnable, far enough that it is recall rather than echo.

### Promotion and demotion

Correct → up one box. Incorrect → **down to box 1**.

Straight to box 1 rather than back one box is the classic Leitner rule and is the right default for
spelling, where a misspelling is a genuine gap rather than a slip. **Flagged as tunable**: if it
proves demoralising in practice, "back one box" is the gentler variant. Decide from observation, not
in advance.

### First-exposure fast-track — the thing that makes starting low free

**A word answered correctly on its very first exposure goes straight to box 5, not box 2.**

This is load-bearing and easy to leave out. Without it, a kid starting three grade bands below their
real level has to grind every already-known word up through the full 1→3→7-day ladder, which is
about eleven days per band minimum. Four bands is a month and a half of climbing before the game
ever shows them a word they don't know. That would kill it.

With the fast-track, a band of words the kid already knows clears at roughly one question per word
and never comes back. Only genuinely unknown words enter the Leitner cycle. **Starting low is cheap
precisely because of this rule** — it is what makes "no placement test" a viable decision rather
than a slow one.

---

## Levels

Level is a **per-subject** concept, not a global grade number. The two games ladder along completely
different axes and forcing them into one scale would be arbitrary.

### Climbing the ladder — bands in order, taught to completion

**Bands are worked in order and each is taught to completion. There is no probing ahead.**

An earlier draft drew the pool mostly from the current band plus a ~10-15% probe rate from the band
above, advancing a "frontier" when probes came back correct. **Dropped 2026-08-08**, on the user's
question of how a kid ever actually *learns* a level that way. They don't: probing detects readiness,
it does not teach a band, and the goal here is that every word in a band gets learned.

**The probe was solving a problem the first-exposure fast-track had already solved.** Its purpose was
to avoid grinding through bands below the kid's real level — and the fast-track means those bands
cost roughly one question per word anyway. The first band that *doesn't* clear quickly is their
actual level, discovered by arriving at it. No detection mechanism is needed; the slowdown is the
signal.

**Advance at ~90% of the band in box 4+, not 100%.** Stragglers keep circulating in the review mix
while the next band opens. One impossible word must not be able to block progress, and nothing is
ever abandoned.

There is no re-testing and no visible pass/fail. Show a "you unlocked Grade 5 words!" moment for the
motivation, but the decision behind it is data-driven, not a test the kid has to sit.

### Spelling bands

Grade-banded word lists, roughly grade 2 through early high school. Candidate sources, all freely
available:

- **Dolch sight words** (1936, public domain) — 220 service words + 95 nouns, pre-K to grade 3.
- **Fry's 1000 Instant Words** — banded in hundreds, roughly grades 1-9. Widely reproduced.
- **Scripps "Words of the Champions"** — 4,000 words released free as a PDF, tiered One/Two/Three
  Bee (roughly grades 1-3, 4-5, 6-8). Carries the upper end where Dolch and Fry run out.
- **SCOWL** (Spell Checker Oriented Word Lists) — public domain, bucketed by frequency. Useful as a
  *difficulty proxy* to smooth band boundaries or extend past grade 8.

**Licensing is an open question, not a settled one** — see below. Verify before committing any list
to a public repo.

### Band size — set by the completeness requirement

Because bands are taught to completion, size is a hard constraint rather than a preference.

**Target ~120 words per band.** At the frontier a kid absorbs maybe 10-20 genuinely new words a week,
so a band containing ~50 unknown words is three to five weeks of work — a reasonable cadence for
something called a "level". At 250 words it would be an entire semester and would stop feeling like
one. Below the frontier, ~120 already-known words clear in two or three sessions.

**Split each band into units of ~20-25 words** — "Grade 5, set 3 of 5". Three to five weeks is far
too distant a finish line for a child; the unit is the milestone they should actually see.

A band is a *representative sample* of a grade's difficulty, not complete coverage of what that grade
teaches. 120 words is ample both to place a kid and to be worth learning.

**Total corpus: roughly grade 2 through grade 10, so ~9 bands, ~1,100 words.** Note this is far
smaller than the 4,000-word figure an earlier draft assumed. The completeness requirement *shrinks*
the corpus rather than growing it, which also makes the audio pipeline substantially cheaper and the
licensing research narrower.

### Multiplication buckets

Not grades. Four buckets, ordered by how they are actually taught:

| Bucket | Facts |
|---|---|
| A | ×0, ×1, ×2, ×5, ×10 |
| B | ×3, ×4 |
| C | ×9, then ×6, ×7, ×8 |
| D | ×11, ×12 |

**`a×b` and `b×a` are the same fact for scheduling purposes**, presented in both orders. Treating
them separately doubles the deck for no learning gain — 12×12 is 169 ordered pairs but only 91
distinct facts.

**Completeness needs no discussion here.** 91 distinct facts across four buckets is ~20-25 each,
which is already the unit size the spelling bands have to be deliberately chopped down to reach. A
bucket *is* a unit.

For the 8th grader this is likely all fluent already, so the fast-track will clear it fast and the
real value there is the **timed fluency** mode rather than learning. If the subject turns out to be
exhausted, the natural extensions are squares past 12, or division facts as the inverse.

---

## Timed and untimed — what the data actually support

The parent asked for a mix so that spelling ability can be told apart from recall speed and typing
speed. An earlier draft proposed decomposing an answer into *latency to first keystroke* (retrieval)
and *characters per minute thereafter* (typing).

**That decomposition was wrong and is dropped** — the user's objection, 2026-08-08: a fast first
letter followed by a slow finish is just as likely to mean the first letter was obvious and the rest
was not. The pause that reveals ignorance is usually *inside* the word, not before it. Splitting at
the first keystroke assumes retrieval completes before typing begins, and for spelling it plainly
does not.

So: **record what is observed, and infer nothing.** Did they get it right, and how long did it take.

### Correctness schedules; time is only reported

**Time never feeds the scheduler.** A word moves between boxes on whether it was spelled correctly
and on nothing else. Elapsed time is a *reported metric* — shown to the kid, trended across sessions
— with no influence on what gets asked next. That keeps a motor-skill problem out of the learning
signal, and it is simpler than the asymmetric rule it replaces.

One rule survives from that draft: **a timed miss does not demote.** Time pressure produces errors
on words a kid genuinely knows, so a wrong answer against the clock is not evidence of a gap. Only
untimed results push a word down.

### Store the keystroke timeline anyway

Capturing per-keystroke timestamps costs nothing — the input events are already there — and storing
them keeps every later analysis open. If the interval *shape* turns out to be informative (the
plausible version: median interval as typing rate, longest pause as where they hesitated, wherever
in the word that falls), it can be computed later from data already collected.

**The asymmetry that justifies it: timings not recorded cannot be recovered, and timings recorded
but unused cost a few bytes.** Build no inference on top of them until there is a reason. This is
storage, not a feature.

### Typing speed as a goal

Typing practice is a wanted outcome, so it needs a number the kid can watch go up. Use **correct
characters per minute across a whole session**, not anything per-word — it is what typing tutors
use, it is robust to one slow word, and it requires no separation of retrieval from typing.

### Which mode when

**The timing mode follows the box.** Low-box words (still being learned) are asked untimed; box 4+
words (effectively known) are asked timed as a fluency check. Plus an explicit "speed round" the kid
can choose. The clock lands only on words where speed is the remaining thing to improve, with no
mode switch anyone has to think about.

**Never show a clock in untimed mode**, and don't score against time invisibly either.

One confound to stay alert to: for the younger kid, spelling accuracy will be entangled with typing
ability regardless of mode. If that shows up, letter tiles or a click-to-build input is the remedy
for low bands.

---

## Audio

Spelling questions are spoken. Decided: **use real human recordings where they exist, synthesis as
the fallback.**

### Source: Wikimedia

**Lingua Libre** (a Wikimedia project of volunteer-recorded single words, CC-BY-SA, bulk
downloadable) plus the older `En-us-*.ogg` pronunciation files on **Wikimedia Commons** that
Wiktionary uses. Explicitly redistributable with attribution, which is what rules out the
alternatives — Forvo's licensing is restrictive, and Merriam-Webster's API audio is better quality
but its terms don't clearly permit bundling into a public repo.

Quality varies word to word, since these are volunteer recordings in assorted accents. That is the
price of the licence, and it is the direct reason for the blacklist feature below.

### Fetched at build time, not at runtime

The word list is fixed, so **none of this happens in the browser.** A build-time script fetches the
recordings once, transcodes to MP3 or M4A, and commits the result. Consequences worth stating:

- No API key ever ships to the client.
- No network call during a question — the audio is a static asset the service worker can cache.
- **Transcoding is not optional.** Commons files are largely Ogg Vorbis, which Safari has
  historically not played. MP3 removes an entire class of platform bug for one build step.

Rough size: ~1,100 words at ~15KB is under 20MB — comfortable for a Pages repo. Small enough that
precaching becomes arguable, but the PWA note still stands: cache on demand, since nothing needs
grade 9 audio on a device working through grade 4.

**Store multiple recordings per word where Commons has them.** This is what makes the blacklist
degrade gracefully instead of falling straight to synthesis.

### "I can't understand it" — the blacklist

The kid gets a button on any spoken word meaning *this recording is unintelligible*. The word is
re-asked with the **next available recording**; when those run out, with **speech synthesis**.

The blacklist is stored in the progress record (there is nowhere else to put it without a server).
Open question: whether a blacklist is per-child or shared. A bad recording is objectively bad, which
argues for shared — but one kid's "can't understand it" may be the other's fine. Shared is the
simpler default; revisit if it causes friction.

This feature exists because volunteer recordings *will* include some duds, and without an escape
hatch a single bad file makes a word permanently unanswerable.

### Cloze sentences — the homophone answer

A bare spoken word cannot disambiguate `their`/`there`/`they're`, `to`/`too`/`two`,
`principal`/`principle`. Real spelling bees solve this by speaking a sentence; the parent's
suggestion — **show a sentence on screen with the target word blanked out** — is better here,
because it needs no additional audio and it reads naturally as part of the question.

Source candidate: **Tatoeba**, a CC-BY sentence corpus with millions of English sentences and bulk
downloads, filtered for short simple sentences containing the target word. Selected at build time
alongside the audio.

**This needs a content filter and that is not optional.** Tatoeba is crowd-sourced and contains
adult material. Filtering by length and vocabulary simplicity will remove most of it incidentally,
but a deliberate blocklist pass and a spot-check of the committed output are both required before
this ships to children. Treat an unfiltered corpus reaching the kids as a defect, not a surprise.

If Tatoeba proves unworkable, hand-writing sentences for just the homophone set is a manageable
fallback — that list is short, and homophones are the only case where the sentence is strictly
necessary rather than merely helpful.

### Attribution

Lingua Libre and Commons audio are CC-BY-SA; Tatoeba is CC-BY. Both require attribution. The app
needs an attributions page listing sources and contributors, generated by the same build script that
fetches the assets — hand-maintaining it will not survive the first re-fetch.

Note the split: **the code's licence is not the data's licence.** MIT code, CC-BY-SA data, both in
one repo, each labelled.

---

## What gets stored

Per profile (one per child):

- **Profile**: id, display name, created date.
- **Per-subject level state**: current band/bucket, frontier position.
- **Per-item scheduling state**: box, due date, times seen, times correct, last result. Keyed by
  word, or by the normalised `min×max` form for multiplication facts.
- **Performance history**: per attempt — the result, the elapsed time, and the keystroke timeline.
  **Cap it.** Keystroke timelines grow without bound and nothing needs three years of them; a rolling
  window of recent attempts plus retained per-session aggregates is the shape.
- **Audio blacklist**: recording ids the kid could not understand.

The word lists and audio are **build artefacts, not user data** — they ship with the app and never
enter the progress record. Only references to them do. This matters for the export file: it should
be small enough to email, which it is not if it embeds the corpus.

---

## Repo and deployment

- Repo: [CaptainChocolatedessert/flash-cards](https://github.com/CaptainChocolatedessert/flash-cards), public
- Local: `C:\Users\order\Documents\Claude\Projects\W - flash-cards`
- Pages: <https://captainchocolatedessert.github.io/flash-cards/>
- **Public because free-tier Pages requires it.** No progress data lives in the repo, so this costs
  nothing in privacy — but it is why the licensing questions above have to be answered honestly
  rather than waved through.

**Pages builds from GitHub Actions**, not branch-deploy. `.github/workflows/deploy.yml` runs on push
to `main`: tests, builds, publishes `dist/`. Requires Settings → Pages → Source: "GitHub Actions".
Set up this way from the start deliberately — the sibling project had to migrate branch-deploy →
Actions once Vite landed, and there is no reason to repeat that.

**Pushing deploys.** Get separate confirmation before pushing.

### The subpath

Project Pages serve from `/flash-cards/`. `vite.config.ts` sets `base` accordingly, and Vite
rewrites it into the built HTML. Anything in `public/` is copied verbatim and is **not** rewritten —
so a manifest, a service worker registration path, or any hardcoded asset URL there is a manual copy
of the same string. Nothing in `src/` should hardcode it; build paths from `import.meta.env.BASE_URL`.

**The service worker's scope must match the subpath** or offline will silently not work. This is the
single most likely thing to be wrong on first deploy.

### `.nojekyll`

Present at the repo root and in `public/` (so it survives into `dist/`). Pages runs Jekyll by
default, which silently discards files and directories beginning with `_`. Vite build output will
eventually contain some.

---

## Stack

- **Vite + TypeScript**, no framework to begin with. The sibling project reached a real settings UI
  in plain TS and never wanted React; start the same way and revisit if the UI becomes stateful
  enough to earn a framework.
- **vitest** for the pure logic. The scheduler, the frontier advance rule, the fact normalisation
  and the band assignment are all pure functions with no DOM and no storage, and they are where the
  bugs will be. Keep them importable without a browser.
- Node 24 / npm 11.

**After adding any dependency**, regenerate the lockfile rather than accreting it:
`rm -rf node_modules package-lock.json && npm install && npm ci`. Incremental installs resolve
optional dependencies for the current platform only, which passes on Windows and fails on the Linux
CI runner.

---

## Open questions

1. **Word list licensing.** Dolch and Fry are safe. **Scripps "Words of the Champions" is free to
   download but that is not the same as free to redistribute** — read the terms before committing
   it to a public repo. If it is not redistributable, the fallback is a frequency-derived ladder
   from SCOWL, which is public domain but a cruder proxy for grade level.
2. **Sentence corpus filtering.** How aggressively, and verified how. Blocking condition for the
   cloze feature.
3. **Blacklist scope** — per-child or shared. Shared is the default; unresolved.
4. **Demotion severity** — box 1 or back one box. Decide from watching them play.
5. **Custom weekly lists.** No parent view was wanted, but "type in this week's actual spelling list
   from school" is the feature most likely to be asked for later. It has no recordings and no cloze
   sentences, which makes speech synthesis load-bearing again rather than a fallback. Not designed
   for; worth not painting into a corner.
6. **Band boundaries.** The ~120-word band size is settled; *which* words land in which band needs
   real lists in hand. Expect the published grade labels to disagree with each other at the seams.
7. **Mixing subjects in one session.** Wanted eventually, deliberately unplanned.

---

## Build order

Nothing below is started.

0. **Repo, toolchain, Pages deploy.** Done — placeholder page only, no application code.
1. **The pure core, tested, with no UI.** Leitner scheduler, first-exposure fast-track, band advance,
   multiplication fact normalisation. This is where correctness lives and it is entirely headless.
2. **`ProgressStore` over IndexedDB**, plus profile create/select, plus JSON export/import. Prove
   persistence survives a browser restart before building anything on top of it.
3. **Multiplication game end to end.** Chosen before spelling deliberately: it needs no audio, no
   corpus and no licensing research, so it exercises the scheduler, the store, the session shell and
   the readout against the simplest possible content. Everything it proves, spelling reuses.
4. **Word lists.** Acquire, verify licensing, band them, commit. Blocking on open question 1.
5. **Audio pipeline.** Build-time fetch, transcode, attribution generation. Speech-synthesis
   fallback first so the game works before the corpus exists.
6. **Spelling game**, including the blacklist button.
7. **Cloze sentences.** Last because it is the only part gated on a content-filtering problem, and
   the game is fully playable without it for every non-homophone word.
8. **PWA** — manifest, service worker, `navigator.storage.persist()`, install prompt.
9. **Progress readout.** Boxes, bands, accuracy, latency and typing-rate trends.

The ordering principle: **prove the scheduler and the store with the content type that has no
external dependencies**, then add the content type that has several.
