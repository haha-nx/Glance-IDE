import { appApi } from "../../services/files";
import {
  gitApi,
  type GitFileEntryDto,
  type GitOverviewDto,
  type GitWorktreeDto,
} from "../../services/git";
import { explorerStore } from "../../stores/explorer";
import { Button, DangerButton, Modal, PrimaryButton } from "../common/Modal";
import { IconGitBranch, IconTrash } from "../common/icons";

export interface GitModalsProps {
  rootPath: string;
  activeRepoRoot: string | null;
  overview: GitOverviewDto | null;
  prunableCount: number;
  busyAction: string | null;
  runAction: (label: string, fn: () => Promise<void>) => Promise<void>;
  onNotice: (msg: string) => void;

  wtManagerOpen: boolean;
  onCloseWtManager: () => void;
  onOpenAddWorktree: () => void;

  wtModalOpen: boolean;
  onCloseWtModal: () => void;
  wtCreateBranch: boolean;
  onChangeWtCreateBranch: (create: boolean) => void;
  wtBranch: string;
  onWorktreeBranchChange: (val: string) => void;
  wtBaseRef: string;
  onChangeWtBaseRef: (val: string) => void;
  wtTargetPath: string;
  onChangeWtTargetPath: (val: string) => void;
  wtOpenAfter: "none" | "current" | "newWindow";
  onChangeWtOpenAfter: (val: "none" | "current" | "newWindow") => void;
  onPickWorktreeDir: () => void;
  onCreateWorktree: () => void;

  confirmRemoveWt: GitWorktreeDto | null;
  onOpenRemoveWt: (wt: GitWorktreeDto) => void;
  onCloseRemoveWt: () => void;
  forceRemoveWt: boolean;
  onChangeForceRemoveWt: (force: boolean) => void;

  confirmDiscard: GitFileEntryDto | null;
  onCloseDiscard: () => void;

  confirmDiscardAll: boolean;
  onCloseDiscardAll: () => void;
}

