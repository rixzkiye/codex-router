import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: path.resolve(import.meta.dirname, "web"),
  plugins: [react()],
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/console"),
    emptyOutDir: true,
    assetsDir: "assets",
    sourcemap: true,
    target: "es2022"
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4178"
    }
  }
});
