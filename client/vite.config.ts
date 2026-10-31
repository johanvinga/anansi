import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Requests to /api go to the Fastify server, keeping cookies same-origin in development.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: false,
      },
    },
  },
});
