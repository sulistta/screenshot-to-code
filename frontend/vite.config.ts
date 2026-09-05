import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { host: "localhost", port: 5173, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  build: { target: "es2021" },
});
