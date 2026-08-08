# Design — Flash Cards

A question-and-answer study game for two kids: **spelling** (spoken word, typed answer) and
**multiplication facts**. Spaced repetition underneath both, per-child progress, runs in a browser
with no backend.

Status: **the multiplication game is playable end to end** (`src/core/`, `src/storage/`, `src/game/`,
`src/ui/`, 123 tests). Pick a child, play times tables, and the boxes, the estimator and the archive
all move; progress persists across a browser restart and can be exported to a file and restored from
it. Spelling has no content and no game yet, and no progress chart is drawn for either subject.
Build order step 3 of 9 done; step 4 is acquiring the word lists, which is blocked on the licensing
question.

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

**No placement test.** Decided in conversation: both kids start easy and get wins in the first
session. Proficiency is inferred continuously from ordinary play instead — see "Progression".

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
| 4 | 7 days | effectively known; timed from here on |
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

### First-exposure fast-track — an already-known word costs one question

**A word answered correctly on its very first exposure goes straight to box 5, not box 2.**

Load-bearing, and easy to leave out. Without it, every already-known word has to be ground up through
the full 1→3→7-day ladder — eleven days minimum before it stops being asked — and a kid working
below their level would spend weeks re-proving vocabulary they already have. That would kill it.

With the fast-track, an already-known word costs about one question and never comes back. Only
genuinely unknown words enter the Leitner cycle. **This is what makes "no placement test" a viable
decision rather than a slow one**, and it is also what lets the introduction weighting afford the
occasional wasted probe into an easy grade.

It has a second role in the progression model: a first-exposure result is the *only* kind that
carries information about a grade, so the fast-track and the proficiency estimator read the same
event. Neither should be changed without checking the other.

---

## Progression — a proficiency profile, not a ladder

**Levels are gone.** No bands, no units, no advancing, no unlocking. **Superseded 2026-08-08** by the
user's reframing, which is better and which dissolves rather than solves the problem the ladder kept
running into.

### The reframing

**The Leitner boxes already decide what to review.** Everything a kid has met is scheduled by its
box, and that machinery needs no concept of level at all. So the only question a progression system
actually has to answer is:

> **Which new words should enter the queue next?**

That is a much smaller question than "what level are they on", and it does not need the word list
carved into bands to answer it. Two prior designs — the probing frontier, then sequential bands
taught to completion — were both attempts to make a ladder produce that answer. The ladder was never
the requirement.

