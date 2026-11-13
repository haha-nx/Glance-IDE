import { useEffect, useMemo, useRef, useState } from "react";
import { gitApi, type GitCommitDto, type GitCommitFileDto, type GitRefDto } from "../../services/git";
import { tabsStore } from "../../stores/tabs";

const LANE_COLORS = [
  "#38bdf8", // sky-400
  "#34d399", // emerald-400
  "#fbbf24", // amber-400
  "#a78bfa", // violet-400
  "#f472b6", // pink-400
  "#22d3ee", // cyan-400
];

const ROW_HEIGHT = 28;
const NODE_CY = ROW_HEIGHT / 2;
const DEFAULT_LANE_SPACING = 13;
const PAD_LEFT = 10;

interface Slot {
  targetHash: string;
  colorIndex: number;
  dashed?: boolean;
}

export interface GraphEdge {
  fromCol: number;
  toCol: number;
  colorIndex: number;
  dashed?: boolean;
}

export interface ContinuationCol {
  col: number;
  colorIndex: number;
  dashed?: boolean;
}

export interface GraphRowLayout {
  key: string;
  kind: "pending" | "commit";
  commit?: GitCommitDto;
  nodeCol: number;
  nodeColor: number;
  isMerge: boolean;
  topEdges: GraphEdge[];
  bottomEdges: GraphEdge[];
  continuationCols: ContinuationCol[];
}

function colorAt(index: number): string {
  return LANE_COLORS[((index % LANE_COLORS.length) + LANE_COLORS.length) % LANE_COLORS.length]!;
}

function laneX(col: number, spacing: number): number {
  return PAD_LEFT + col * spacing;
}

function firstFreeCol(slots: (Slot | null)[]): number {
  const idx = slots.findIndex((s) => s === null);
  return idx >= 0 ? idx : slots.length;
}

export function buildCommitGraphRows(
  commits: GitCommitDto[],
  hasPendingChanges: boolean,
): { rows: GraphRowLayout[]; maxCols: number } {
  const rows: GraphRowLayout[] = [];
  let slots: (Slot | null)[] = [];
  let nextColor = 0;

  const allocColor = () => nextColor++;

  const headHash =
    commits.find((c) => c.isHead)?.hash ?? (commits.length > 0 ? commits[0]!.hash : null);

  if (hasPendingChanges) {
    if (headHash) {
      const cIdx = allocColor();
      slots = [{ targetHash: headHash, colorIndex: cIdx, dashed: true }];
      rows.push({
        key: "__pending__",
        kind: "pending",
        nodeCol: 0,
        nodeColor: cIdx,
        isMerge: false,
        topEdges: [],
        bottomEdges: [{ fromCol: 0, toCol: 0, colorIndex: cIdx, dashed: true }],
        continuationCols: [{ col: 0, colorIndex: cIdx, dashed: true }],
      });
    } else {
      const cIdx = allocColor();
      rows.push({
        key: "__pending__",
        kind: "pending",
        nodeCol: 0,
        nodeColor: cIdx,
        isMerge: false,
        topEdges: [],
        bottomEdges: [],
        continuationCols: [],
      });
    }
  }

  for (const commit of commits) {
    const lanesBefore = [...slots];
    const matchingCols: number[] = [];
    for (let col = 0; col < lanesBefore.length; col++) {
      if (lanesBefore[col]?.targetHash === commit.hash) {
        matchingCols.push(col);
      }
    }

    let nodeCol: number;
    let nodeColor: number;
    if (matchingCols.length > 0) {
      nodeCol = matchingCols[0]!;
      nodeColor = lanesBefore[nodeCol]!.colorIndex;
    } else {
      nodeCol = firstFreeCol(lanesBefore);
      nodeColor = allocColor();
    }

    const topEdges: GraphEdge[] = [];
    for (let col = 0; col < lanesBefore.length; col++) {
      const slot = lanesBefore[col];
      if (!slot) continue;
      if (slot.targetHash === commit.hash) {
        topEdges.push({
          fromCol: col,
          toCol: nodeCol,
          colorIndex: slot.colorIndex,
          dashed: slot.dashed,
        });
      } else {
        topEdges.push({
          fromCol: col,
          toCol: col,
          colorIndex: slot.colorIndex,
          dashed: slot.dashed,
        });
      }
    }

    const lanesAfter: (Slot | null)[] = lanesBefore.map((slot) =>
      slot && slot.targetHash === commit.hash ? null : slot,
    );

    const bottomEdges: GraphEdge[] = [];
    for (let col = 0; col < lanesAfter.length; col++) {
      const slot = lanesAfter[col];
      if (!slot) continue;
      bottomEdges.push({
        fromCol: col,
        toCol: col,
        colorIndex: slot.colorIndex,
        dashed: slot.dashed,
      });
    }

    for (let pIdx = 0; pIdx < commit.parents.length; pIdx++) {
      const parentHash = commit.parents[pIdx]!;
      const existingCol = lanesAfter.findIndex((s) => s !== null && s.targetHash === parentHash);
      if (existingCol >= 0) {
        const edgeColor = pIdx === 0 ? nodeColor : lanesAfter[existingCol]!.colorIndex;
        bottomEdges.push({
          fromCol: nodeCol,
          toCol: existingCol,
          colorIndex: edgeColor,
        });
      } else if (pIdx === 0) {
        while (lanesAfter.length <= nodeCol) lanesAfter.push(null);
        lanesAfter[nodeCol] = { targetHash: parentHash, colorIndex: nodeColor };
        bottomEdges.push({
          fromCol: nodeCol,
          toCol: nodeCol,
          colorIndex: nodeColor,
        });
      } else {
        const freeCol = firstFreeCol(lanesAfter);
        const branchColor = allocColor();
        while (lanesAfter.length <= freeCol) lanesAfter.push(null);
        lanesAfter[freeCol] = { targetHash: parentHash, colorIndex: branchColor };
        bottomEdges.push({
          fromCol: nodeCol,
          toCol: freeCol,
          colorIndex: branchColor,
        });
      }
    }

    while (lanesAfter.length > 0 && lanesAfter[lanesAfter.length - 1] === null) {
      lanesAfter.pop();
    }

    const continuationCols: ContinuationCol[] = [];
    for (let col = 0; col < lanesAfter.length; col++) {
      const slot = lanesAfter[col];
      if (slot) {
        continuationCols.push({
          col,
          colorIndex: slot.colorIndex,
          dashed: slot.dashed,
        });
      }
    }

    slots = lanesAfter;

    rows.push({
      key: commit.hash,
      kind: "commit",
      commit,
      nodeCol,
      nodeColor,
      isMerge: commit.parents.length > 1,
      topEdges,
      bottomEdges,
      continuationCols,
    });
  }

  let maxCol = 0;
  for (const r of rows) {
    maxCol = Math.max(maxCol, r.nodeCol);
    for (const e of r.topEdges) maxCol = Math.max(maxCol, e.fromCol, e.toCol);
    for (const e of r.bottomEdges) maxCol = Math.max(maxCol, e.fromCol, e.toCol);
  }

  return { rows, maxCols: maxCol + 1 };
}

