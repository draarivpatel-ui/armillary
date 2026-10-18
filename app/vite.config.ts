import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // ui/folio keeps its own React copy in ui/folio/node_modules; one React instance for the whole app.
    dedupe: ["react", "react-dom"],
    alias: {
      "@orrery/folio": path.resolve(__dirname, "../ui/folio/src/index.ts"),
      "@armillary/model": path.resolve(__dirname, "../crates/model/generated/contract.ts"),
      "@contract": path.resolve(__dirname, "../crates/model/generated/contract.ts"),
      "crates/model/generated/contract.ts": path.resolve(__dirname, "../crates/model/generated/contract.ts"),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  clearScreen: false,
});
