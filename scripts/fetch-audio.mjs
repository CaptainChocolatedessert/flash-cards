/**
 * Fetch human pronunciation recordings from Wikimedia Commons.
 *
 * Run with `npm run fetch-audio`. It is a **build-time** script and never runs in
 * the browser: the word list is fixed, so there is no reason for a child's device
 * to talk to Wikimedia mid-question. See DESIGN.md, "Fetched at build time, not at
 * runtime" — no API key ships, no network call happens during a question, and the
 * audio is a static asset the service worker can cache on demand.
 *
 * It writes three things:
 *
 *   public/audio/<slug>-<n>.mp3   the recordings themselves
 *   src/content/recordings.json   a tiny index the game bundles: word -> how many
 *   public/audio/credits.json     full per-file provenance, loaded only by the
 *                                 credits page, so 3000 attributions never sit in
 *                                 the main bundle
 *
 * **Resumable, and it has to be.** A thousand words is thousands of API calls and
 * downloads against a shared public API that will rate-limit a rude client. Every
 * stage caches to disk and re-running skips what is already done, so an
 * interrupted run costs the requests it had not made yet rather than all of them.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const AUDIO_DIR = path.join(ROOT, "public", "audio");
/**
 * Deliberately not under `public/`. Everything in there is copied into the build
 * and served, and this is a megabyte of build cache that no browser should ever
 * be offered. It is gitignored: it saves thousands of API calls on a re-run, but
 * it is derived data and a fresh clone is entitled to rebuild it.
 */
const STATE_FILE = path.join(ROOT, ".audio-cache.json");
const INDEX_FILE = path.join(ROOT, "src", "content", "recordings.json");
const CREDITS_FILE = path.join(AUDIO_DIR, "credits.json");
const WORDS_FILE = path.join(ROOT, "src", "content", "word-lists.json");

/**
 * Wikimedia asks that automated clients identify themselves and give a way to be
 * contacted, and they block ones that do not. This is not decoration.
 */
const USER_AGENT =
  "flash-cards-audio-fetch/1.0 (https://github.com/CaptainChocolatedessert/flash-cards; a children's spelling game) node-fetch";

const API = "https://commons.wikimedia.org/w/api.php";

/**
 * How many recordings to keep per word.
 *
 * More than one so the "I can't understand it" button has somewhere to go: a
 * blocked recording falls through to the next one, and only falls all the way to
 * the synthesiser when every recording for that word has been rejected. Three is
 * the user's call (2026-08-11), against ~17KB per file and ~1100 words.
 */
const KEEP_PER_WORD = 3;

/**
 * Accent preference, best first, taken from the filename.
 *
 * English Wiktionary's convention encodes the accent in the title — `En-us-cat.ogg`
 * — so this ordering is free and exact for those files. Lingua Libre's names carry
 * the speaker but not their accent, and the speaker database is not reachable
 * (lingualibre.org's wiki API is gone as of 2026-08-11), so those recordings rank
 * last with the accent recorded as unknown. The user's instruction was not to
 * worry much about accents, and this is what "not much" costs: nothing.
 */
const ACCENT_PREFIXES = [
  ["us", "En-us-"],
  ["uk", "En-uk-"],
  ["gb", "En-gb-"],
  ["au", "En-au-"],
  ["ca", "En-ca-"],
  ["nz", "En-nz-"],
];

/** Extensions Wiktionary-convention files actually appear with, likeliest first. */
const EXTENSIONS = ["ogg", "wav", "flac"];

/** Titles per API request. The API's own ceiling is 50; extmetadata makes each one fat. */
const TITLE_BATCH = 25;

/** Gap between API calls. Slow enough to stay welcome, fast enough to finish. */
const API_GAP_MS = 250;

/**
 * Parallel downloads, and the gap between starting them.
 *
 * The first run of this script assumed upload.wikimedia.org was a CDN and would
 * be more forgiving than the API. It is not: four-wide with no delay earned an
 * immediate 429 and 2452 of 2476 files failed. Downloads are throttled and
 * retried exactly like API calls now, because they are subject to exactly the
 * same politeness rules.
 */
const DOWNLOAD_CONCURRENCY = 2;
const DOWNLOAD_GAP_MS = 200;

// ---------------------------------------------------------------------------
// The word list
// ---------------------------------------------------------------------------

