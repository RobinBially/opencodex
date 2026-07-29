import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(import.meta.dirname, "web"),
  publicDir: resolve(import.meta.dirname, "../gui/public"),
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 4173,
    proxy: { "/api": "http://127.0.0.1:10200" },
  },
});
