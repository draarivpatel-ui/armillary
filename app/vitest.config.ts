import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    // Same single React instance and aliases as vite.config.ts.
    dedupe: ["react", "react-dom"],
    alias: {
      "@orrery/folio": path.resolve(__dirname, "../ui/folio/src/index.ts"),
      "@armillary/model": path.resolve(__dirname, "../crates/model/generated/contract.ts"),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
  },
});
