import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Production assets are static and served by Caddy; there is no Node app server.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": process.env.SPECMATE_API_ORIGIN ?? "http://127.0.0.1:8000" },
  },
  build: { sourcemap: false },
  // Bound concurrent DOM workers so resource contention does not consume assertion deadlines.
  // Deadlines only bound a hung test; they are generous because lazy tool modules are transformed on
  // first import, which is slow when the host is saturated. Assertions are unchanged. Individual
  // tests must not pass a smaller explicit timeout (it would override this). Async-wait timeout for
  // Testing Library lives in src/test/setup.ts.
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    maxWorkers: 2,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
