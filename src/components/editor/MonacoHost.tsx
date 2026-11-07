import { useEffect, useRef } from "react";
import { monaco, setupMonaco } from "../../lib/monaco";
import { getModel } from "../../lib/models";
import { tabsStore } from "../../stores/tabs";
import { uiStore } from "../../stores/ui";

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

let editorInstance: monaco.editor.IStandaloneCodeEditor | null = null;

export function MonacoHost() {
  const containerRef = useRef<HTMLDivElement>(null);
  const activeId = tabsStore((s) => s.activeId);

  useEffect(() => {
    if (!containerRef.current) return;
    setupMonaco();

    const editor = monaco.editor.create(containerRef.current, {
      theme: "glance-dark",
      automaticLayout: true,
      fontSize: 13,
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
    editorInstance = editor;

    editor.onDidChangeCursorPosition((e) => {
      uiStore.getState().setCursor(e.position.lineNumber, e.position.column);
    });

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const { activeId: id, saveTab } = tabsStore.getState();
      if (id) void saveTab(id);
    });

    const ro = new ResizeObserver(() => editor.layout());
    ro.observe(containerRef.current);
    // 全屏 ↔ 窗口切换时 macOS 窗口尺寸突变，ResizeObserver 偶发漏触发，
    // 显式监听窗口 resize 强制重排版（修复 minimap/Diff 按钮区域消失）
    const onWinResize = () => editor.layout();
    window.addEventListener("resize", onWinResize);

    return () => {
      ro.disconnect();
      window.removeEventListener("resize", onWinResize);
      editor.dispose();
      editorInstance = null;
    };
  }, []);

  // 切换标签：切换 editor 的 Model（Model 本身常驻注册表）
  useEffect(() => {
    const editor = editorInstance;
    if (!editor) return;

    let placeholder: monaco.editor.ITextModel | null = null;
    if (!activeId) {
      editor.setModel(null);
      editor.updateOptions({ readOnly: false });
      return;
    }
    const model = getModel(activeId);
    if (model) {
      editor.setModel(model);
      editor.updateOptions({ readOnly: false });
    } else {
      // 错误占位标签（二进制/读取失败）：显示只读占位
      const tab = tabsStore.getState().tabs.find((t) => t.uri === activeId);
      placeholder = monaco.editor.createModel(
        tab?.error ?? "无法显示内容",
        "plaintext",
      );
      editor.setModel(placeholder);
      editor.updateOptions({ readOnly: true });
    }
    return () => {
      placeholder?.dispose();
    };
  }, [activeId]);

  // 搜索跳转定位
  const pendingReveal = tabsStore((s) => s.pendingReveal);
  useEffect(() => {
    const editor = editorInstance;
    if (!editor || !pendingReveal) return;
    if (pendingReveal.uri === activeId) {
      editor.revealLineInCenter(pendingReveal.line);
      editor.setPosition({ lineNumber: pendingReveal.line, column: 1 });
      editor.focus();
    }
    tabsStore.getState().consumeReveal();
  }, [pendingReveal, activeId]);

  return <div ref={containerRef} className="h-full w-full" />;
}
