import { useEffect, useRef, useState } from "react";
import { workspaceApi, type SearchHit } from "../../services/workspace";
import { explorerStore } from "../../stores/explorer";
import { tabsStore } from "../../stores/tabs";
import { IconSearch } from "../common/icons";

/** 全局搜索面板（M1 任务 1.6）：按文件分组，点击命中行打开文件并定位 */
export function SearchPanel() {
  const rootPath = explorerStore((s) => s.rootPath);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seqRef = useRef(0);

  const isRemoteOrWsl =
    !!rootPath && (rootPath.startsWith("remote://") || rootPath.startsWith("wsl://"));

  useEffect(() => {
    const seq = ++seqRef.current;
    if (timerRef.current) clearTimeout(timerRef.current);

    if (!rootPath || isRemoteOrWsl || !query.trim()) {
      setHits([]);
      setSearching(false);
      setSearched(false);
      setError(null);
      return;
    }

    timerRef.current = setTimeout(async () => {
      setSearching(true);
      setError(null);
      try {
        const result = await workspaceApi.search(rootPath, query);
        if (seq !== seqRef.current) return;
        setHits(result);
        setSearched(true);
      } catch (err) {
        if (seq !== seqRef.current) return;
        setHits([]);
        setSearched(true);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (seq === seqRef.current) {
          setSearching(false);
        }
      }
    }, 350);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [query, rootPath, isRemoteOrWsl]);

  // 按文件分组
  const groups = new Map<string, SearchHit[]>();
  for (const hit of hits) {
    const list = groups.get(hit.path) ?? [];
    list.push(hit);
    groups.set(hit.path, list);
  }

  function highlight(hit: SearchHit) {
    const { matchStart, matchLen, lineText } = hit;
    return (
      <>
        {lineText.slice(0, matchStart)}
        <mark
          style={{
            background: "var(--glance-highlight-bg)",
            color: "var(--glance-highlight-text)",
          }}
          className="rounded-sm px-0.5"
        >
          {lineText.slice(matchStart, matchStart + matchLen)}
        </mark>
        {lineText.slice(matchStart + matchLen)}
      </>
    );
  }

  return (
    <div className="flex h-full flex-col bg-zinc-900">
      <div className="flex h-9 shrink-0 items-center px-3 text-xs font-semibold uppercase tracking-wide text-zinc-400">
        搜索
      </div>
      <div className="px-2 pb-2">
        <div className="flex items-center gap-1.5 rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 focus-within:border-sky-600">
          <IconSearch size={13} className="text-zinc-500" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              !rootPath
                ? "先打开文件夹"
                : isRemoteOrWsl
                  ? "当前仅支持本机工作区全文搜索"
                  : "在文件夹中搜索…"
            }
            disabled={!rootPath || isRemoteOrWsl}
            className="w-full bg-transparent text-sm text-zinc-200 outline-none placeholder:text-zinc-600"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {isRemoteOrWsl && (
          <p className="px-1 py-1 text-xs text-zinc-500">
            暂不支持在 SSH / WSL 远程工作区中直接全文搜索。
          </p>
        )}
        {error && (
          <p className="break-words px-1 py-1 text-xs text-red-400">
            搜索失败：{error}
          </p>
        )}
        {searching && <p className="px-1 py-1 text-xs text-zinc-500">搜索中…</p>}
        {!searching && !error && !isRemoteOrWsl && searched && hits.length === 0 && query.trim() && (
          <p className="px-1 py-1 text-xs text-zinc-500">无结果</p>
        )}
        {[...groups.entries()].map(([path, list]) => (
          <div key={path} className="mb-2">
            <p className="truncate px-1 py-0.5 text-[11px] text-zinc-500" title={path}>
              {path.split(/[\\/]/).pop()}{" "}
              <span className="text-zinc-700">({list.length})</span>
            </p>
            {list.map((hit, i) => (
              <button
                key={`${hit.path}:${hit.lineNumber}:${i}`}
                onClick={() => void tabsStore.getState().openFileAtLine(hit.path, hit.lineNumber)}
                className="block w-full truncate rounded px-2 py-1 text-left font-mono text-xs text-zinc-300 hover:bg-zinc-800"
                title={hit.path}
              >
                <span className="mr-2 text-zinc-600">{hit.lineNumber}</span>
                {highlight(hit)}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