/**
 * The same normalisation `src/content/words.ts` applies: trim, lowercase, drop
 * blanks, deduplicate.
 *
 * Duplicated here rather than imported because this script is plain Node and the
 * app is TypeScript reached through a chain of extension-rewritten imports. A
 * test asserts the two agree, which is the part that actually matters — if they
 * drift, the game asks for audio that was never fetched.
 */
export function wordsFrom(raw) {
  const words = new Set();
  for (const grade of raw.grades) {
    for (const set of grade.sets) {
      for (const word of set.words) {
        const normalised = word.trim().toLowerCase();
        if (normalised !== "") words.add(normalised);
      }
    }
  }
  return [...words].sort();
}

/**
 * A filename-safe form of a word.
 *
 * Seven words in the list are not plain letters — `don't`, `santa claus`,
 * `good-bye` and friends. Collisions are checked rather than assumed: two words
 * sharing a slug would silently overwrite each other's audio.
 */
export function slugFor(word) {
  return word.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
}

// ---------------------------------------------------------------------------
// Talking to Commons, politely
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastCall = 0;

/**
 * One API call, serialised and rate-limited, retrying on the failures that are
 * worth retrying.
 *
 * Commons answers a client that goes too fast with a plain-text "You are making
 * too many requests" that is not JSON and not an HTTP error — found the hard way
 * while probing. Backing off and retrying is the whole difference between a
 * script that finishes and one that dies at word 200.
 */
async function api(params, attempt = 0) {
  const wait = API_GAP_MS - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();

  const url = `${API}?${new URLSearchParams({ format: "json", formatversion: "2", ...params })}`;
  let body;
  try {
    const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    body = await response.text();
    if (response.ok && body.startsWith("{")) return JSON.parse(body);
  } catch (error) {
    body = String(error);
  }
  if (attempt >= 5) throw new Error(`Commons API gave up after 6 tries: ${body.slice(0, 200)}`);
  const backoff = 2000 * 2 ** attempt;
  process.stderr.write(`  … backing off ${backoff / 1000}s (${body.slice(0, 60).trim()})\n`);
  await sleep(backoff);
  return api(params, attempt + 1);
}

// ---------------------------------------------------------------------------
// Finding candidates
// ---------------------------------------------------------------------------

/**
 * Which Wiktionary-convention titles exist, asked 25 at a time.
 *
 * Existence checking by title is exact and cheap — far better than searching,
 * which is fuzzy and would need the results filtered anyway. The API reports a
 * title that does not exist as `missing`, so one request settles 25 questions.
 */
async function existingTitles(titles) {
  const found = new Set();
  for (let i = 0; i < titles.length; i += TITLE_BATCH) {
    const batch = titles.slice(i, i + TITLE_BATCH);
    const json = await api({ action: "query", titles: batch.join("|") });
    for (const page of json.query?.pages ?? []) {
      if (page.missing !== true) found.add(page.title);
    }
  }
  return found;
}

/**
 * Lingua Libre recordings for one word.
 *
 * Search rather than title lookup, because the speaker's name sits in the middle
 * of the filename — `LL-Q1860 (eng)-Vealhurl-water.wav` — so there is no prefix
 * to ask for. The result is filtered against a strict pattern locally, since
 * search matches loosely and would otherwise hand back "water vapor" for "water".
 */
async function linguaLibreFor(word) {
  const json = await api({
    action: "query",
    list: "search",
    srnamespace: "6",
    srsearch: `intitle:LL-Q1860 intitle:${word}`,
    srlimit: "30",
  });
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const exact = new RegExp(`^File:LL-Q1860 \\(eng\\)-.+-${escaped}\\.(wav|ogg|flac)$`, "i");
  return (json.query?.search ?? []).map((s) => s.title).filter((t) => exact.test(t));
}

/** Every candidate recording for a word, best accent first, Lingua Libre last. */
async function candidatesFor(word, wiktionaryHits) {
  const ranked = [];
  for (const [accent] of ACCENT_PREFIXES) {
    for (const title of wiktionaryHits.filter((h) => h.accent === accent)) {
      ranked.push({ title: title.title, accent });
    }
  }
  if (ranked.length >= KEEP_PER_WORD) return ranked.slice(0, KEEP_PER_WORD);

  const ll = await linguaLibreFor(word);
  for (const title of ll) ranked.push({ title, accent: "unknown" });
  return ranked.slice(0, KEEP_PER_WORD);
}

