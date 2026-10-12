import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The API the dev server and `vite preview` proxy to: a local `wrangler dev` by default,
// or a deployed Worker with FT_API=https://<worker>.workers.dev.
const api = process.env.FT_API ?? "http://localhost:8787";
const proxy = { "/api": { target: api, ws: true, changeOrigin: true } };

export default defineConfig({
  plugins: [react()],
  server: { proxy },
  preview: { proxy },
});
