/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  worker: { format: "es" },
  server: {
    port: 5173,
    host: "127.0.0.1",
    proxy: { "/api": "http://127.0.0.1:8000" },
    // The browser engine bundles ../backend/rcwa_core sources.
    fs: { allow: [".."] },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["src/**/*.engine.test.ts", "node_modules/**"],
    setupFiles: ["src/test/setup.ts"],
  },
});