function refBadgeClass(r: GitRefDto): string {
  if (r.kind === "head") {
    return "border-sky-500/50 bg-sky-500/20 text-sky-300 font-medium";
  }
  if (r.kind === "remote") {
    return "border-emerald-500/40 bg-emerald-500/15 text-emerald-300";
  }
  if (r.kind === "tag") {
    return "border-amber-500/40 bg-amber-500/15 text-amber-300";
  }
  return "border-violet-500/40 bg-violet-500/15 text-violet-300";
}

function fileStatusClass(status: string): string {
  switch (status) {
    case "M":
      return "text-amber-400";
    case "A":
      return "text-emerald-400";
    case "D":
      return "text-red-400";
    case "R":
    case "C":
      return "text-sky-400";
    default:
      return "text-zinc-400";
  }
}

function GraphTrackSvg({
  row,
  svgWidth,
  spacing,
}: {
  row: GraphRowLayout;
  svgWidth: number;
  spacing: number;
}) {
  const cx = laneX(row.nodeCol, spacing);
  const nodeStroke = colorAt(row.nodeColor);
  const isHead = row.commit?.isHead ?? false;

  return (
    <svg
      width={svgWidth}
      height={ROW_HEIGHT}
      viewBox={`0 0 ${svgWidth} ${ROW_HEIGHT}`}
      className="shrink-0 block"
      aria-hidden="true"
    >
      {row.topEdges.map((e, idx) => {
        const x1 = laneX(e.fromCol, spacing);
        const x2 = laneX(e.toCol, spacing);
        const stroke = colorAt(e.colorIndex);
        if (x1 === x2) {
          return (
            <line
              key={`t:${idx}`}
              x1={x1}
              y1={0}
              x2={x2}
              y2={NODE_CY}
              stroke={stroke}
              strokeWidth={1.6}
              strokeDasharray={e.dashed ? "2.5 2.5" : undefined}
            />
          );
        }
        return (
          <path
            key={`t:${idx}`}
            d={`M ${x1} 0 C ${x1} ${NODE_CY * 0.55}, ${x2} ${NODE_CY * 0.45}, ${x2} ${NODE_CY}`}
            fill="none"
            stroke={stroke}
            strokeWidth={1.6}
            strokeDasharray={e.dashed ? "2.5 2.5" : undefined}
          />
        );
      })}

      {row.bottomEdges.map((e, idx) => {
        const x1 = laneX(e.fromCol, spacing);
        const x2 = laneX(e.toCol, spacing);
        const stroke = colorAt(e.colorIndex);
        if (x1 === x2) {
          return (
            <line
              key={`b:${idx}`}
              x1={x1}
              y1={NODE_CY}
              x2={x2}
              y2={ROW_HEIGHT}
              stroke={stroke}
              strokeWidth={1.6}
              strokeDasharray={e.dashed ? "2.5 2.5" : undefined}
            />
          );
        }
        return (
          <path
            key={`b:${idx}`}
            d={`M ${x1} ${NODE_CY} C ${x1} ${NODE_CY + NODE_CY * 0.55}, ${x2} ${NODE_CY + NODE_CY * 0.45}, ${x2} ${ROW_HEIGHT}`}
            fill="none"
            stroke={stroke}
            strokeWidth={1.6}
            strokeDasharray={e.dashed ? "2.5 2.5" : undefined}
          />
        );
      })}

      {row.kind === "pending" ? (
        <circle
          cx={cx}
          cy={NODE_CY}
          r={4}
          fill="var(--glance-bg, #18181b)"
          stroke={nodeStroke}
          strokeWidth={1.6}
          strokeDasharray="2 1.8"
        />
      ) : isHead ? (
        <>
          <circle
            cx={cx}
            cy={NODE_CY}
            r={5}
            fill="var(--glance-bg, #18181b)"
            stroke={nodeStroke}
            strokeWidth={1.6}
          />
          <circle cx={cx} cy={NODE_CY} r={2.5} fill={nodeStroke} />
        </>
      ) : row.isMerge ? (
        <>
          <circle
            cx={cx}
            cy={NODE_CY}
            r={4.2}
            fill="var(--glance-bg, #18181b)"
            stroke={nodeStroke}
            strokeWidth={1.8}
          />
          <circle cx={cx} cy={NODE_CY} r={1.6} fill={nodeStroke} />
        </>
      ) : (
        <circle
          cx={cx}
          cy={NODE_CY}
          r={3.5}
          fill={nodeStroke}
          stroke="var(--glance-bg, #18181b)"
          strokeWidth={1.2}
        />
      )}
    </svg>
  );
}

