import { defineConfig } from "vite";

export default defineConfig({
  // Relative base so the build also works from a plain file server or a
  // subdirectory of a static host (GitHub Pages project sites, for instance).
  base: "./",
  build: {
    target: "es2022",
  },
  worker: {
    format: "es",
  },
});
