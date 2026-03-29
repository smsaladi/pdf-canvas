import { defineConfig } from "vite";

export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? "/pdf-canvas/" : "/",
  worker: {
    format: "es",
  },
  optimizeDeps: {
    exclude: ["mupdf"],
  },
  build: {
    target: "esnext",
  },
});
