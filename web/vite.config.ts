import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Absolute asset base so the one bundle works from /login, /accept-invite and
// /admin alike — axum serves index.html for any of them.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    // `bun run dev` proxies the API to a locally running authd.
    proxy: {
      "/api": "http://127.0.0.1:8080",
    },
  },
});
