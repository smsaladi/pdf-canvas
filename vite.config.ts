import { defineConfig } from "vite";

export default defineConfig({
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
