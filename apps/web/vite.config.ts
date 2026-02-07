import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const previewAllowedHosts = [
  "localhost",
  "127.0.0.1",
  ".designxdevelop.com",
  ".up.railway.app",
  process.env.RAILWAY_PUBLIC_DOMAIN,
  process.env.RAILWAY_SERVICE_WEB_URL,
  (() => {
    const frontendUrl = process.env.FRONTEND_URL;
    if (!frontendUrl) return undefined;
    try {
      return new URL(frontendUrl).hostname;
    } catch {
      return undefined;
    }
  })(),
].filter((host): host is string => Boolean(host));

export default defineConfig({
  plugins: [
    tanstackRouter({
      target: "react",
      autoCodeSplitting: true,
    }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
      "/preview": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
  preview: {
    allowedHosts: previewAllowedHosts,
  },
});