export function CommitGraph({
  repoRoot,
  commits,
  pendingCount,
  graphError,
  onRetryGraph,
  onCopyHash,
}: {
  repoRoot: string;
  commits: GitCommitDto[];
  pendingCount: number;
  graphError?: string | null;
  onRetryGraph?: () => void;
  onCopyHash?: (shortHash: string) => void;
}) {
  const [expandedHash, setExpandedHash] = useState<string | null>(null);
  const [filesByHash, setFilesByHash] = useState<Record<string, GitCommitFileDto[]>>({});
  const [errorByHash, setErrorByHash] = useState<Record<string, string>>({});
  const [loadingHash, setLoadingHash] = useState<string | null>(null);
  const repoRootRef = useRef(repoRoot);
  repoRootRef.current = repoRoot;

  // 切换仓库时重置展开项与缓存；提交哈希内容不可变，避免后台刷新 commits 引用时误清已加载详情
  useEffect(() => {
    setExpandedHash(null);
    setFilesByHash({});
    setErrorByHash({});
    setLoadingHash(null);
  }, [repoRoot]);

  const { rows, maxCols } = useMemo(
    () => buildCommitGraphRows(commits, pendingCount > 0),
    [commits, pendingCount],
  );

  // 根据分支轨道数自适应间距，既不裁剪任何轨道，又为提交文本留出充足宽度
  const laneSpacing =
    maxCols > 6 ? Math.max(7, Math.floor((88 - PAD_LEFT - 10) / (maxCols - 1))) : DEFAULT_LANE_SPACING;
  const svgWidth = Math.max(24, PAD_LEFT + Math.max(0, maxCols - 1) * laneSpacing + 12);

  const loadCommitFiles = async (hash: string) => {
    const targetRoot = repoRootRef.current;
    setLoadingHash(hash);
    setErrorByHash((prev) => {
      if (!(hash in prev)) return prev;
      const next = { ...prev };
      delete next[hash];
      return next;
    });
    try {
      const files = await gitApi.commitFiles(targetRoot, hash);
      if (repoRootRef.current !== targetRoot) return;
      setFilesByHash((prev) => ({ ...prev, [hash]: files }));
    } catch (e) {
      if (repoRootRef.current !== targetRoot) return;
      const msg = e instanceof Error ? e.message : String(e);
      setErrorByHash((prev) => ({ ...prev, [hash]: msg || "无法加载提交文件变更" }));
    } finally {
      if (repoRootRef.current === targetRoot) {
        setLoadingHash((curr) => (curr === hash ? null : curr));
      }
    }
  };

  const handleToggleCommit = async (commit: GitCommitDto) => {
    if (expandedHash === commit.hash) {
      setExpandedHash(null);
      return;
    }
    setExpandedHash(commit.hash);
    if (filesByHash[commit.hash] !== undefined) return;
    await loadCommitFiles(commit.hash);
  };

  if (rows.length === 0) {
    if (graphError) {
      return (
        <div className="space-y-1.5 px-3 py-3 text-[11px]">
          <p className="break-words text-red-400">提交图谱加载失败：{graphError}</p>
          {onRetryGraph && (
            <button
              onClick={onRetryGraph}
              className="rounded border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[10px] text-zinc-200 hover:bg-zinc-800"
            >
              重试加载
            </button>
          )}
        </div>
      );
    }
    return <p className="px-3 py-4 text-center text-[11px] text-zinc-500">暂无提交历史图谱</p>;
  }

  return (
    <div className="pb-2">
      {graphError && (
        <div className="mx-2 my-1.5 flex items-center justify-between gap-2 rounded border border-red-900/60 bg-red-950/30 px-2 py-1 text-[10px] text-red-300">
          <span className="min-w-0 flex-1 break-words">图谱加载受限：{graphError}</span>
          {onRetryGraph && (
            <button
              onClick={onRetryGraph}
              className="shrink-0 rounded border border-red-800/70 bg-red-900/40 px-1.5 py-0.5 text-[10px] text-red-100 hover:bg-red-800/50"
            >
              重试
            </button>
          )}
        </div>
      )}
      {rows.map((row) => {
        if (row.kind === "pending") {
          return (
            <div
              key={row.key}
              style={{ height: ROW_HEIGHT }}
              className="flex items-center pr-2.5 text-xs text-zinc-400"
              title={`当前工作区有 ${pendingCount} 项未提交更改`}
            >
              <GraphTrackSvg row={row} svgWidth={svgWidth} spacing={laneSpacing} />
              <span className="ml-1 truncate italic text-zinc-400">
                工作区更改 ({pendingCount})
              </span>
            </div>
          );
        }

        const c = row.commit!;
        const isExpanded = expandedHash === c.hash;
        const files = filesByHash[c.hash];
        const commitError = errorByHash[c.hash];

        return (
          <div key={row.key}>
            <div
              onClick={() => void handleToggleCommit(c)}
              style={{ height: ROW_HEIGHT }}
              title={`${c.subject}\n${c.hash} • ${c.author} • ${c.relativeTime}（点击展开详情）`}
              className={`group flex cursor-pointer items-center pr-2.5 text-xs transition-colors ${
                isExpanded ? "bg-sky-500/10" : "hover:bg-zinc-800/70"
              }`}
            >
              <GraphTrackSvg row={row} svgWidth={svgWidth} spacing={laneSpacing} />

              <div className="ml-1 flex min-w-0 flex-1 items-center gap-1.5">
                {c.refs.slice(0, 2).map((r) => (
                  <span
                    key={`${r.kind}:${r.name}`}
                    className={`shrink-0 max-w-[92px] truncate rounded border px-1 py-0 text-[10px] leading-4 ${refBadgeClass(r)}`}
                    title={r.name}
                  >
                    {r.name}
                  </span>
                ))}
                {c.refs.length > 2 && (
                  <span className="shrink-0 rounded border border-zinc-700 bg-zinc-800 px-1 text-[10px] leading-4 text-zinc-400">
                    +{c.refs.length - 2}
                  </span>
                )}
                <span
                  className={`min-w-0 flex-1 truncate ${
                    c.isHead ? "font-medium text-zinc-100" : "text-zinc-300"
                  }`}
                >
                  {c.subject || "(无提交说明)"}
                </span>
                <span className="hidden shrink-0 text-[10px] text-zinc-500 group-hover:inline">
                  {c.shortHash}
                </span>
              </div>
            </div>

            {isExpanded && (
              <div className="relative flex bg-zinc-950/60 border-y border-zinc-800/80">
                {/* 保持轨道线垂直贯穿展开的详情卡 */}
                <div style={{ width: svgWidth }} className="relative shrink-0">
                  <svg
                    width={svgWidth}
                    height="100%"
                    className="absolute inset-0 h-full w-full"
                    preserveAspectRatio="none"
                    aria-hidden="true"
                  >
                    {row.continuationCols.map((colItem) => {
                      const x = laneX(colItem.col, laneSpacing);
                      return (
                        <line
                          key={colItem.col}
                          x1={x}
                          y1="0%"
                          x2={x}
                          y2="100%"
                          stroke={colorAt(colItem.colorIndex)}
                          strokeWidth={1.6}
                          strokeDasharray={colItem.dashed ? "2.5 2.5" : undefined}
                        />
                      );
                    })}
                  </svg>
                </div>

                <div className="min-w-0 flex-1 py-2 pr-2.5 pl-1 space-y-1.5 text-[11px]">
                  <div className="font-medium text-zinc-200 break-words select-text">
                    {c.subject || "(无提交说明)"}
                  </div>

                  {c.refs.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {c.refs.map((r) => (
                        <span
                          key={`detail:${r.kind}:${r.name}`}
                          className={`rounded border px-1.5 py-0 text-[10px] leading-4 ${refBadgeClass(r)}`}
                        >
                          {r.name}
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[10px] text-zinc-400">
                    <span>{c.author}</span>
                    <span>•</span>
                    <span>{c.relativeTime}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void navigator.clipboard?.writeText(c.hash);
                        onCopyHash?.(c.shortHash);
                      }}
                      className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0 font-mono text-[10px] text-sky-400 hover:border-sky-500/50"
                      title={`点击复制完整哈希 ${c.hash}`}
                    >
                      {c.shortHash}
                    </button>
                  </div>

                  {loadingHash === c.hash ? (
                    <p className="text-[10px] text-zinc-500">正在读取变更文件…</p>
                  ) : commitError ? (
                    <div className="flex items-center justify-between gap-2 text-[10px]">
                      <span className="min-w-0 flex-1 break-words text-red-400">{commitError}</span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          void loadCommitFiles(c.hash);
                        }}
                        className="shrink-0 rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-zinc-200 hover:bg-zinc-800"
                      >
                        重试
                      </button>
                    </div>
                  ) : files === undefined ? (
                    <div className="flex items-center justify-between gap-2 text-[10px] text-zinc-500">
                      <span>尚未加载变更文件</span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          void loadCommitFiles(c.hash);
                        }}
                        className="shrink-0 rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-zinc-200 hover:bg-zinc-800"
                      >
                        加载文件
                      </button>
                    </div>
                  ) : files.length > 0 ? (
                    <div className="pt-1 space-y-0.5">
                      <div className="text-[10px] text-zinc-500">变更文件 ({files.length})</div>
                      <div className="max-h-36 overflow-y-auto space-y-0.5">
                        {files.map((f) => {
                          const norm = f.path.replace(/\\/g, "/");
                          const idx = norm.lastIndexOf("/");
                          const name = idx >= 0 ? norm.slice(idx + 1) : norm;
                          const dir = idx >= 0 ? norm.slice(0, idx) : "";
                          return (
                            <div
                              key={`${f.status}:${f.path}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                void tabsStore.getState().openGitDiff({
                                  title: `${name} (${c.shortHash})`,
                                  uriKey: `commit/${repoRoot}/${c.hash}/${f.path}`,
                                  request: {
                                    root: repoRoot,
                                    mode: "commit",
                                    path: f.path,
                                    oldPath: f.oldPath,
                                    status: f.status,
                                    commitHash: c.hash,
                                    parentHash: c.parents[0] ?? null,
                                  },
                                });
                              }}
                              title={`${f.path}（点击查看文件对比）`}
                              className="group/file flex w-full cursor-pointer items-center justify-between gap-2 rounded px-1.5 py-0.5 text-left hover:bg-zinc-800/80"
                            >
                              <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                                <span className="truncate text-[11px] text-zinc-200">{name}</span>
                                {dir && <span className="truncate text-[10px] text-zinc-500">{dir}</span>}
                              </span>
                              <span className="flex shrink-0 items-center gap-1">
                                {f.status !== "D" && (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void tabsStore.getState().openFileByPath(f.uri);
                                    }}
                                    title="打开工作区当前文件"
                                    className="hidden rounded px-1 py-0 text-[10px] text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100 group-hover/file:inline-block"
                                  >
                                    打开
                                  </button>
                                )}
                                <span
                                  className={`font-mono text-[10px] font-semibold ${fileStatusClass(f.status)}`}
                                >
                                  {f.status}
                                </span>
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : (
                    <p className="text-[10px] text-zinc-500">该提交未记录文件变更</p>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
