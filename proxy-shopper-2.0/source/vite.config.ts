import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Main build: popup + options pages (React), background service worker,
 * and the offscreen parser page. The content script needs an IIFE bundle,
 * so it is built separately via vite.content.config.ts.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        popup: r("src/popup/index.html"),
        options: r("src/options/index.html"),
        offscreen: r("src/offscreen/offscreen.html"),
        background: r("src/background/index.ts"),
      },
      output: {
        // The manifest points at background.js in the bundle root; keep
        // everything else hashed under assets/.
        entryFileNames: (chunk) =>
          chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js",
      },
    },
  },
});
