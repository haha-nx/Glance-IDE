import { useEffect, useRef, useState } from "react";
import { monaco, languageForFileName, monacoThemeFor, setupMonaco } from "../../lib/monaco";
import { settingsStore } from "../../stores/settings";
import { tabsStore, type GitDiffTabSpec } from "../../stores/tabs";

/**
 * Git 文件对比（Diff）视图：
 * - 基于 Monaco StandaloneDiffEditor，支持工作区对比、暂存区对比与提交历史对比；
 * - 统一支持本地、WSL 与远程 SSH 仓库文件与历史对象对比；
 * - 支持并排 / 内联模式切换、手动刷新，以及一键打开工作区可编辑文件。
 */
export function GitDiffView({ uri, diff }: { uri: string; diff: GitDiffTabSpec }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const diffEditorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const modelsRef = useRef<{
    orig: monaco.editor.ITextModel;
    mod: monaco.editor.ITextModel;
  } | null>(null);

  const fontSize = settingsStore((s) => s.fontSize);
  const theme = settingsStore((s) => s.theme);
  const [sideBySide, setSideBySide] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fileName = diff.data.filePath.split("/").pop() || diff.data.filePath;
  const lang = languageForFileName(fileName);

  // 初始化与更新 DiffEditor 及左右对比 Model
  useEffect(() => {
    if (!containerRef.current || diff.data.isBinary) return;
    setupMonaco();

    const { fontSize: initSize, theme: initTheme } = settingsStore.getState();
    const diffEditor = monaco.editor.createDiffEditor(containerRef.current, {
      theme: monacoThemeFor(initTheme),
      fontSize: initSize,
      fontFamily:
        '"SF Mono", Menlo, Monaco, "Cascadia Code", "JetBrains Mono", Consolas, monospace',
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: sideBySide,
      scrollBeyondLastLine: false,
      renderIndicators: true,
      ignoreTrimWhitespace: false,
      minimap: { enabled: false },
    });
    diffEditorRef.current = diffEditor;

    const orig = monaco.editor.createModel(diff.data.originalText, lang);
    const mod = monaco.editor.createModel(diff.data.modifiedText, lang);
    modelsRef.current = { orig, mod };
    diffEditor.setModel({ original: orig, modified: mod });

    const layout = () => {
      if (!containerRef.current || !diffEditorRef.current) return;
      const { clientWidth, clientHeight } = containerRef.current;
      if (clientWidth > 0 && clientHeight > 0) {
        diffEditorRef.current.layout({ width: clientWidth, height: clientHeight });
      } else {
        diffEditorRef.current.layout();
      }
    };
    requestAnimationFrame(layout);
    const ro = new ResizeObserver(() => layout());
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      // 必须先解绑 DiffEditor Model 再分别销毁编辑器与临时 Model，防止 Monaco 报错
      diffEditor.setModel(null);
      diffEditor.dispose();
      diffEditorRef.current = null;
      orig.dispose();
      mod.dispose();
      modelsRef.current = null;
    };
  }, [uri, diff.data.isBinary, lang]);

  // 当同一对比标签被刷新时，就地同步左右 Model 文本而不重建编辑器
  useEffect(() => {
    const pair = modelsRef.current;
    if (!pair) return;
    if (pair.orig.getValue() !== diff.data.originalText) {
      pair.orig.setValue(diff.data.originalText);
    }
    if (pair.mod.getValue() !== diff.data.modifiedText) {
      pair.mod.setValue(diff.data.modifiedText);
    }
  }, [diff.data.originalText, diff.data.modifiedText]);

  // 同步字体大小、主题与并排/内联显示模式
  useEffect(() => {
    monaco.editor.setTheme(monacoThemeFor(theme));
    diffEditorRef.current?.updateOptions({
      fontSize,
      renderSideBySide: sideBySide,
    });
  }, [fontSize, theme, sideBySide]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await tabsStore.getState().openGitDiff({
        title: diff.title,
        uriKey: diff.uriKey,
        request: diff.request,
      });
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-zinc-900">
      {/* 对比顶栏：显示左右版本标签、模式切换与文件跳转 */}
      <div className="flex h-8 shrink-0 items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-950/70 px-3 text-xs select-none">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-zinc-300" title={diff.data.filePath}>
            {diff.data.filePath}
          </span>
          <span className="shrink-0 rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0 text-[10px] text-zinc-400">
            {diff.data.originalLabel}
          </span>
          <span className="shrink-0 text-zinc-500">⇄</span>
          <span className="shrink-0 rounded border border-sky-500/40 bg-sky-500/15 px-1.5 py-0 text-[10px] text-sky-300">
            {diff.data.modifiedLabel}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            onClick={() => setSideBySide((v) => !v)}
            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-300 hover:border-zinc-500 hover:text-zinc-100"
            title="切换并排对比与内联对比"
          >
            {sideBySide ? "并排" : "内联"}
          </button>
          <button
            onClick={() => void handleRefresh()}
            disabled={refreshing}
            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-300 hover:border-zinc-500 hover:text-zinc-100 disabled:opacity-40"
            title="重新读取对比内容"
          >
            {refreshing ? "刷新中…" : "刷新"}
          </button>
          {diff.request.status !== "D" && (
            <button
              onClick={() => void tabsStore.getState().openFileByPath(diff.data.fileUri)}
              className="rounded border border-sky-500/40 bg-sky-600/20 px-2 py-0.5 text-[11px] text-sky-300 hover:bg-sky-600/30"
              title="在编辑器中打开当前工作区文件"
            >
              打开文件
            </button>
          )}
        </div>
      </div>

      {/* 对比正文 */}
      {diff.data.isBinary ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-xs text-zinc-400 select-none">
          <p>{diff.data.errorNote || "二进制文件暂不支持文本对比"}</p>
          {diff.request.status !== "D" && (
            <button
              onClick={() => void tabsStore.getState().openFileByPath(diff.data.fileUri)}
              className="rounded bg-zinc-800 px-3 py-1 text-zinc-200 hover:bg-zinc-700"
            >
              尝试打开工作区文件
            </button>
          )}
        </div>
      ) : (
        <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden" />
      )}
    </div>
  );
}
