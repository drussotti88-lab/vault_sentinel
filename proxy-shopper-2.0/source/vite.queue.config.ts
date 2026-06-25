import { defineConfig } from "vite";

/**
 * Queue-it detector content-script build. Like the main content script it must
 * be a self-contained IIFE (content scripts can't be ES modules), so it gets
 * its own single-entry lib build. Runs after the main build with
 * emptyOutDir: false so the rest of dist/ is preserved.
 */
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false,
    sourcemap: false,
    lib: {
      entry: "src/content/queue.ts",
      formats: ["iife"],
      name: "ProxyShopperQueue",
      fileName: () => "queue.js",
    },
  },
});
