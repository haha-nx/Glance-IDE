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
    chunkSizeWarningLimit: 5000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/monaco-editor")) return "monaco";
          if (id.includes("node_modules/@xterm")) return "xterm";
          if (id.includes("node_modules/marked") || id.includes("node_modules/dompurify")) {
            return "markdown";
          }
          if (
            id.includes("node_modules/react") ||
            id.includes("node_modules/react-dom") ||
            id.includes("node_modules/zustand")
          ) {
            return "vendor";
          }
          return undefined;
        },
      },
    },
  },
});
