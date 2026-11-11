import * as monaco from "monaco-editor";
import type { AppTheme } from "../stores/settings";
// monaco-editor 0.5x exports 映射: "./*" -> "./esm/vs/*"，深路径无需 vs 前缀
import editorWorker from "monaco-editor/editor/editor.worker?worker";
import cssWorker from "monaco-editor/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/language/json/json.worker?worker";
import tsWorker from "monaco-editor/language/typescript/ts.worker?worker";

export function monacoThemeFor(theme: AppTheme): string {
  switch (theme) {
    case "midnight":
      return "glance-midnight";
    case "nord":
      return "glance-nord";
    case "light":
      return "glance-light";
    default:
      return "glance-dark";
  }
}

/**
 * Monaco ESM 离线集成（路线图 §2.4）：
 * - Worker 全部经 Vite 打包为本地资源，无 CDN 依赖
 * - 全应用单次初始化
 */
let initialized = false;

export function setupMonaco(): void {
  if (initialized) return;
  initialized = true;

  (self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment =
    {
      getWorker(_workerId: string, label: string): Worker {
        switch (label) {
          case "json":
            return new jsonWorker();
          case "css":
          case "scss":
          case "less":
            return new cssWorker();
          case "html":
          case "handlebars":
          case "razor":
            return new htmlWorker();
          case "typescript":
          case "javascript":
            return new tsWorker();
          default:
            return new editorWorker();
        }
      },
    };

  monaco.editor.defineTheme("glance-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#18181b",
      "editor.lineHighlightBackground": "#232327",
      "editorLineNumber.foreground": "#52525b",
      "editorLineNumber.activeForeground": "#a1a1aa",
      "editorGutter.background": "#18181b",
      "scrollbarSlider.background": "#3f3f4655",
      "scrollbarSlider.hoverBackground": "#52525b88",
    },
  });

  monaco.editor.defineTheme("glance-midnight", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#111827",
      "editor.lineHighlightBackground": "#1e293b",
      "editorLineNumber.foreground": "#475569",
      "editorLineNumber.activeForeground": "#94a3b8",
      "editorGutter.background": "#111827",
      "scrollbarSlider.background": "#33415555",
      "scrollbarSlider.hoverBackground": "#47556988",
    },
  });

  monaco.editor.defineTheme("glance-nord", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#2e3440",
      "editor.lineHighlightBackground": "#3b4252",
      "editorLineNumber.foreground": "#616e88",
      "editorLineNumber.activeForeground": "#d8dee9",
      "editorGutter.background": "#2e3440",
      "scrollbarSlider.background": "#4c566a55",
      "scrollbarSlider.hoverBackground": "#616e8888",
    },
  });

  monaco.editor.defineTheme("glance-light", {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#ffffff",
      "editor.lineHighlightBackground": "#f1f5f9",
      "editorLineNumber.foreground": "#94a3b8",
      "editorLineNumber.activeForeground": "#0f172a",
      "editorGutter.background": "#ffffff",
      "scrollbarSlider.background": "#cbd5e166",
      "scrollbarSlider.hoverBackground": "#94a3b899",
    },
  });
}

/** 扩展名 → Monaco languageId */
const EXT_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  "c++": "cpp",
  c: "c",
  h: "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  py: "python",
  pyi: "python",
  rs: "rust",
  go: "go",
  java: "java",
  yaml: "yaml",
  yml: "yaml",
  xml: "xml",
  urdf: "xml",
  xacro: "xml",
  svg: "xml",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  md: "markdown",
  markdown: "markdown",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  sql: "sql",
  toml: "ini",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  txt: "plaintext",
};

export function languageForFileName(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "plaintext";
  const ext = name.slice(dot + 1).toLowerCase();
  return EXT_LANGUAGE[ext] ?? "plaintext";
}

export { monaco };
