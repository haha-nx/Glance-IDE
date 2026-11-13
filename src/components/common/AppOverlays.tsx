import { calcPercent, formatBytes, formatSpeed } from "../../lib/format";
import { explorerStore } from "../../stores/explorer";
import { tabsStore } from "../../stores/tabs";
import { requestApplyUpdate, updaterStore } from "../../stores/updater";
import type { ConnectionProfileDto } from "../../types/ssh";
import type { SettingsSection } from "./SettingsModal";
import { Button, DangerButton, Modal, PrimaryButton } from "./Modal";
import { IconWarning } from "./icons";

export interface SshReconnectFailState {
  profile: ConnectionProfileDto;
  reason: string;
}

export interface SshLostState {
  sessionId: string;
  profileId: string;
  deviceIdentityId: string;
  deviceName: string | null;
  endpoint: string;
}

export interface AppOverlaysProps {
  pendingUpdatePath: string | null;
  onClearPendingUpdate: () => void;
  pendingWindowClose: boolean;
  onCancelWindowClose: () => void;
  onCloseAnyway: () => void;
  onSaveAllAndClose: () => void;
  sshReconnectFail: SshReconnectFailState | null;
  onClearSshReconnectFail: () => void;
  onRetrySsh: (profile: ConnectionProfileDto) => void;
  sshLost: SshLostState | null;
  onClearSshLost: () => void;
  onReconnectLostSession: (lost: SshLostState) => void;
  onOpenSettings: (section: SettingsSection) => void;
  onSwitchPanel: (panel: string) => void;
}