**Explicitly rejected: capping the word list to make progression tracking feasible.** That is putting
the measurement in front of the task (the user's phrase, and the right call). The ~120-word band cap
from the previous draft is dropped; the corpus should be as large as can be sourced. See "Costs" at
the end of this section — this is not free.

### Estimating proficiency per grade

Track, per child, an estimate of **the probability they would correctly spell a word they have never
seen before, at each grade level.** That is the quantity the whole system needs, and it is what the
display shows.

**Estimate from first-exposure results only** — the starting position, not a settled one.

The reasoning for it: once a word is in the box system, getting it right tells you about *that word's
rehearsal state*, not about underlying grade-N ability. Feeding review outcomes into the estimator
would make every grade drift toward 100% as words got learned, and the chart would report practice
history instead of ability while looking entirely plausible.

**The user's objection, 2026-08-08, and it is a real one:** learning words at a level may *transfer*
to unseen words at that level, because what is being learned is partly a generalisable pattern
(orthographic conventions, morphology, common roots) rather than a set of unrelated facts. If so,
true ability at a grade genuinely rises as words there are learned. But some words are simply
irregular and teach nothing beyond themselves, so transfer is at best partial. **Which of those
dominates is a pedagogical question nobody here knows the answer to** — see open question 9, where
it is parked for research rather than guessed at.

**One consequence is clear enough to build on now: the rating must keep moving, not converge.** A
conventional estimator of a *fixed* quantity shrinks its update size toward zero as data accumulates.
If ability at a grade genuinely rises with learning, that is exactly wrong — the estimator would lock
onto a stale value and the chart would go flat while the kid kept improving. Keep the update size
floored so the estimate tracks a moving target. This is the right call under either answer, since a
child's ability is not static regardless of why.

Note the estimate is self-consistently about *untried* words, which is the quantity needed for
deciding what to introduce.

#### The small-sample problem, and the way through

Early on there will be a handful of data points per grade, and a bar computed from three answers
must not look as authoritative as one computed from two hundred.

**Use one latent ability estimate plus per-grade difficulty, rather than twelve independent
counters.** An Elo-style rating is the pragmatic form: the child carries a rating, each grade carries
a difficulty, the predicted success probability is the logistic of the difference, and every
first-exposure answer nudges the rating by an amount proportional to how surprising it was. This is
essentially online Rasch estimation, and it has three properties that matter here:

- **Every answer informs every grade.** A miss at grade 7 lowers the whole curve, so grades with
  little direct data still get a sensible estimate.
- **The profile is monotone by construction** — higher grade, lower predicted success — which is
  almost always true and is exactly the prior worth encoding.
- **It is online.** No batch fitting, no history replay, one number to store.

**Allow per-grade deviation from the pooled curve only as evidence accumulates.** A kid can be
genuinely non-monotone — strong on technical vocabulary, weak on common irregulars — and a pure
single-parameter model cannot express that. The principled version is hierarchical shrinkage: each
grade gets a residual that starts pinned at zero and is allowed to move as its own sample grows.

**Built that way directly**, rather than pooled-first with residuals added later as an increment.
Shrinkage makes the staging unnecessary: a grade's residual is multiplied by how much of its own
evidence exists, so with no samples it contributes exactly nothing and the model *is* the pooled one.
There is no second version to write. A slow decay pulls each residual back toward zero as well,
which is what stops the shared ability and the per-grade offsets from drifting into an
indistinguishable pair — they are otherwise not separately identifiable.

**Track uncertainty and show it.** A grade with few samples should render faded or with a visible
interval. A confident-looking bar built from nothing is the same class of error as a diagnostic that
cannot distinguish its outcomes.

#### What the floored update actually costs — measured, 2026-08-08

Building it surfaced a consequence of the floor that was not obvious when the floor was decided: **a
filter that never stops moving never stops wobbling.** Its resting spread is `sqrt(step / 2I)`
logits, where `I` is the information one answer carries (about 0.2 near the operating point). That is
a permanent noise floor on the estimate, and it is the price of tracking a rising ability.

Measured against simulated children over thirty seeds, an update floor of 0.12 left the estimate
wandering by up to half a logit even after six hundred answers — enough to shift the introduction
zone by a whole grade between sessions for no reason. **The floor is now 0.05**, which cuts the
wobble to about 0.35 logits while still crossing two logits of genuine improvement in a few hundred
first exposures. Both ends of that trade are real: raise it and the chart is visibly noisy week to
week, lower it and a child's actual progress takes a term to appear.

**The reported interval has to include that wobble, not just the sample count.** Otherwise the bars
tighten with experience while the value underneath them keeps jumping around — a bar that looks
certain and is not. So the interval is the wider of two things: ordinary lack of data early on, and
the filter's own restlessness thereafter. It has a floor it never goes below, which is correct.

If the chart still reads as jittery in practice, the remedy is to display a smoothed ability
alongside the fast one used for updating. Not built: the chart and the introduction weighting must
read the *same* number, and smoothing the number that feeds back into item selection is a change
worth making deliberately rather than as a display tweak.

### Choosing where new words come from

Weight each grade by **how much value a new word from it would have**, and sample the introduction
pool from that distribution.

The weight is a **peaked function of the estimated success probability** — near zero where the kid
is already proficient (nothing left to teach) and near zero where they are far out of their depth
(nothing but frustration), with the mass concentrated where they are actually learning. A Gaussian
bump in probability space is enough: one parameter for where the peak sits, one for how wide it is.

#### Where the peak belongs, and why it is not 50%

Two pressures point in opposite directions, and the target is the compromise:

- **Learning value peaks at a low success rate.** A word answered correctly on first exposure teaches
  nothing — the fast-track retires it immediately. Only words the kid gets *wrong* enter the Leitner
  cycle and get learned. Pure information-efficiency would introduce words they will almost certainly
  miss.
- **Morale peaks at a high success rate.** A stream of failures is how a kid stops playing.

**Start the target around 70% predicted success** and expect to tune it. High enough that most of a
session feels like competence, low enough that roughly one introduction in three is a word they
actually needed. This is a knob, not a finding — it should be revisited after watching them play.

**The width of the bump has to be narrower than it first looks**, and the reason is worth recording
because it is easy to get wrong twice. The bump is measured in *probability*, but the logistic is
flat near its ends, so several grades a child has effectively mastered all pile up together at 85-90%
predicted success. At a width of 0.15 they collectively took about a fifth of all introductions. At
0.12 that tail is small without vanishing — and it should not vanish, because the fast-track makes a
probe into an easy grade cost one question, which is exactly what buys the occasional cheap check
that a grade is still solid.

### How many new words — a separate question

Keep **volume** and **mix** apart. The weighting above decides *where* new words come from; it should
not also decide *how many*.

**Gate introductions on unfinished business: count the words currently sitting in boxes 1-2, and
introduce new ones only while that count is below a ceiling.** A kid with thirty words churning in
the low boxes does not need more; they need to finish those. Without this governor a run of misses
at the frontier compounds — misses put words in box 1, and a system that keeps introducing regardless
buries them.

**The ceiling is 15 to start with.** A guess of the same kind as the 70% target, and it will show
itself wrong in an obvious direction: too low and sessions run out of new material and turn into pure
drill; too high and the kid is drowning in half-learned words.

#### A second gate, found by building it — 2026-08-08

The ceiling turned out not to be enough on its own, and the reason is worth recording because it is
invisible on paper.

A missed item goes back into the running session *about five questions later*. With introductions
gated only on the ceiling, a session that starts from nothing introduces one item, the child misses
it, and "five questions later" in a queue holding nothing means **immediately** — the same fact,
straight back, which is echo rather than recall and is precisely what box 1 is defined to avoid.

So the session keeps a small buffer of upcoming questions topped up — one more than the reinsert gap
— and introduces to fill it. That guarantees there is always something to put between an item and
its repeat.

It is a *tighter* gate than the ceiling, and it binds in the case that matters: a child getting
everything wrong ends up cycling around six unknowns instead of being handed fifteen. The ceiling
still binds when reviews are plentiful. Both are wanted; neither replaces the other.

**Consequence, also found by building it: introductions run ahead of the child, so a session that
ends mid-queue leaves items that were introduced and never actually asked.** Left in the record they
are phantoms — they count as met, they show in the readout as "just learning", and they count toward
the low-box total, so the governor throttles introductions because of material the child has never
seen. They are therefore **dropped when the session closes**, restoring the invariant the rest of
the system assumes: an item in the record is one the child has actually met. Nothing is lost — they
go back to being unseen and can come round again next time.

### The kid's difficulty control

The user asked for a way for the kids to say they want harder or easier words. **This maps to exactly
one thing: it shifts the target success rate.** Lower target, harder words.

Elegant because it makes the control genuinely meaningful rather than cosmetic, and because it needs
no new machinery. **Label it "harder"/"easier", never expose the number** — the direction is
inverted (a *lower* success target means *harder* words) and that is a guaranteed source of
confusion.

### The display

A **bar chart across grade levels, showing estimated probability of getting a new word right.** The
user's suggestion, and it is the natural readout for the model above — the thing the system computes
is the thing the kid sees, with no translation layer.

Two additions worth building:

- **Render uncertainty**, per the estimator note above.
- **Mark the zone new words are currently coming from.** Then the chart shows both what they know and
  where the game is working, which makes the difficulty control legible — move the slider, watch the
  highlighted zone shift.

**One thing the ladder had and this does not: a discrete moment of celebration.** "You unlocked Grade
5!" has no equivalent when nothing unlocks. Replace it with milestones fired off the chart — a grade
crossing 80%, a personal best — rather than letting the reward disappear.

### Costs of dropping the cap

Stated plainly, because the previous draft claimed the opposite as a benefit:

- **The corpus goes back to thousands of words**, not ~1,100. Audio returns to roughly 60MB, and the
  licensing research covers the full lists rather than a subset.
- **Grade labels are still required** — the chart and the weighting are both indexed by grade. So the
  sourcing work is unchanged in kind, only larger.

One genuine improvement, though: **label noise at the seams stops mattering.** The ladder was brittle
at band boundaries because progression gated on them. Here a mislabelled word slightly perturbs one
estimate and nothing else. A later refinement, if the data ever justifies it, is letting the Elo
learn per-word difficulty and correct the published labels — plausible over a year with two kids,
not a plan.

### Multiplication is exempt from the *ladder*, not from the weighting

**Load the whole table to 12 at once and let Leitner handle it.** There are no bands to climb and
nothing to unlock: all 78 facts are eligible from the first session, and the volume governor is what
stops them all landing in box 1 at once.

**Amended 2026-08-08, when the game was built.** The original wording said multiplication needed no
introduction policy at all, on the grounds that building one for 78 facts would be machinery in
search of a problem. That was about *building* it. The weighting already exists and is generic over
bands, so the real choice at build time was between using it and inventing a second, worse ordering
for picking which unseen fact comes next. It is used. Two reasons: a fixed order would have to be
either arbitrary (12×12 before 2×3 for a struggling child) or a hand-made easy-to-hard sequence,
which is a ladder by another name; and the harder/easier control is defined as a shift in the target
success rate, so without the weighting that control would do nothing at all in this game.

Same reasoning as the estimator being shared between the two subjects: writing it twice would have
been duplication, not separation.

**`a×b` and `b×a` are the same fact for scheduling**, presented in both orders. 1-12 is 144 ordered
pairs but only 78 distinct facts, and treating them separately doubles the deck for no learning gain.

**Corrected 2026-08-08**: this said 91 of 169, which is the count for 0-12. The 0s are not drilled
and there is no 0s bar on the chart, so the range starts at 1 and the deck is 78.

**Track proficiency by times table — 1s, 2s, 3s … 12s.** Twelve bars, parallel to the spelling grade
chart, so the two games' progress displays read as siblings. A fact belongs to two tables (7×8 counts
toward both the 7s and the 8s); count it in both for the chart, keep it single for scheduling.

