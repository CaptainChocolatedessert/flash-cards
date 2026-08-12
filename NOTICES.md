# Notices

The code in this repository is MIT licensed (see `LICENSE`). **The bundled data is not the same
thing as the code**, and this file records where each piece of it came from and on what terms.

Nothing here is legal advice; it is a record of stated terms and of what was checked.

---

## Spelling word list — `src/content/word-lists.json`

A bank of ~1,145 words, kindergarten through grade 8, organised around the skill progression in the
New Jersey Student Learning Standards for English Language Arts.

**New Jersey publishes no statewide spelling or sight word list.** The standards define skills per
grade — "recognize and read grade-appropriate irregularly spelled words", "spell grade-appropriate
words correctly" — and leave the words themselves to districts, which adopt commercial programs. So
no official list exists to reproduce, and the graded lists that do exist are commercial products.

### Provenance

| Part | Source | Terms |
|---|---|---|
| Kindergarten – grade 3 | Dolch word lists (E. W. Dolch, 1936): 220 service words and 95 nouns | Long treated as public domain; **not verified** — see below |
| Grades 4 – 8 | Written against the NJSLS skill progression: homophones, `-tion`/`-sion`, irregular plurals, prefixes and suffixes, Greek and Latin roots, academic vocabulary, frequently misspelled words | Not transcribed from any published program |

**On Dolch.** Published in *The Elementary School Journal* in 1936 and universally treated as public
domain. No copyright renewal record was found either way; a renewed 1936 work would run to 2031. The
practical risk is low — 220 words selected by raw frequency is about as thin as a compilation claim
gets — but this is recorded as *low risk, unverified* rather than as public domain, because those
are not the same claim.

**On grades 4 – 8.** These were written rather than copied. That claim was audited rather than taken
on trust, and the audit could not fully establish it: the words came out of a language model's
memory, and a model can reproduce a memorised list. What the audit did establish is that nothing was
transcribed from a document (that session had no network access), and that the Scripps *Words of the
Champions* list specifically is not the source — overlap with it is low and *falls* as grade rises,
the opposite of what copying its harder tiers would produce.

Most of the file is closed-class material anyway — homophones, irregular plurals, `-tion`/`-sion`
words, Greek and Latin root families. Those sets are fixed by their category rather than by
editorial selection, and under *Feist v. Rural Telephone* (1991) there is essentially nothing
protectable in them: the individual words are unprotectable facts, and only an original selection or
arrangement can be owned.

### Lists deliberately not used

- **Scripps "Words of the Champions"** — no permission grant; the site states "© The E. W. Scripps
  Company. All rights reserved," and the list is not freely downloadable. Its selection of 4,000
  words into three tiers is exactly the kind of original selection that carries a compilation
  copyright.
- **Fry's 1000 Instant Words** — a modern published work with no permissive terms. Wide reproduction
  by schools is tolerance, not a licence.

### Modifications made on import

The JSON is kept **verbatim** as it arrived; every change happens in `src/content/words.ts` with
tests, so the input stays auditable and the transformation stays inspectable.

- 32 words appear in two grades in the source. The **higher grade wins**, because a word in two bands
  has no valid reading for the scheduler and the later placement reflects a spelling-specific
  judgement.
- Words are lowercased, so a missing capital is never marked wrong.
- Kindergarten is carried as band `0` and displayed as "K".

### Known defects

- The Dolch sets contain small recall errors (`giving` where Dolch has `going`; `left`, `goat`,
  `woman`, `women` appear to be missing). Not yet corrected.
- Grade placement in grades 4 – 8 is unvalidated. There is no reference to check it against, and the
  Dolch errors suggest a comparable rate of quiet error — real words, plausibly placed, some wrong.

---

## Word audio — `public/audio/`

Human recordings of the spelling words, fetched from **Wikimedia Commons** by
`scripts/fetch-audio.mjs` and committed. Two sources, both explicitly redistributable with
attribution:

| Source | What it is | Typical licence |
|---|---|---|
| English Wiktionary pronunciation files (`En-us-word.ogg`, `En-uk-…`, `En-au-…`) | Long-standing volunteer recordings, accent named in the filename | CC BY-SA 3.0, some CC BY, some public domain |
| **Lingua Libre** (`LL-Q1860 (eng)-Speaker-word.wav`) | A Wikimedia project of bulk single-word recordings | CC BY-SA 4.0, some CC0 |

**Per-file attribution is generated, not hand-maintained.** `public/audio/credits.json` names the
author and licence of every single recording, and the app's "Credits and licences" page reads it.
Hand-maintaining that list would survive exactly until the first re-fetch.

### What the script does, and does not, do

- **Commons transcodes to MP3 itself**, and the script asks for the derivative rather than
  converting anything. That removes the ffmpeg dependency `DESIGN.md` originally assumed. Ogg is
  still the wrong format to ship — Safari has historically refused it — but the transcoding happens
  upstream.
- **Up to three recordings per word**, ranked by accent where the filename names one (US, then UK,
  GB, AU, CA, NZ), then Lingua Libre. This is what gives the "I can't understand it" button
  somewhere to fall through to.
- **Accents are only known where the filename says so.** Lingua Libre encodes the *speaker*, not
  their accent, and its speaker database is no longer reachable — lingualibre.org's wiki API returns
  an application shell as of 2026-08-11. Those recordings are recorded with accent `unknown` and
  ranked last. The user's instruction was not to worry much about accents.
- **No content check has been made on the audio itself.** These are volunteer recordings of ordinary
  English words; the risk is a dud recording rather than unsuitable material, and the blacklist
  exists for exactly that. This is not the same situation as the Tatoeba sentence corpus below,
  which does need a filter.

### Rate limits

Wikimedia rate-limits both the API and `upload.wikimedia.org`, and will 429 a client that goes too
fast. Both paths in the script are throttled, serialised and retried with backoff. If a re-fetch
starts failing in bulk, that is the first thing to look at rather than the last.

---

## Not yet present

Example sentences (Tatoeba, CC-BY) are planned and will be added here, with attribution generated by
the same kind of build script. **That corpus does need a content filter before it reaches children**
— see `DESIGN.md`, "Cloze sentences".
