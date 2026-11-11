import { useCallback, useEffect, useState } from "react";
import { wslApi } from "../../services/wsl";
import { explorerStore } from "../../stores/explorer";
import type { WslDistroDto } from "../../types/wsl";
import { Button, Modal, PrimaryButton } from "../common/Modal";
import { IconFolder, IconRefresh, IconWarning, IconWsl } from "../common/icons";

export function WslPanel() {
  const [distros, setDistros] = useState<WslDistroDto[]>([]);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [customPathDialog, setCustomPathDialog] = useState<string | null>(null);
  const [customPathInput, setCustomPathInput] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const isAvail = await wslApi.isAvailable();
      setAvailable(isAvail);
      if (isAvail) {
        const list = await wslApi.listDistros();
        setDistros(list);
      } else {
        setDistros([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function openWslWorkspace(distroName: string, path: string) {
    const normalized = path.startsWith("/") ? path : `/${path}`;
    const uri = `wsl://${distroName}${normalized}`;
    await explorerStore.getState().openRoot(uri);
    window.dispatchEvent(new CustomEvent("glance:activate-panel", { detail: "explorer" }));
  }

  async function openHome(distroName: string) {
    try {
      const home = await wslApi.getHome(distroName);
      await openWslWorkspace(distroName, home);
    } catch (err) {
      alert(`无法获取 WSL 主目录：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (
    <div className="flex h-full flex-col bg-zinc-900">
      <div className="flex h-9 shrink-0 items-center justify-between px-3 text-xs font-semibold uppercase tracking-wide text-zinc-400">
        <span className="flex items-center gap-1.5">
          <IconWsl size={14} className="text-sky-400" />
          <span>WSL 子系统</span>
        </span>
        <button
          title="刷新列表"
          onClick={() => void refresh()}
          disabled={loading}
          className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300 disabled:opacity-50"
        >
          <IconRefresh size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {error && (
          <div className="mx-1 mb-2 rounded border border-red-900/60 bg-red-950/40 px-2.5 py-2 text-xs text-red-300">
            <IconWarning size={12} className="mr-1 inline text-red-400" />
            {error}
          </div>
        )}

        {available === false && (
          <div className="flex flex-col items-center gap-2 px-4 pt-8 text-center">
            <IconWarning size={32} className="text-amber-500/80" />
            <p className="text-sm font-medium text-zinc-300">未检测到可用 WSL 环境</p>
            <p className="text-xs text-zinc-500 leading-relaxed">
              WSL 功能仅在 Windows 10/11 系统中支持。请确认已在 Windows 功能中启用“适用于 Linux 的 Windows 子系统”并安装至少一个 Linux 发行版。
            </p>
          </div>
        )}

        {available === true && distros.length === 0 && !loading && (
          <div className="flex flex-col items-center gap-2 px-4 pt-8 text-center">
            <IconWsl size={32} className="text-zinc-700" />
            <p className="text-sm text-zinc-500">系统中未安装 WSL 发行版</p>
            <p className="text-xs text-zinc-600">
              可通过 Windows 终端执行 <code className="bg-zinc-800 px-1 py-0.5 rounded text-zinc-400">wsl --install</code> 安装 Ubuntu
            </p>
          </div>
        )}

        {distros.map((distro) => {
          const isRunning = distro.state.toLowerCase() === "running";
          return (
            <div
              key={distro.name}
              className="mb-2 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2.5"
            >
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 truncate text-sm font-medium text-zinc-200">
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${
                      isRunning ? "bg-emerald-400" : "bg-zinc-600"
                    }`}
                    title={distro.state}
                  />
                  <span>{distro.name}</span>
                  {distro.isDefault && (
                    <span className="rounded bg-sky-950 px-1.5 py-0.2 text-[10px] text-sky-400 border border-sky-800/60">
                      默认
                    </span>
                  )}
                </span>
                <span className="text-[11px] text-zinc-500">WSL {distro.version}</span>
              </div>

              <p className="mt-1 select-text text-xs text-zinc-500">
                状态: <span className={isRunning ? "text-emerald-400" : "text-zinc-500"}>{distro.state}</span> · UNC: {distro.basePath}
              </p>

              <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-zinc-800/80 pt-2 text-xs">
                <PrimaryButton
                  onClick={() => void openHome(distro.name)}
                  className="flex items-center gap-1 px-2.5 py-1 text-xs"
                  title="打开当前发行版用户家目录 (~/)"
                >
                  <IconFolder size={13} />
                  打开用户目录
                </PrimaryButton>

                <Button
                  onClick={() => void openWslWorkspace(distro.name, "/")}
                  className="px-2 py-1 text-xs text-zinc-300"
                  title="打开 Linux 根目录 (/)"
                >
                  根目录 (/)
                </Button>

                <Button
                  onClick={() => {
                    setCustomPathDialog(distro.name);
                    setCustomPathInput("");
                  }}
                  className="px-2 py-1 text-xs text-zinc-400"
                  title="打开指定路径"
                >
                  指定路径…
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      {customPathDialog && (
        <Modal
          title={`打开 ${customPathDialog} 中的路径`}
          onClose={() => setCustomPathDialog(null)}
          footer={
            <>
              <Button onClick={() => setCustomPathDialog(null)}>取消</Button>
              <PrimaryButton
                onClick={() => {
                  if (customPathInput.trim()) {
                    void openWslWorkspace(customPathDialog, customPathInput.trim());
                    setCustomPathDialog(null);
                  }
                }}
                disabled={!customPathInput.trim()}
              >
                打开
              </PrimaryButton>
            </>
          }
        >
          <div className="space-y-2">
            <p className="text-xs text-zinc-400">请输入 WSL 内的 Linux 绝对路径：</p>
            <input
              autoFocus
              value={customPathInput}
              onChange={(e) => setCustomPathInput(e.target.value)}
              placeholder="例如 /var/www 或 /opt"
              className="w-full rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-200 outline-none focus:border-sky-600"
              onKeyDown={(e) => {
                if (e.key === "Enter" && customPathInput.trim()) {
                  void openWslWorkspace(customPathDialog, customPathInput.trim());
                  setCustomPathDialog(null);
                }
              }}
            />
          </div>
        </Modal>
      )}
    </div>
  );
}