/** 窗口级悬浮更新提示 + 退出/更新/SSH 重连确认模态框 */
export function AppOverlays({
  pendingUpdatePath,
  onClearPendingUpdate,
  pendingWindowClose,
  onCancelWindowClose,
  onCloseAnyway,
  onSaveAllAndClose,
  sshReconnectFail,
  onClearSshReconnectFail,
  onRetrySsh,
  sshLost,
  onClearSshLost,
  onReconnectLostSession,
  onOpenSettings,
  onSwitchPanel,
}: AppOverlaysProps) {
  const updatePromptVisible = updaterStore((s) => s.promptVisible);
  const updateResult = updaterStore((s) => s.result);
  const updateDownloading = updaterStore((s) => s.downloading);
  const updateDownloadProgress = updaterStore((s) => s.downloadProgress);
  const updateDownloadResult = updaterStore((s) => s.downloadResult);
  const updateApplying = updaterStore((s) => s.applying);

  return (
    <>
      {/* 仅在「自动检测更新」开启且检测到新版本时展示的右下角更新提示 */}
      {updatePromptVisible && updateResult?.hasUpdate && (
        <div className="fixed bottom-9 right-4 z-40 w-80 rounded-lg border border-sky-500/50 bg-zinc-900 p-3.5 text-xs text-zinc-200 shadow-2xl">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="flex items-center gap-1.5 font-semibold text-zinc-100">
                <span className="h-2 w-2 rounded-full bg-sky-400" />
                <span>发现新版本 v{updateResult.latestVersion}</span>
              </div>
              <p className="mt-1 text-[11px] text-zinc-400">
                当前版本 v{updateResult.currentVersion}，GitHub 端已发布新版更新。
              </p>
            </div>
            <button
              onClick={() => updaterStore.getState().dismissPrompt()}
              className="flex h-6 w-6 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
              title="关闭"
              aria-label="关闭更新提示"
            >
              ✕
            </button>
          </div>
          {updateDownloading && updateDownloadProgress && (
            <div className="mt-2.5 space-y-1">
              <div className="flex items-center justify-between text-[11px] text-zinc-400">
                <span>正在下载更新…</span>
                <span className="font-mono text-sky-400">
                  {calcPercent(
                    updateDownloadProgress.downloadedBytes,
                    updateDownloadProgress.totalBytes,
                  )}
                  %
                  {updateDownloadProgress.speedBytesPerSec > 0
                    ? ` · ${formatSpeed(updateDownloadProgress.speedBytesPerSec)}`
                    : ""}
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                <div
                  className="h-full bg-sky-500 transition-all duration-150"
                  style={{
                    width: `${calcPercent(
                      updateDownloadProgress.downloadedBytes,
                      updateDownloadProgress.totalBytes,
                    )}%`,
                  }}
                />
              </div>
            </div>
          )}
          {updateDownloadResult && (
            <p className="mt-2 rounded border border-emerald-700/50 bg-emerald-950/30 px-2 py-1 text-[11px] text-emerald-300">
              {updateDownloadResult.installMode === "manual"
                ? `已下载：${updateDownloadResult.savedPath}`
                : `更新包已就绪 (${formatBytes(updateDownloadResult.size)})，可一键重启完成升级`}
            </p>
          )}
          <div className="mt-3 flex items-center justify-end gap-2">
            <Button
              onClick={() => {
                updaterStore.getState().dismissPrompt();
                onOpenSettings("updates");
              }}
              className="border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-[11px] text-zinc-300 hover:bg-zinc-700"
            >
              查看详情
            </Button>
            {updateDownloading ? (
              <Button
                onClick={() => void updaterStore.getState().cancelDownload()}
                className="border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-[11px] text-red-300 hover:bg-zinc-700"
              >
                取消下载
              </Button>
            ) : updateDownloadResult ? (
              <PrimaryButton
                disabled={updateApplying}
                onClick={() => requestApplyUpdate(updateDownloadResult.savedPath)}
                className="px-2.5 py-1 text-[11px]"
              >
                {updateApplying
                  ? "正在准备重启…"
                  : updateDownloadResult.installMode === "manual"
                    ? "启动安装"
                    : "立即重启更新"}
              </PrimaryButton>
            ) : (
              updateResult.assetUrl && (
                <PrimaryButton
                  disabled={updateDownloading}
                  onClick={() => void updaterStore.getState().downloadLatestInstaller()}
                  className="px-2.5 py-1 text-[11px]"
                >
                  下载更新
                </PrimaryButton>
              )
            )}
          </div>
        </div>
      )}

      {/* 应用更新重启前未保存文件确认 */}
      {pendingUpdatePath && (
        <Modal
          title="安装更新并重启"
          onClose={onClearPendingUpdate}
          footer={
            <>
              <Button onClick={onClearPendingUpdate}>取消</Button>
              <DangerButton
                onClick={() => {
                  const p = pendingUpdatePath;
                  onClearPendingUpdate();
                  void updaterStore.getState().applyUpdate(p);
                }}
              >
                丢弃并更新
              </DangerButton>
              <PrimaryButton
                onClick={async () => {
                  const p = pendingUpdatePath;
                  const ok = await tabsStore.getState().saveAll();
                  if (ok) {
                    onClearPendingUpdate();
                    void updaterStore.getState().applyUpdate(p);
                  }
                }}
              >
                全部保存并更新
              </PrimaryButton>
            </>
          }
        >
          <p className="text-sm text-zinc-300">
            有未保存的文件，重启以完成版本更新将丢失这些修改。是否先保存全部更改？
          </p>
        </Modal>
      )}

      {/* 退出应用未保存确认 */}
      {pendingWindowClose && (
        <Modal
          title="退出应用"
          onClose={onCancelWindowClose}
          footer={
            <>
              <Button onClick={onCancelWindowClose}>取消</Button>
              <DangerButton onClick={onCloseAnyway}>丢弃并退出</DangerButton>
              <PrimaryButton onClick={onSaveAllAndClose}>全部保存并退出</PrimaryButton>
            </>
          }
        >
          <p className="text-sm text-zinc-300">有未保存的文件，退出将丢失这些修改。是否保存全部更改？</p>
        </Modal>
      )}

      {/* 远程 SSH 设备自动重连失败弹窗 */}
      {sshReconnectFail && (
        <Modal
          title="无法连接到远程设备"
          onClose={onClearSshReconnectFail}
          footer={
            <div className="flex w-full items-center justify-between">
              <Button
                onClick={() => {
                  onClearSshReconnectFail();
                  onSwitchPanel("remote");
                }}
              >
                打开远程配置
              </Button>
              <div className="flex gap-2">
                <Button
                  onClick={() => {
                    onClearSshReconnectFail();
                    void explorerStore.getState().closeRoot();
                    onSwitchPanel("explorer");
                  }}
                >
                  切换到本地
                </Button>
                <PrimaryButton
                  onClick={() => {
                    const prof = sshReconnectFail.profile;
                    onRetrySsh(prof);
                  }}
                >
                  重试连接
                </PrimaryButton>
              </div>
            </div>
          }
        >
          <div className="space-y-3 text-sm">
            <div className="flex items-center gap-2 text-amber-400">
              <IconWarning size={18} />
              <span className="font-medium text-zinc-100">
                自动重新连接远程 SSH 设备失败
              </span>
            </div>
            <p className="text-xs text-zinc-300">
              检测到您上次退出前处于远程工作区（
              <span className="font-mono text-sky-400">
                {sshReconnectFail.profile.name || sshReconnectFail.profile.host}:
                {sshReconnectFail.profile.port}
              </span>
              ），本次启动尝试连接失败：
            </p>
            <div className="rounded border border-red-900/60 bg-red-950/40 p-2.5 font-mono text-xs text-red-300 break-all select-text">
              {sshReconnectFail.reason}
            </div>
            <p className="text-[11px] text-zinc-500">
              您可以检查远端服务器网络与 SSH 服务状态后点击“重试连接”，或切换至本地工作区继续开发。
            </p>
          </div>
        </Modal>
      )}

      {/* 运行中的 SSH 会话意外掉线（设备关机 / 断网） */}
      {sshLost && (
        <Modal
          title="远程设备连接已断开"
          onClose={onClearSshLost}
          footer={
            <div className="flex w-full items-center justify-between">
              <Button
                onClick={() => {
                  const lost = sshLost;
                  onClearSshLost();
                  void explorerStore.getState().closeRoot();
                  onSwitchPanel("explorer");
                  window.dispatchEvent(
                    new CustomEvent("glance:session-disconnected", {
                      detail: { deviceIdentityId: lost.deviceIdentityId },
                    }),
                  );
                }}
              >
                断开连接
              </Button>
              <PrimaryButton
                onClick={() => {
                  const lost = sshLost;
                  onClearSshLost();
                  onReconnectLostSession(lost);
                }}
              >
                重新连接
              </PrimaryButton>
            </div>
          }
        >
          <div className="space-y-3 text-sm">
            <div className="flex items-center gap-2 text-amber-400">
              <IconWarning size={18} />
              <span className="font-medium text-zinc-100">
                与远程设备的连接已中断
              </span>
            </div>
            <p className="text-xs text-zinc-300">
              连接
              <span className="mx-1 font-mono text-sky-400">
                {sshLost.deviceName || sshLost.endpoint}
                {sshLost.deviceName ? ` (${sshLost.endpoint})` : ""}
              </span>
              已断开，可能是设备关机、休眠或网络中断。远程文件操作与终端将不可用。
            </p>
            <p className="text-[11px] text-zinc-500">
              选择「重新连接」重建会话并恢复远程工作区，或「断开连接」切回本地工作区。
            </p>
          </div>
        </Modal>
      )}
    </>
  );
}