// ---------------------------------------------------------------------------
// Turning a title into a downloadable MP3 with its licence
// ---------------------------------------------------------------------------

/**
 * Commons transcodes its own audio to MP3 and serves it, so this script does not
 * need ffmpeg and the repo does not need a binary dependency.
 *
 * DESIGN.md called transcoding "not optional" because Commons files are largely
 * Ogg Vorbis and Safari has historically refused to play it. That remains true;
 * what changed is who does the transcoding. Asking Commons for the derivative it
 * already has is strictly better than doing it here.
 */
function mp3From(info) {
  const derivative = (info.derivatives ?? []).find((d) => d.transcodekey === "mp3");
  if (derivative) return derivative.src;
  // Some files are uploaded as MP3 and get no derivative, being already there.
  if (info.mime === "audio/mpeg") return info.url;
  return null;
}

function plainText(html) {
  return String(html ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Turn Commons' author boilerplate into a person's name.
 *
 * Two house styles show up and neither is readable on a credits page. Files with
 * the author inside a template come back as "No machine-readable author provided.
 * Xnux assumed (based on copyright claims)."; Lingua Libre files come back as
 * "Speaker: Grendelkhan Recorder: Grendelkhan". The attribution has to name the
 * person, and a page of parser output names them badly rather than not at all —
 * so this is tidying, not dropping.
 */
export function tidyArtist(artist) {
  const assumed = /No machine-readable author provided\.\s*(.+?)\s*assumed \(based on copyright claims\)\.?/i.exec(
    artist,
  );
  if (assumed) return assumed[1];

  const linguaLibre = /^Speaker:\s*(.+?)\s*Recorder:\s*(.+?)$/i.exec(artist);
  if (linguaLibre) {
    const [, speaker, recorder] = linguaLibre;
    return speaker === recorder ? speaker : `${speaker} (recorded by ${recorder})`;
  }

  return artist;
}

/** Provenance for one file, in the form the credits page needs. */
function creditFrom(page, info) {
  const meta = info.extmetadata ?? {};
  return {
    title: page.title,
    // encodeURI, not encodeURIComponent: the "File:" prefix and the underscores
    // are part of the path Commons expects, and percent-encoding the colon gives
    // a link that does not resolve.
    page: `https://commons.wikimedia.org/wiki/${encodeURI(page.title.replace(/ /g, "_"))}`,
    artist: plainText(meta.Artist?.value) || "unknown",
    licence: plainText(meta.LicenseShortName?.value) || "see file page",
    licenceUrl: plainText(meta.LicenseUrl?.value) || "",
  };
}

/** Licence, author and MP3 URL for a batch of titles. */
async function describe(titles) {
  const described = new Map();
  for (let i = 0; i < titles.length; i += TITLE_BATCH) {
    const batch = titles.slice(i, i + TITLE_BATCH);
    const json = await api({
      action: "query",
      titles: batch.join("|"),
      prop: "videoinfo",
      viprop: "url|mime|derivatives|extmetadata",
    });
    for (const page of json.query?.pages ?? []) {
      const info = page.videoinfo?.[0];
      if (!info) continue;
      const mp3 = mp3From(info);
      if (mp3 === null) continue;
      described.set(page.title, { mp3, credit: creditFrom(page, info) });
    }
  }
  return described;
}

// ---------------------------------------------------------------------------
// Downloading
// ---------------------------------------------------------------------------

let lastDownload = 0;

/**
 * Fetch one recording, waiting its turn and backing off when told to.
 *
 * `Retry-After` is honoured when the server sends one — it is the server saying
 * exactly how long it wants to be left alone, and guessing instead is how a
 * client ends up hammering a service that already asked it to stop.
 */
async function download(url, destination, attempt = 0) {
  const wait = DOWNLOAD_GAP_MS - (Date.now() - lastDownload);
  if (wait > 0) await sleep(wait);
  lastDownload = Date.now();

  let problem;
  try {
    const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (response.ok) {
      const bytes = Buffer.from(await response.arrayBuffer());
      // A "recording" of a few hundred bytes is an error page or a truncated
      // file, not audio. Better to notice here than to ship silence to a child.
      if (bytes.length < 1024) throw new Error(`suspiciously small (${bytes.length}B)`);
      await fs.writeFile(destination, bytes);
      return bytes.length;
    }
    problem = `HTTP ${response.status}`;
    if (response.status === 429) {
      const after = Number(response.headers.get("retry-after"));
      if (Number.isFinite(after) && after > 0) await sleep(Math.min(after, 60) * 1000);
    } else if (response.status < 500) {
      // A 404 will still be a 404 in eight seconds' time.
      throw new Error(`${problem} for ${url}`);
    }
  } catch (error) {
    if (attempt >= 4) throw error;
    problem = String(error.message ?? error);
  }

  if (attempt >= 4) throw new Error(`${problem} after 5 tries: ${url}`);
  await sleep(1500 * 2 ** attempt);
  return download(url, destination, attempt + 1);
}

/** Run `worker` over `items`, a few at a time. */
async function pooled(items, limit, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function main() {
  const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const raw = JSON.parse(await fs.readFile(WORDS_FILE, "utf8"));
  const words = only.length > 0 ? only : wordsFrom(raw);

  const slugs = new Map();
  for (const word of words) {
    const slug = slugFor(word);
    if (slugs.has(slug)) throw new Error(`Slug collision: "${word}" and "${slugs.get(slug)}"`);
    slugs.set(slug, word);
  }

  await fs.mkdir(AUDIO_DIR, { recursive: true });
  const state = await readJson(STATE_FILE, { discovered: {}, described: {} });

  // --- 1. Which Wiktionary-convention files exist -------------------------
  const pending = words.filter((w) => state.discovered[w] === undefined);
  if (pending.length > 0) {
    process.stdout.write(`Looking up ${pending.length} words on Commons…\n`);
    const wanted = [];
    for (const word of pending) {
      for (const [accent, prefix] of ACCENT_PREFIXES) {
        for (const ext of EXTENSIONS) {
          wanted.push({ word, accent, title: `File:${prefix}${word}.${ext}` });
        }
      }
    }
    const exists = await existingTitles(wanted.map((w) => w.title));
    const hitsByWord = new Map(words.map((w) => [w, []]));
    for (const candidate of wanted) {
      if (exists.has(candidate.title)) hitsByWord.get(candidate.word).push(candidate);
    }

    let done = 0;
    for (const word of pending) {
      state.discovered[word] = await candidatesFor(word, hitsByWord.get(word) ?? []);
      done += 1;
      if (done % 25 === 0 || done === pending.length) {
        process.stdout.write(`  discovered ${done}/${pending.length}\n`);
        await fs.writeFile(STATE_FILE, JSON.stringify(state));
      }
    }
    await fs.writeFile(STATE_FILE, JSON.stringify(state));
  }

  // --- 2. Licence and MP3 URL for everything chosen -----------------------
  const chosen = [...new Set(words.flatMap((w) => (state.discovered[w] ?? []).map((c) => c.title)))];
  const undescribed = chosen.filter((t) => state.described[t] === undefined);
  if (undescribed.length > 0) {
    process.stdout.write(`Describing ${undescribed.length} files…\n`);
    for (let i = 0; i < undescribed.length; i += TITLE_BATCH * 4) {
      const slice = undescribed.slice(i, i + TITLE_BATCH * 4);
      const described = await describe(slice);
      for (const [title, value] of described) state.described[title] = value;
      // Titles that came back with no usable MP3 are marked so the next run does
      // not ask again; null is an answer, not a gap.
      for (const title of slice) state.described[title] ??= null;
      await fs.writeFile(STATE_FILE, JSON.stringify(state));
      process.stdout.write(`  described ${Math.min(i + slice.length, undescribed.length)}/${undescribed.length}\n`);
    }
  }

  // --- 3. Download what is missing ---------------------------------------
  const jobs = [];
  for (const word of words) {
    const slug = slugFor(word);
    let index = 0;
    for (const candidate of state.discovered[word] ?? []) {
      const described = state.described[candidate.title];
      if (!described) continue;
      index += 1;
      jobs.push({
        word,
        slug,
        index,
        file: `${slug}-${index}.mp3`,
        url: described.mp3,
        accent: candidate.accent,
        credit: described.credit,
      });
    }
  }

  const needed = [];
  for (const job of jobs) {
    const destination = path.join(AUDIO_DIR, job.file);
    try {
      const stat = await fs.stat(destination);
      if (stat.size > 1024) continue;
    } catch {
      // Not there yet.
    }
    needed.push(job);
  }

  if (needed.length > 0) {
    process.stdout.write(`Downloading ${needed.length} recordings…\n`);
    let done = 0;
    let failed = 0;
    await pooled(needed, DOWNLOAD_CONCURRENCY, async (job) => {
      try {
        await download(job.url, path.join(AUDIO_DIR, job.file));
      } catch (error) {
        failed += 1;
        process.stderr.write(`  ! ${job.word} (${job.file}): ${error.message}\n`);
      }
      done += 1;
      if (done % 100 === 0) process.stdout.write(`  downloaded ${done}/${needed.length}\n`);
    });
    process.stdout.write(`  downloaded ${done}/${needed.length}${failed ? `, ${failed} failed` : ""}\n`);
  }

  // --- 4. Write the index and the credits ---------------------------------
  //
  // Two files on purpose. The index is what the game bundles and it has to stay
  // small, so it carries only what playback needs: the word, and how many
  // recordings it has. The credits carry author and licence for every single
  // file, which is the legal requirement and is far too big to sit in the main
  // bundle — the credits page fetches it when someone actually opens it.
  const index = {};
  const credits = [];
  let bytes = 0;
  let gaps = 0;

  const byWord = new Map();
  for (const job of jobs) {
    if (!byWord.has(job.word)) byWord.set(job.word, []);
    byWord.get(job.word).push(job);
  }

  for (const [word, wordJobs] of byWord) {
    // **Count only an unbroken run from 1.** The index says "this word has N
    // recordings" and the player derives the filenames from that, so a word whose
    // second file failed to download while its third succeeded would have the
    // player ask for a `-2` that is not there. Stopping at the gap costs the
    // stragglers and keeps the index true; a later re-run picks them up, since
    // the missing files are exactly what it will try to fetch.
    for (const job of wordJobs) {
      let size = 0;
      try {
        const stat = await fs.stat(path.join(AUDIO_DIR, job.file));
        size = stat.size;
      } catch {
        // Not downloaded.
      }
      if (size <= 1024) {
        if (wordJobs.indexOf(job) < wordJobs.length - 1) gaps += 1;
        break;
      }
      bytes += size;
      index[word] ??= { slug: job.slug, count: 0 };
      index[word].count += 1;
      // Tidied here rather than when the file was described, so that improving
      // the formatting never costs a re-query of thousands of cached
      // descriptions.
      credits.push({
        file: job.file,
        word: job.word,
        accent: job.accent,
        ...job.credit,
        artist: tidyArtist(job.credit.artist),
      });
    }
  }

  await fs.writeFile(
    INDEX_FILE,
    `${JSON.stringify({ generatedAt: new Date().toISOString().slice(0, 10), words: index }, null, 0)}\n`,
  );
  await fs.writeFile(
    CREDITS_FILE,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString().slice(0, 10),
        note: "Every recording below came from Wikimedia Commons and is reused under the licence named against it.",
        recordings: credits.sort((a, b) => a.word.localeCompare(b.word) || a.file.localeCompare(b.file)),
      },
      null,
      1,
    )}\n`,
  );

  const withAudio = Object.keys(index).length;
  process.stdout.write(
    [
      "",
      `Words with at least one recording: ${withAudio}/${words.length}`,
      `Recordings: ${credits.length}`,
      ...(gaps > 0
        ? [`Words short of their full set because a download is missing: ${gaps} — re-run to fill`]
        : []),
      `On disk: ${(bytes / 1024 / 1024).toFixed(1)} MB`,
      `Index: ${path.relative(ROOT, INDEX_FILE)}`,
      `Credits: ${path.relative(ROOT, CREDITS_FILE)}`,
      "",
    ].join("\n"),
  );

  const licences = new Map();
  for (const credit of credits) licences.set(credit.licence, (licences.get(credit.licence) ?? 0) + 1);
  process.stdout.write("Licences in use:\n");
  for (const [licence, count] of [...licences].sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`  ${count.toString().padStart(5)}  ${licence}\n`);
  }
}

// Only run when invoked directly, so the helpers above can be imported by tests.
// Compared as URLs rather than as strings: on Windows `process.argv[1]` is a
// backslashed drive path and `import.meta.url` is a three-slash file URL, and
// hand-assembling one from the other gets the slashes wrong — which fails silently
// by simply never running.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`\n${error.stack ?? error}\n`);
    process.exit(1);
  });
}
