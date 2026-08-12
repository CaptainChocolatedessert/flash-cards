/**
 * Types for the parts of the fetch script the tests import.
 *
 * The script is plain Node rather than TypeScript — it runs standalone, before
 * and outside any build — but the word normalisation inside it has to match the
 * app's, and the only way to check that is to import both and compare. This
 * declaration is what lets a typed test reach an untyped script.
 */

/** Every distinct word in a raw word-lists.json, normalised and sorted. */
export function wordsFrom(raw: unknown): string[];

/** A filename-safe stem for a word. */
export function slugFor(word: string): string;

/** Commons author boilerplate, reduced to a person's name. */
export function tidyArtist(artist: string): string;
