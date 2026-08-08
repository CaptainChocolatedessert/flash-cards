# Flash Cards

A question-and-answer study game for two kids: **spelling** (a spoken word, typed back) and
**multiplication facts**. Spaced repetition underneath both, separate progress for each child, and
no backend — it runs entirely in the browser.

**Status: planning.** No application code exists yet. This repo currently holds the design record,
the build toolchain, and a placeholder page proving the deployment path.

Live at <https://captainchocolatedessert.github.io/flash-cards/>

## What it will do

- **Spelling** — hears a word (real human recordings where available, speech synthesis otherwise),
  types it back. A sentence with the word blanked out disambiguates homophones. A button to report
  a recording as unintelligible.
- **Multiplication** — facts to 12×12, bucketed the way they are taught rather than by grade.
- **Spaced repetition** — Leitner boxes, so words you miss come back sooner and words you know
  retire.
- **Levels that climb on their own** — no placement test. Start low, and the difficulty frontier
  advances as proficiency shows in the data.
- **Timed and untimed questions** — untimed measures whether they know it, timed measures recall
  speed and typing speed as three separate signals.
- **Per-child progress**, stored locally, with a JSON export for backup.

## Development

```bash
npm install
```

```bash
npm run dev
```

```bash
npm test
```

Pushing to `main` builds and deploys to GitHub Pages.

## Design

`DESIGN.md` carries the full design record — decisions and their reasoning, open questions, and the
build order.

## Licence

Code is MIT (`LICENSE`).

**The bundled data is not.** Word audio from Wikimedia Commons and Lingua Libre is CC-BY-SA;
example sentences from Tatoeba are CC-BY. Both require attribution, which the app carries on its own
attributions page. Word lists carry their own terms, noted alongside them.
