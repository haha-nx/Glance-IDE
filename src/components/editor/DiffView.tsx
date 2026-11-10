import { useEffect, useRef, useState } from "react";
import { monaco, languageForFileName } from "../../lib/monaco";
import { getModel } from "../../lib/models";
import { filesApi } from "../../services/files";
import { tabsStore } from "../../stores/tabs";

/**
 * 本地 Diff 视图（M1 任务 1.6）：磁盘版本 ↔ 当前编辑缓冲区。
 * 同时服务保存冲突场景的人工核对（§5.4 冲突比较）。
 */
export function DiffView({ uri, onClose }: { uri: string; onClose: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let diff: monaco.editor.IStandaloneDiffEditor | null = null;
    let originalModel: monaco.editor.ITextModel | null = null;
    let modifiedModel: monaco.editor.ITextModel | null = null;

    (async () => {
      const tab = tabsStore.getState().tabs.find((t) => t.uri === uri);
      if (!tab || !containerRef.current) return;
      try {
        const disk = await filesApi.readFile(tab.path);
        if (disposed) return;
        const lang = languageForFileName(tab.name);
        // 用户偏好：左 = 当前改动，右 = 磁盘原版（旧→新 的阅读方向反转）
        const original = monaco.editor.createModel(disk.binary ? "" : (disk.text ?? ""), lang);
        const current = getModel(uri);
        const modified = monaco.editor.createModel(current?.getValue() ?? "", lang);
        originalModel = original;
        modifiedModel = modified;
        diff = monaco.editor.createDiffEditor(containerRef.current, {
          theme: "glance-dark",
          readOnly: true,
          renderSideBySide: true,
          automaticLayout: true,
          renderOverviewRuler: false,
        });
        diff.setModel({ original: modified, modified: original });
      } catch (err) {
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      disposed = true;
      diff?.dispose();
      originalModel?.dispose();
      modifiedModel?.dispose();
    };
  }, [uri]);

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex h-8 items-center justify-between border-b border-zinc-800 bg-zinc-950 px-3 text-xs text-zinc-500">
        <span>Diff：左 = 当前编辑缓冲区 · 右 = 磁盘原版（只读）</span>
        <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300" title="关闭 Diff">
          ✕
        </button>
      </div>
      {error ? (
        <div className="flex flex-1 items-center justify-center text-sm text-red-400">{error}</div>
      ) : (
        <div ref={containerRef} className="min-h-0 flex-1" />
      )}
    </div>
  );
}
