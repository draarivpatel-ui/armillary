import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@orrery/design": path.resolve(__dirname, "../../design/src/index.ts"),
    },
  },
  server: {
    port: 5188,
  },
});