**As built, the two subjects do share the estimator.** The earlier note that they should share
"nothing else" beyond scheduler, store and session shell has been relaxed: the estimator turned out
to be generic over a set of *bands* with per-band difficulties, and school grades and times tables
are both just band sets. Two instances, two difficulty tables, one piece of code. Writing it twice
would have been duplication, not separation.

**A first-exposure result is credited to the larger factor's table.** The estimator takes one band
per event and a fact spans two, so 7×8 informs the 8s — the harder of the two is the one the child
was actually up against. The chart's *counts* still show the fact under both tables.

The starting difficulty prior for the tables is the conventional ordering — 1s, 2s, 5s and 10s nearly
free, 6s through 9s and the 12s where children stall. It is not derived from these children, and the
per-band residuals exist to correct it.

For the 8th grader this is likely all fluent already, so the fast-track will clear it quickly and the
real value is the **timed fluency** mode rather than learning. If the subject is exhausted, the
natural extensions are squares past 12, or division facts as the inverse.

### Spelling word lists — resolved 2026-08-08

**The finding that decides everything: no grade-labelled spelling list can be licensed, because the
grade labelling is exactly what publishers sell.** New Jersey publishes no statewide word list; the
NJSLS-ELA define *skills* per grade ("recognize and read grade-appropriate irregularly spelled
words", "spell grade-appropriate words correctly") and leave the words to districts. Common Core
does the same by design. The only words the standards enumerate are ten kindergarten examples. So
districts adopt a commercial program — in New Jersey overwhelmingly Wilson Fundations, copyrighted —
and every graded list that exists is somebody's product.

#### What was checked, and what it said

- **Scripps "Words of the Champions"** — **cannot use.** No permission grant in the PDF's front
  matter or on the study-list page, which carries only "© The E.W. Scripps Company. All rights
  reserved." It is not even freely downloadable: teachers at enrolled schools log in, everyone else
  buys the book. Under *Feist* (1991) the individual words are unprotectable facts, but the
  **selection** of 4,000 words out of Merriam-Webster Unabridged and their sorting into three tiers
  is the original selection-and-arrangement that carries a thin compilation copyright — and copying
  the list whole is the central case that thin right covers.
- **Fry's 1000 Instant Words** — **cannot use.** A modern published work, most cited from Fry's 1996
  book, with no permissive terms. Ubiquitous photocopying in schools is tolerance, not a licence,
  and a PDF hosted by a school district licenses nothing. If high-frequency words are wanted, derive
  a ranking from a licensed frequency source instead of copying Fry's.
- **Dolch (1936)** — **low risk, but not verified.** Universally treated as public domain; no
  renewal record found either way, and a renewed 1936 work runs to 2031. 220 words chosen by raw
  frequency is about as thin as a compilation claim gets, so the practical risk is small. Recorded
  as low-risk-unverified rather than public domain, because those are not the same claim.
- **SCOWL / English Speller Database** — **usable.** MIT-like: "Permission to use, copy, modify,
  distribute and sell these word lists... for any purpose is hereby granted without fee", conditional
  on preserving copyright notices. Some bundled components add conditions (the UK Advanced Cryptics
  Dictionary requires its notice verbatim; WordNet requires its notices kept), so it needs a bundled
  notices file — which the audio pipeline was already going to generate.
- **SUBTLEX-US** word frequencies — **usable**, CC-BY-SA.
- **Kuperman et al. age-of-acquisition norms** — usable (CC-BY-4.0 via NoRaRe) but **rejected as the
  difficulty signal.** Raters were asked for the age they would have *understood* a word "if somebody
  had used it in front of you, EVEN IF YOU DID NOT use, read or write it at the time." That is
  receptive spoken vocabulary, which is close to the worst-matched signal available for a game about
  typing words correctly. The user caught this; it is recorded because it is an easy mistake to make
  twice.

#### The decision

**Use a written list rather than a copied one, and grow it.** The seed is a K-8 bank of ~1,145 words
built in an earlier session against the NJSLS skill progression: Dolch for K-3, and for grades 4-8
sets written around what the standards actually name at each grade — homophones, `-tion`/`-sion`,
irregular plurals, prefixes and suffixes, Greek and Latin roots, academic vocabulary, and
frequently-misspelled words. Nothing in grades 4-8 is transcribed from any published program, which
is what makes it usable at all.

It is not sufficient as it stands, and the gaps are the build work:

- **Only ~830 words sit in grades 4-8**, which is the range that matters for a 6th and 8th grader.
  The K-3 portion is Dolch *reading* sight words (`the`, `said`, `look`) — the fast-track will clear
  those in a session or two, which is correct behaviour but leaves the effective corpus small against
  a design that dropped a word cap specifically to get thousands.
- **It stops at grade 8**, so the older child has no headroom. The design calls for reach into early
  high school.
- **The grade assignments are one model's judgement and are unvalidated.** This matters far less than
  it would have under the old ladder: a mislabelled word now perturbs one estimate slightly, and the
  per-band residuals exist to correct a systematically wrong prior.

**How to grow it: use the written list as calibration anchors for a computed difficulty model.** The
curated words give grade-anchored points; frequency (SCOWL, or SUBTLEX if share-alike is acceptable)
plus computed orthographic irregularity — how unpredictable a word's spelling is from its sound, from
a pronunciation dictionary — can then place thousands more words on the same scale, and extend it
past grade 8. That marries the two halves honestly: the anchor comes from human judgement about
grades, the reach comes from computation, and neither copies anyone's list.

**What the chart may honestly claim.** The grade labels mean "organised around the skills New Jersey
names at that grade", not "New Jersey expects a sixth-grader to spell this" — nobody publishes the
latter in usable form. The distinction belongs somewhere in the app, because the chart is what gets
read to answer "is she behind?", and a bar labelled *Grade 6* that corresponds to no real grade-6
expectation is the same class of error as a diagnostic that cannot distinguish its outcomes.

**Note the split that remains:** the code's licence is not the data's licence. MIT code, CC-BY-SA
audio, and a word list that is ours except for the Dolch portion — each labelled.

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
for the easiest words.

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

Rough size: a few thousand words at ~15KB is on the order of 60MB. Fine for a Pages repo (the soft
limit is 1GB) but firmly in the territory where the PWA note applies: **cache on demand, never
precache.** Most of that corpus will never be reached by either child.

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
- **Per-subject proficiency state**: the ability rating, per-grade (or per-times-table) residuals and
  their sample counts, and the kid's difficulty-control setting.
- **Per-item scheduling state**: box, due date, times seen, times correct, last result. Keyed by
  word, or by the normalised `min×max` form for multiplication facts.
- **Performance history**: per attempt — the result, the elapsed time, and the keystroke timeline.
  **Cap it.** Keystroke timelines grow without bound and nothing needs three years of them; a rolling
  window of recent attempts plus retained per-session aggregates is the shape. **As built: 500
  attempts and 1,000 session summaries per subject per child.** The attempt number is set by the
  export file having to stay emailable — at roughly 300 bytes an attempt it is about 150KB per
  subject per child. Summaries survive the trim, so the long-run trends do not depend on the window.
  Each stored attempt also carries which band it came from and whether it was a first exposure,
  without which the archive would not support the recomputation it exists to make possible (open
  question 9).
- **Audio blacklist**: recording ids the kid could not understand. **Stored outside any profile**,
  since the current default is that it is shared — see open question 3.

Every stored record carries a **schema version**, and so does the export file. Nothing needs
migrating yet; the point is that the first incompatible change has something to key off instead of
having to infer what it is looking at. A file from a *newer* version is refused rather than read on
a best-effort basis.

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
- **vitest** for the pure logic. The scheduler, the proficiency estimator, the introduction weighting
  and the fact normalisation are all pure functions with no DOM and no storage, and they are where
  the bugs will be. Keep them importable without a browser. The estimator in particular is worth
  testing against *simulated* children — a synthetic kid with a known true ability, checked for
  whether the estimate converges to it — since that is the only way to know it works before a real
  child has generated a year of data.
- Node 24 / npm 11.

**After adding any dependency**, regenerate the lockfile rather than accreting it:
`rm -rf node_modules package-lock.json && npm install && npm ci`. Incremental installs resolve
optional dependencies for the current platform only, which passes on Windows and fails on the Linux
CI runner.

---

## The core, as built

A map, not a second copy of the reasoning — the *why* for everything below is in the sections above,
and if the two ever disagree the sections above are the ones that were argued.

Everything lives in `src/core/`, is pure, and imports nothing from the DOM or from storage. Each
module keeps its tuning constants at the top of its own file, commented with what moving them costs;
that is the one place to look for a knob, and the numbers are deliberately not repeated here.

- **`types.ts`** — the shared vocabulary. A box, a timing mode, one attempt, one item's scheduling
  state, and a band (a grade for spelling, a times table for multiplication).
- **`scheduler.ts`** — the Leitner ladder. Box intervals, promotion and demotion, the first-exposure
  fast-track, whether a question is asked against the clock, what is due now, where a missed item
  goes back into the running session, and the box counts the governor and the readout both need.
- **`proficiency.ts`** — the estimator. The child's ability, each band's difficulty and residual, the
  predicted chance on an unseen item, and the interval around it. Also the two band sets: grades for
  spelling, times tables for multiplication.
- **`introduction.ts`** — what to introduce and how much of it. The weighting over bands, drawing
  from it, which bands the chart should highlight as active, the harder/easier control, and the
  volume governor.
- **`multiplication.ts`** — facts. Normalising `a×b` and `b×a` to one item, the deck, which tables a
  fact counts toward, and which band a first exposure is credited to.
- **`rng.ts`** — a seedable random source, injected rather than reached for, so anything that samples
  can be tested.

**Tests sit beside each module.** The estimator's are the ones worth knowing about: a synthetic child
with a known true ability, answering by coin flip, checked both for settling on a fixed ability and
for following one that rises mid-run — each across several seeds, because a single seed passing says
nothing. The tolerances are set above the worst case of a thirty-seed sweep.

**What those tests do not prove.** The simulated child answers according to the same model the
estimator assumes, so they establish that the machinery converges and tracks. Whether the model
describes a real 12-year-old is a different question, and it is open question 9.

---

## The storage layer, as built

Everything lives in `src/storage/`. The record shapes are in one file, the interface and the pure
record-manipulating functions in another, the IndexedDB implementation in a third, and the export
file's reader and writer in a fourth. `src/main.ts` is the **only** file that names the IndexedDB
implementation; everything else takes the interface, which is what keeps a different implementation
a drop-in rather than a rewrite.

**Profiles are found by scanning keys, not from a separate index.** An index would be one fewer read
and a second copy of a fact that can drift — a profile that exists but is not listed, or is listed
and is not there. At two children the scan is free, so the failure mode is worth more than the read.

**The export file is everything, not one profile.** It is the backup that has to survive a wiped
machine, and a backup that silently omits the other child is worse than none. Restoring offers two
modes: *replace*, which makes the database match the file and deletes anything not in it, and
*merge*, which matches profiles by id and keeps whichever was **written most recently**. The merge
is deliberately whole-record rather than field-by-field — reconciling two divergent box states for
the same word has no correct answer without knowing which session really happened later, and a rule
that is easy to explain beats a clever one that invents a history neither device had.

**Import validation goes deeper than it looks worth.** A file that is obviously wrong throws on the
first field and costs nothing to handle. The one that matters is a file that is *nearly* right,
where one number has become null or text, lands in the estimator, and turns every prediction into
NaN with no error raised anywhere. So every number in an imported file is checked for being finite,
and the error names the exact field.

**Which profile is selected lives in `localStorage`, not in the record.** It is a UI preference, it
means nothing on another device, and it should not travel in a backup.

The profile screen reports whether the browser has marked storage as persistent, but does **not**
request it — `navigator.storage.persist()` stays at build order step 8, where it belongs alongside
the PWA install that makes a grant likely. Reporting the current answer costs nothing and is the
fastest way to tell an eviction from a bug.

**Testing.** The storage tests run against `fake-indexeddb`, and the round-trip cases write a fully
populated record — items across several boxes, a moved ability with per-band residuals, attempts
with keystroke timelines, session summaries — because an empty record round-trips through almost any
bug. They reopen the database through a second connection, which is the closest an automated test
gets to quitting the browser and coming back. **It is not a substitute for actually restarting the
browser**: only that shows the origin's storage was not evicted, so that check is done by hand — and
was, on 2026-08-08, along with an export and a restore from the resulting file.

---

## The multiplication game, as built

The session engine lives in `src/game/` and is pure — no DOM, no storage — for the same reason the
core is. **It is deliberately subject-agnostic:** a subject hands it a *deck* (a set of item ids and
which band each belongs to) and nothing else, so spelling will run on the same engine with a
different deck. Everything multiplication-specific — the 78 facts, how one is shown, what counts as
a right answer — is one small file beside it.

The engine's shape: start a session from what is due, hand out one question at a time, take a result
back, and close with a summary. The three things a result touches are driven off different inputs
on purpose — the box moves on correctness alone and never on time, the estimator reads *only* first
exposures, and the archive takes everything including the keystroke timeline.

**The screen writes after every answer**, not at the end. Children close tabs; the record is a few
kilobytes and the write is off the critical path, so the cost is invisible and the alternative is
losing a whole session to a stray click.

**Both ways out of a session are the same event** — the Stop button and running out of material both
close the session and write its summary. An earlier version only wrote a summary when the child
pressed Stop, which would have silently lost every session that simply ran to the end.

**Enter is handled explicitly rather than through the form's implicit submission**, and likewise for
carrying on from a wrong answer, which accepts Enter from anywhere on the page rather than only from
the focused button. Enter is how this game is played — a number and a return, hundreds of times a
session — and it is not worth leaving to a browser default that quietly does not fire in some
contexts. It also means the rhythm never depends on where focus happens to be.

**A wrong answer waits for the child; a right one moves on by itself** after about half a second.
The correct product stays on screen with the fact still above it, so the answer has something to
attach to.

**A newly drawn screen ignores Enter for a moment, and that is load-bearing.** Handling Enter
explicitly created a way for one physical keypress to do two things: the keystroke that submits an
answer is still travelling up to the document while the next screen is being built, so the listener
attached during that handler receives the very same keystroke — and a wrong answer was dismissed the
instant it appeared, which is the one thing stopping on a wrong answer exists to prevent. Key repeat
from a child holding Enter down does the same a moment later. Both are handled by ignoring Enter for
a few hundred milliseconds after a screen is drawn, from both directions: the feedback card will not
be dismissed that soon, and an *empty* answer will not be submitted that soon. A deliberate blank
still goes through and still counts as a miss.

**Found by the user playing it, not by the tests**, and it would not have been caught by them: the
engine is where the tests are, and this was entirely in the wiring between a keystroke and the
screen. Worth remembering when the spelling game reuses the same input handling.

**The speed round is not built.** DESIGN.md lists it as a mode the child can choose, and it is
deliberately left out for now because of an interaction that needs thinking about first: a timed miss
does not demote, so a child who plays every session as a speed round can never be demoted at all.
The clock following the box needs no such decision and covers the fluency case already.

### What is not in this game yet

The proficiency chart, the harder/easier control, and the box-count readout beyond the end-of-session
summary are all build order step 9. The estimator is being fed and the difficulty setting is being
stored; nothing shows either yet.

---

## Open questions

1. ~~**Word list licensing.**~~ **Closed 2026-08-08** — see "Spelling word lists" above. Scripps and
   Fry are both out; Dolch is low-risk but unverified; SCOWL and SUBTLEX are usable. The resolution
   is to use a written list rather than a copied one, because grade labelling is the very thing
   publishers sell and so the very thing no free source provides.
2. **Sentence corpus filtering.** How aggressively, and verified how. Blocking condition for the
   cloze feature. Partly eased: the seed word list already carries explicit *homophones* and
   *commonly confused* sets, and those are the only words where a sentence is strictly necessary
   rather than merely helpful — so the hand-written fallback now has a ready-made scope.
3. **Blacklist scope** — per-child or shared. Shared is the default; unresolved. Built that way: it
   sits outside any profile and an import unions the two sides rather than picking one. Moving it
   per-child later means moving it into each child's record and dropping that union rule.
4. **Demotion severity** — box 1 or back one box. Decide from watching them play.
5. **Custom weekly lists.** No parent view was wanted, but "type in this week's actual spelling list
   from school" is the feature most likely to be asked for later. It has no recordings and no cloze
   sentences, which makes speech synthesis load-bearing again rather than a fallback. Not designed
   for; worth not painting into a corner.
6. **The target success rate for introductions** — 70% is a starting guess, not a finding. Needs
   watching them play. Its two failure modes look different: too high and nothing new gets learned
   because everything introduced is already known; too low and they stop playing.
7. **When per-grade residuals should be allowed to move**, and how much. Too eager and the chart is
   noise; too reluctant and a genuinely non-monotone kid is misread all year. A starting answer is
   built — a grade is trusted halfway at eight of its own first exposures — but that number is a
   guess and nothing has tested it against a real child.
8. **Whether the difficulty control should persist or decay.** A kid who picks "harder" during a good
   session may not want it a week later, and a stuck setting is indistinguishable from a broken
   estimator.
9. **Does learning words at a grade transfer to unseen words at that grade?** Raised by the user
   2026-08-08 and deliberately parked — **do the pedagogical research before tuning the estimator**,
   rather than guessing from first principles.

   The question: is spelling ability at a level partly a *generalisable* skill (orthographic
   patterns, morphology, roots — so learning some grade-6 words makes other grade-6 words easier),
   or mostly a pile of individually-memorised irregulars? Almost certainly both, and the ratio is
   what matters.

   **What turns on the answer.** If transfer is substantial, review outcomes carry real information
   about grade-level ability and excluding them wastes most of the data — and the introduction
   weighting should expect a grade to get easier as it is worked, rather than treating each word as
   independent. If transfer is weak, the current first-exposure-only rule is right and the estimate
   should barely move except when new words are met.

   **Worth searching for:** transfer effects in spelling instruction, orthographic pattern
   generalisation, and whether standardised spelling assessments model a grade as a latent trait or
   as word-specific knowledge. The psychometric literature on Rasch-modelling spelling tests is
   likely the fastest route to a defensible answer.

   Meanwhile: build first-exposure-only, keep the estimator's update size floored so it can track a
   rising ability either way, and **keep the raw attempt history** — if the answer arrives later, the
   estimator can be re-derived from data already collected. Same reasoning as storing the keystroke
   timeline: cheap now, unrecoverable later.
10. **Mixing subjects in one session.** Wanted eventually, deliberately unplanned.

---

## Build order

0. **Repo, toolchain, Pages deploy.** Done — placeholder page only, no application code.
1. **The pure core, tested, with no UI.** Done. `src/core/` — Leitner scheduler with the
   first-exposure fast-track, the proficiency estimator, the introduction weighting and volume
   governor, and multiplication fact normalisation. 59 tests, including simulated children checked
   for both convergence on a fixed ability and tracking of a rising one, each across several seeds.
   No DOM, no storage, no content.
2. **`ProgressStore` over IndexedDB**, plus profile create/select, plus JSON export/import. Done.
   `src/storage/` behind one interface, with the record shape, its caps and its schema version
   pinned down; a deliberately plain profile screen that creates, selects and deletes children and
   prints the counts that would be wrong if a save were dropping part of the record; and
   export/restore/merge over a validated JSON file. 38 tests against `fake-indexeddb`, plus the
   by-hand check that neither a fake nor a page reload can stand in for: **verified 2026-08-08 that
   profiles survive quitting and reopening the browser, and that an exported file restores.** That
   was the precondition for building anything on top of the store, and it is met.
3. **Multiplication game end to end.** Done. `src/game/` — a subject-agnostic session engine over a
   deck, plus the facts themselves — and a game screen that asks, times where the box says to, keeps
   the keystroke timeline, saves after every answer and closes with a summary. 26 engine tests,
   including a simulated child who knows the small tables and not the large ones, checked for whether
   the system ends up drilling the right material. Played end to end in a browser.

   Chosen before spelling deliberately: it needs no audio, no corpus and no licensing research, so it
   exercises the scheduler, the store, the session shell and the readout against the simplest
   possible content. That paid off — three real defects surfaced only by playing it, all recorded
   above: the missed-item echo, sessions that ended without writing a summary, and phantom items left
   by introductions that ran ahead of the child.
4. **Word lists.** Licensing resolved — no longer blocked. Remaining work: import the written K-8
   bank, extend it upward past grade 8, and grow grades 4-8 substantially using the curated words as
   calibration anchors for a computed difficulty model over a licensed vocabulary source. Commit with
   a notices file recording what came from where.
5. **Audio pipeline.** Build-time fetch, transcode, attribution generation. Speech-synthesis
   fallback first so the game works before the corpus exists.
6. **Spelling game**, including the blacklist button.
7. **Cloze sentences.** Last because it is the only part gated on a content-filtering problem, and
   the game is fully playable without it for every non-homophone word.
8. **PWA** — manifest, service worker, `navigator.storage.persist()`, install prompt.
9. **Progress readout.** The proficiency bar chart with its uncertainty and active zone, box counts,
   session accuracy, and the typing-speed trend. Plus the harder/easier control, which is only
   meaningful once the chart exists to show what it does.

The ordering principle: **prove the scheduler and the store with the content type that has no
external dependencies**, then add the content type that has several.