/** Git 面板 Worktree 管理、新建工作树、移除工作树及放弃更改确认弹窗 */
export function GitModals({
  rootPath,
  activeRepoRoot,
  overview,
  prunableCount,
  busyAction,
  runAction,
  onNotice,
  wtManagerOpen,
  onCloseWtManager,
  onOpenAddWorktree,
  wtModalOpen,
  onCloseWtModal,
  wtCreateBranch,
  onChangeWtCreateBranch,
  wtBranch,
  onWorktreeBranchChange,
  wtBaseRef,
  onChangeWtBaseRef,
  wtTargetPath,
  onChangeWtTargetPath,
  wtOpenAfter,
  onChangeWtOpenAfter,
  onPickWorktreeDir,
  onCreateWorktree,
  confirmRemoveWt,
  onOpenRemoveWt,
  onCloseRemoveWt,
  forceRemoveWt,
  onChangeForceRemoveWt,
  confirmDiscard,
  onCloseDiscard,
  confirmDiscardAll,
  onCloseDiscardAll,
}: GitModalsProps) {
  return (
    <>
      {/* 工作树 (Worktrees) 管理弹窗 */}
      {wtManagerOpen && overview && activeRepoRoot && (
        <Modal
          title={`Git 工作树管理 (${overview.worktrees.length})`}
          onClose={onCloseWtManager}
          width={520}
          footer={
            <div className="flex w-full items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                {prunableCount > 0 && (
                  <Button
                    onClick={() =>
                      void runAction("清理失效工作树", async () => {
                        await gitApi.worktreePrune(activeRepoRoot);
                        onNotice("已清理失效工作树记录");
                      })
                    }
                  >
                    清理失效记录 ({prunableCount})
                  </Button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button onClick={onCloseWtManager}>关闭</Button>
                <PrimaryButton
                  onClick={() => {
                    onCloseWtManager();
                    onOpenAddWorktree();
                  }}
                >
                  新建工作树
                </PrimaryButton>
              </div>
            </div>
          }
        >
          <div className="max-h-80 overflow-y-auto space-y-2 text-xs">
            {overview.worktrees.map((wt) => (
              <div
                key={wt.path}
                className={`rounded border px-3 py-2 ${
                  wt.isCurrent
                    ? "border-sky-500/40 bg-sky-500/10"
                    : "border-zinc-800 bg-zinc-950/60"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5 font-mono text-zinc-100">
                    <IconGitBranch
                      size={13}
                      className={wt.isCurrent ? "shrink-0 text-sky-400" : "shrink-0 text-zinc-500"}
                    />
                    <span className="truncate font-medium">
                      {wt.branch || (wt.isBare ? "(bare)" : `detached @ ${wt.head}`)}
                    </span>
                  </span>
                  <div className="flex shrink-0 items-center gap-1">
                    {wt.isCurrent && (
                      <span className="rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] text-sky-400">
                        当前
                      </span>
                    )}
                    {wt.isMain && !wt.isCurrent && (
                      <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
                        主树
                      </span>
                    )}
                    {wt.isPrunable && (
                      <span className="rounded bg-red-950/60 px-1.5 py-0.5 text-[10px] text-red-400">
                        目录缺失
                      </span>
                    )}
                  </div>
                </div>

                <div className="mt-1 truncate font-mono text-[11px] text-zinc-500" title={wt.path}>
                  {wt.path}
                </div>

                {!wt.isCurrent && !wt.isBare && (
                  <div className="mt-2 flex items-center justify-end gap-1.5">
                    {!wt.isPrunable && (
                      <>
                        <button
                          onClick={() => {
                            onCloseWtManager();
                            void explorerStore.getState().openRoot(wt.uri);
                          }}
                          className="rounded border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-300 hover:border-sky-500/50 hover:text-sky-400"
                        >
                          当前窗口切换
                        </button>
                        <button
                          onClick={() => void appApi.openNewWindow(undefined, undefined, wt.uri)}
                          className="rounded border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-300 hover:border-sky-500/50 hover:text-sky-400"
                        >
                          新窗口打开
                        </button>
                      </>
                    )}
                    {!wt.isMain && (
                      <button
                        onClick={() => onOpenRemoveWt(wt)}
                        className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-red-400"
                        title="移除工作树"
                      >
                        <IconTrash size={13} />
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Modal>
      )}

      {/* 新建工作树弹窗 */}
      {wtModalOpen && overview && (
        <Modal
          title="新建 Git 工作树 (Worktree)"
          onClose={onCloseWtModal}
          width={460}
          footer={
            <>
              <Button onClick={onCloseWtModal}>取消</Button>
              <PrimaryButton
                disabled={!wtBranch.trim() || !wtTargetPath.trim() || !!busyAction}
                onClick={onCreateWorktree}
              >
                {busyAction === "创建工作树" ? "创建中…" : "创建工作树"}
              </PrimaryButton>
            </>
          }
        >
          <div className="space-y-3 text-xs">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => onChangeWtCreateBranch(true)}
                className={`flex-1 rounded border py-1.5 font-medium ${
                  wtCreateBranch
                    ? "border-sky-500 bg-sky-600/20 text-sky-400"
                    : "border-zinc-700 bg-zinc-900 text-zinc-400"
                }`}
              >
                新建分支并创建工作树
              </button>
              <button
                type="button"
                onClick={() => onChangeWtCreateBranch(false)}
                className={`flex-1 rounded border py-1.5 font-medium ${
                  !wtCreateBranch
                    ? "border-sky-500 bg-sky-600/20 text-sky-400"
                    : "border-zinc-700 bg-zinc-900 text-zinc-400"
                }`}
              >
                基于已有分支创建
              </button>
            </div>

            {wtCreateBranch ? (
              <>
                <div>
                  <label className="mb-1 block text-zinc-400">新分支名称</label>
                  <input
                    value={wtBranch}
                    onChange={(e) => onWorktreeBranchChange(e.target.value)}
                    placeholder="例如 feat/login-ui"
                    className="w-full rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 font-mono text-zinc-100 outline-none focus:border-sky-500"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-zinc-400">基准分支 / Commit（可选）</label>
                  <input
                    value={wtBaseRef}
                    onChange={(e) => onChangeWtBaseRef(e.target.value)}
                    placeholder="留空则基于当前 HEAD"
                    className="w-full rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 font-mono text-zinc-100 outline-none focus:border-sky-500"
                  />
                </div>
              </>
            ) : (
              <div>
                <label className="mb-1 block text-zinc-400">选择已有分支</label>
                <select
                  value={wtBranch}
                  onChange={(e) => onWorktreeBranchChange(e.target.value)}
                  className="w-full rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 font-mono text-zinc-100 outline-none focus:border-sky-500"
                >
                  <option value="">-- 请选择分支 --</option>
                  {overview.branches
                    .filter((b) => !overview.worktrees.some((w) => w.branch === b.name))
                    .map((b) => (
                      <option key={b.name} value={b.name}>
                        {b.name}
                      </option>
                    ))}
                </select>
              </div>
            )}

            <div>
              <label className="mb-1 block text-zinc-400">工作树保存目录</label>
              <div className="flex gap-1.5">
                <input
                  value={wtTargetPath}
                  onChange={(e) => onChangeWtTargetPath(e.target.value)}
                  placeholder="输入目标路径，例如 ../repo-wt/feat"
                  className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 font-mono text-zinc-100 outline-none focus:border-sky-500"
                />
                {!rootPath.startsWith("remote://") && !rootPath.startsWith("wsl://") && (
                  <Button
                    onClick={onPickWorktreeDir}
                    className="border border-zinc-700 bg-zinc-900 px-2.5 text-xs text-zinc-300 hover:bg-zinc-700"
                  >
                    浏览…
                  </Button>
                )}
              </div>
            </div>

            <div>
              <label className="mb-1 block text-zinc-400">创建后操作</label>
              <select
                value={wtOpenAfter}
                onChange={(e) => onChangeWtOpenAfter(e.target.value as "none" | "current" | "newWindow")}
                className="w-full rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-zinc-100 outline-none focus:border-sky-500"
              >
                <option value="current">在当前窗口切换到新工作树</option>
                <option value="newWindow">在新窗口中打开新工作树</option>
                <option value="none">仅创建，保持当前工作区不变</option>
              </select>
            </div>
          </div>
        </Modal>
      )}

      {/* 移除工作树确认弹窗 */}
      {confirmRemoveWt && activeRepoRoot && (
        <Modal
          title="移除 Git 工作树"
          onClose={onCloseRemoveWt}
          footer={
            <>
              <Button onClick={onCloseRemoveWt}>取消</Button>
              <DangerButton
                disabled={!!busyAction}
                onClick={() => {
                  const targetWt = confirmRemoveWt;
                  onCloseRemoveWt();
                  void runAction("移除工作树", async () => {
                    await gitApi.worktreeRemove(activeRepoRoot, targetWt.path, forceRemoveWt);
                    onNotice("已移除工作树");
                  });
                }}
              >
                确认移除
              </DangerButton>
            </>
          }
        >
          <div className="space-y-3 text-xs">
            <p className="text-zinc-300">
              确定要移除工作树目录{" "}
              <span className="font-mono text-zinc-100 break-all">{confirmRemoveWt.path}</span> 吗？
            </p>
            <label className="flex items-center gap-2 text-zinc-400 cursor-pointer">
              <input
                type="checkbox"
                checked={forceRemoveWt}
                onChange={(e) => onChangeForceRemoveWt(e.target.checked)}
                className="accent-sky-500"
              />
              <span>强制移除（包含未提交更改或目录缺失时勾选 --force）</span>
            </label>
          </div>
        </Modal>
      )}

      {/* 放弃单个文件更改确认弹窗 */}
      {confirmDiscard && activeRepoRoot && (
        <Modal
          title="放弃更改"
          onClose={onCloseDiscard}
          footer={
            <>
              <Button onClick={onCloseDiscard}>取消</Button>
              <DangerButton
                disabled={!!busyAction}
                onClick={() => {
                  const target = confirmDiscard;
                  onCloseDiscard();
                  void runAction("放弃更改", async () => {
                    await gitApi.discard(activeRepoRoot, target.path, target.status === "U");
                    if (rootPath) void explorerStore.getState().refresh(rootPath);
                  });
                }}
              >
                确认放弃
              </DangerButton>
            </>
          }
        >
          <p className="text-xs text-zinc-300">
            {confirmDiscard.status === "U" ? "确定永久删除未跟踪文件 " : "确定还原对文件 "}
            <span className="font-mono text-zinc-100 break-all">{confirmDiscard.path}</span>
            {confirmDiscard.status === "U" ? " 吗？此操作不可恢复。" : " 的未暂存修改吗？"}
          </p>
        </Modal>
      )}

      {/* 放弃所有未暂存更改确认弹窗 */}
      {confirmDiscardAll && activeRepoRoot && overview && (
        <Modal
          title="放弃所有更改"
          onClose={onCloseDiscardAll}
          footer={
            <>
              <Button onClick={onCloseDiscardAll}>取消</Button>
              <DangerButton
                disabled={!!busyAction}
                onClick={() => {
                  onCloseDiscardAll();
                  void runAction("放弃所有更改", async () => {
                    await gitApi.discardAll(activeRepoRoot);
                    if (rootPath) void explorerStore.getState().refresh(rootPath);
                    onNotice("已放弃所有未暂存更改");
                  });
                }}
              >
                全部放弃
              </DangerButton>
            </>
          }
        >
          <p className="text-xs text-zinc-300">
            确定要还原工作区所有已修改文件并删除未跟踪文件（共{" "}
            <span className="font-semibold text-amber-300">{overview.changes.length}</span>{" "}
            项）吗？此操作不可恢复。
          </p>
        </Modal>
      )}
    </>
  );
}
