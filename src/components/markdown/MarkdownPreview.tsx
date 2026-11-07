import { useEffect, useState } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { getModel } from "../../lib/models";

/** Markdown 实时预览（M1/M6）：源码来自当前 Model，渲染前经 DOMPurify 消毒 */
export function MarkdownPreview({
  uri,
  fullscreen = false,
}: {
  uri: string;
  /** 全屏预览（源码区已收起） */
  fullscreen?: boolean;
}) {
  const [html, setHtml] = useState("");

  useEffect(() => {
    const model = getModel(uri);
    if (!model) return;

    const render = () => {
      const raw = marked.parse(model.getValue(), { async: false }) as string;
      setHtml(DOMPurify.sanitize(raw));
    };
    render();
    const sub = model.onDidChangeContent(render);
    return () => sub.dispose();
  }, [uri]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-zinc-900">
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-zinc-800 px-3 text-xs text-zinc-500">
        <span>预览{fullscreen ? "（全屏）" : ""}</span>
      </div>
      <div
        className="markdown-body min-h-0 flex-1 overflow-y-auto px-6 py-4 select-text"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
