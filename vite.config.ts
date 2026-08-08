import { defineConfig } from "vite";

/**
 * `base` must match the GitHub Pages project subpath. Project Pages serve from
 * /<repo>/, and assets resolve against the origin root otherwise.
 *
 * Vite rewrites this into the built HTML, but does NOT touch anything in public/.
 * When a web app manifest and service worker land, their paths are manual copies
 * of this same string — and the service worker's scope must match it, or offline
 * fails silently. See DESIGN.md, "The subpath".
 */
export default defineConfig({
  base: "/flash-cards/",
});
