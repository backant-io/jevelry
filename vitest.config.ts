import { defineConfig } from "vitest/config";

export default defineConfig({
  // No test may find a Jev server on this machine: the one on 8741 serves a live trading system. Tests that need one point this at a fake.
  test: { include: ["tests/**/*.test.ts"], exclude: ["tests/live/**", "node_modules/**"], testTimeout: 20000, env: { JEVELRY_KNOWN_SERVERS: "" } },
});
