import { defineConfig } from "vite";

/**
 * Content-script build. Chrome content scripts cannot be ES modules, so the
 * script is bundled as a single self-contained IIFE. Runs after the main
 * build (emptyOutDir: false keeps the rest of dist/ intact).
 */
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false,
    sourcemap: false,
    lib: {
      entry: "src/content/index.ts",
      formats: ["iife"],
      name: "ProxyShopperContent",
      fileName: () => "content.js",
    },
  },
});
