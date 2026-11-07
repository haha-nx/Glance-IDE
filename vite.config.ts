import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Tauri 前端构建配置：
// - 端口固定 1420（与 tauri.conf.json devUrl 一致）
// - Monaco Worker 通过 ?worker 导入打包为同源静态资源，离线可用
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "es2022",
    outDir: "dist",
    // Monaco 体积较大，提高分块阈值避免警告
    chunkSizeWarningLimit: 8000,
  },
});
