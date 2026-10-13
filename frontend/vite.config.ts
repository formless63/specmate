import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Production assets are static and served by Caddy; there is no Node app server.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": process.env.SPECMATE_API_ORIGIN ?? "http://127.0.0.1:8000" },
  },
  build: { sourcemap: false },
  test: { environment: "jsdom", setupFiles: ["./src/test/setup.ts"] },
});
