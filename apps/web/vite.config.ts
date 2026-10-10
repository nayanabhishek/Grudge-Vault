import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiTarget = process.env.VITE_SERVER_URL ?? "http://127.0.0.1:3000";
export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    proxy: { "/socket.io": { target: apiTarget, ws: true, changeOrigin: true } },
  },
});
