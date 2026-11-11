import { useEffect, useRef } from "react";
import { monaco, monacoThemeFor, setupMonaco } from "../../lib/monaco";
import { getModel } from "../../lib/models";
import { tabsStore } from "../../stores/tabs";
import { uiStore } from "../../stores/ui";
import { settingsStore } from "../../stores/settings";

/** 保存快捷键与统一保存入口 */
export function useGlobalSave() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        const { activeId, saveTab } = tabsStore.getState();
        if (activeId) void saveTab(activeId);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
}

interface MonacoHostProps {
  uri?: string;
}

export function MonacoHost({ uri: customUri }: MonacoHostProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

  const globalActiveId = tabsStore((s) => s.activeId);
  const targetUri = customUri || globalActiveId;
  const activeTab = tabsStore((s) => s.tabs.find((t) => t.uri === targetUri));
  const fontSize = settingsStore((s) => s.fontSize);
  const theme = settingsStore((s) => s.theme);
  const targetUriRef = useRef(targetUri);
  targetUriRef.current = targetUri;

  useEffect(() => {
    if (!containerRef.current) return;
    setupMonaco();

    const { fontSize: initialFontSize, theme: initialTheme } = settingsStore.getState();
    const editor = monaco.editor.create(containerRef.current, {
      theme: monacoThemeFor(initialTheme),
      automaticLayout: true,
      fontSize: initialFontSize,
      fontFamily:
        '"SF Mono", Menlo, Monaco, "Cascadia Code", "JetBrains Mono", Consolas, monospace',
      minimap: { enabled: true, scale: 1 },
      scrollBeyondLastLine: true,
      renderWhitespace: "selection",
      tabSize: 4,
      smoothScrolling: true,
      cursorBlinking: "smooth",
      padding: { top: 8 },
    });
    editorRef.current = editor;

    if (targetUri) {
      const m = getModel(targetUri);
      if (m) {
        editor.setModel(m);
      }
    }

    const layout = () => {
      if (containerRef.current && editor) {
        const { clientWidth, clientHeight } = containerRef.current;
        if (clientWidth > 0 && clientHeight > 0) {
          editor.layout({ width: clientWidth, height: clientHeight });
        } else {
          editor.layout();
        }
      }
    };

    requestAnimationFrame(layout);
    const t1 = setTimeout(layout, 50);
    const t2 = setTimeout(layout, 150);

    editor.onDidChangeCursorPosition((e) => {
      uiStore.getState().setCursor(e.position.lineNumber, e.position.column);
    });

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const id = targetUriRef.current || tabsStore.getState().activeId;
      if (id) void tabsStore.getState().saveTab(id);
    });

    const ro = new ResizeObserver(() => layout());
    ro.observe(containerRef.current);
    window.addEventListener("resize", layout);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      ro.disconnect();
      window.removeEventListener("resize", layout);
      editor.dispose();
      editorRef.current = null;
    };
  }, []);

  // 当 targetUri 变化或文件内容就绪时更新 Model
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    if (!targetUri) {
      editor.setModel(null);
      return;
    }

    const model = getModel(targetUri);
    if (model) {
      editor.setModel(model);
      editor.updateOptions({ readOnly: false });
      requestAnimationFrame(() => editor.layout());
    } else {
      editor.setModel(null);
    }
  }, [targetUri, activeTab?.error, activeTab?.mtimeMs]);

  // 监听 Model 异步创建完成事件（远程 SSH / WSL 读取完成后派发）
  useEffect(() => {
    const handleModelCreated = (e: Event) => {
      const detail = (e as CustomEvent<{ uri: string }>).detail;
      if (detail && detail.uri === targetUri && editorRef.current) {
        const m = getModel(targetUri);
        if (m) {
          editorRef.current.setModel(m);
          editorRef.current.updateOptions({ readOnly: false });
          requestAnimationFrame(() => editorRef.current?.layout());
        }
      }
    };
    window.addEventListener("glance:model-created", handleModelCreated);
    return () => window.removeEventListener("glance:model-created", handleModelCreated);
  }, [targetUri]);

  // 动态响应字体大小与主题变更
  useEffect(() => {
    editorRef.current?.updateOptions({ fontSize });
  }, [fontSize]);

  useEffect(() => {
    monaco.editor.setTheme(monacoThemeFor(theme));
  }, [theme]);

  // 搜索跳转定位
  const pendingReveal = tabsStore((s) => s.pendingReveal);
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !pendingReveal) return;
    if (pendingReveal.uri === targetUri) {
      editor.revealLineInCenter(pendingReveal.line);
      editor.setPosition({ lineNumber: pendingReveal.line, column: 1 });
      editor.focus();
      tabsStore.getState().consumeReveal();
    }
  }, [pendingReveal, targetUri]);

  // 如果标签加载失败，提供友好的错误提示与重试按钮（以覆盖层形式显示，保证编辑器容器始终挂载）
  return (
    <div className="relative flex-1 w-full min-h-0 overflow-hidden flex flex-col">
      <div ref={containerRef} className="absolute inset-0" />
      {activeTab?.error && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-zinc-950 p-6 text-center text-zinc-400 select-text">
          <div className="mb-3 rounded-full bg-red-950/80 p-3 text-red-400 border border-red-800/60">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <p className="text-sm font-semibold text-zinc-200">无法打开文件</p>
          <p className="mt-1.5 max-w-md text-xs text-red-400/90 font-mono break-all">{activeTab.error}</p>
          <button
            onClick={() => void tabsStore.getState().reopenFile(activeTab.path, activeTab.uri)}
            className="mt-4 rounded bg-sky-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-500 transition-colors"
          >
            重新尝试加载
          </button>
        </div>
      )}
    </div>
  );
}
