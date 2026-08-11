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

  /**
   * Ports are assigned centrally in ../project setup notes.md; this project's is
   * 5473. Vite's default 5173 is deliberately left unclaimed so an unconfigured
   * `vite` anywhere in this folder collides with nothing.
   *
   * `strictPort` is the half that matters: Vite's default on a taken port is to
   * quietly move to the next free one, so a URL pointing at the old port then
   * reaches a different project's dev server. Refusing to start is readable.
   */
  server: { port: 5473, strictPort: true },
});
