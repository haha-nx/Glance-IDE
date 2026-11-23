import { useEffect, useState } from "react";
import { appApi } from "../../services/files";
import { updaterApi } from "../../services/updater";
import { calcPercent, formatBytes, formatSpeed } from "../../lib/format";
import { IS_MAC } from "../../lib/platform";
import {
  APP_THEMES,
  DEFAULT_SETTINGS,
  settingsStore,
  type AppTheme,
  type SettingsSection,
} from "../../stores/settings";
import { tabsStore } from "../../stores/tabs";
import { requestApplyUpdate, updaterStore } from "../../stores/updater";
import { Button, PrimaryButton } from "../common/Modal";
import { IconFile, IconFolder } from "../common/icons";

function formatTime(ts: number | null): string {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
  } catch {
    return "";
  }
}

/** 开关控件 */
function ToggleSwitch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border transition-colors ${
        checked
          ? "border-sky-500 bg-sky-600"
          : "border-zinc-600 bg-zinc-700"
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
          checked ? "translate-x-4" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

/** 编辑器内置设置标签页：外观与字体、编辑器、SSH 与终端、版本与更新、关于 */
export function SettingsTabView() {
  const section = tabsStore((s) => s.settingsSection);
  const setSection = tabsStore((s) => s.setSettingsSection);
  const [appInfo, setAppInfo] = useState({ name: "Glance IDE", version: "0.1.8" });
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  const fontSize = settingsStore((s) => s.fontSize);
  const explorerFontScale = settingsStore((s) => s.explorerFontScale);
  const theme = settingsStore((s) => s.theme);
  const showEditorDiagnostics = settingsStore((s) => s.showEditorDiagnostics);
  const keepOnlyModifiedTabs = settingsStore((s) => s.keepOnlyModifiedTabs);
  const autoOpenTerminalOnSsh = settingsStore((s) => s.autoOpenTerminalOnSsh);
  const autoCheckUpdate = settingsStore((s) => s.autoCheckUpdate);
  const autoDownloadUpdate = settingsStore((s) => s.autoDownloadUpdate);
  const updateSettings = settingsStore((s) => s.updateSettings);
  const resetAppearance = settingsStore((s) => s.resetAppearance);

  const checking = updaterStore((s) => s.checking);
  const downloading = updaterStore((s) => s.downloading);
  const applying = updaterStore((s) => s.applying);
  const lastCheckedAt = updaterStore((s) => s.lastCheckedAt);
  const updateResult = updaterStore((s) => s.result);
  const downloadResult = updaterStore((s) => s.downloadResult);
  const downloadProgress = updaterStore((s) => s.downloadProgress);
  const updateError = updaterStore((s) => s.error);

  useEffect(() => {
    appApi
      .getInfo()
      .then((i) => setAppInfo({ name: i.name, version: i.version }))
      .catch(() => {});
  }, []);

  const handleOpenInstaller = async (revealOnly: boolean) => {
    if (!downloadResult?.savedPath) return;
    setActionMsg(null);
    try {
      await updaterApi.openDownloadedInstaller(downloadResult.savedPath, revealOnly);
    } catch (err) {
      setActionMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const navItems: { id: SettingsSection; label: string; badge?: boolean }[] = [
    { id: "appearance", label: "外观与字体" },
    { id: "editor", label: "编辑器" },
    { id: "ssh", label: "SSH 与终端" },
    { id: "updates", label: "版本与更新", badge: Boolean(updateResult?.hasUpdate) },
    { id: "about", label: "关于 Glance IDE" },
  ];

  return (
    <div className="flex h-full min-h-0 w-full bg-[var(--glance-bg)] text-sm select-none">
      {/* 左侧分类导航 */}
      <aside className="flex w-44 shrink-0 flex-col min-h-0 border-r border-zinc-800 bg-zinc-950/60 p-3">
        <nav className="min-h-0 flex-1 overflow-y-auto space-y-1 pr-0.5">
          {navItems.map((item) => {
            const active = section === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setSection(item.id)}
                className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-xs transition-colors ${
                  active
                    ? "bg-sky-600/20 text-sky-400 font-medium border border-sky-500/30"
                    : "text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-200 border border-transparent"
                }`}
              >
                <span className="truncate">{item.label}</span>
                {item.badge && (
                  <span className="h-2 w-2 shrink-0 rounded-full bg-sky-400" title="发现新版本" />
                )}
              </button>
            );
          })}
        </nav>

        <div className="mt-3 shrink-0 border-t border-zinc-800 pt-3">
          <Button
            type="button"
            onClick={resetAppearance}
            className="w-full border border-zinc-700 bg-zinc-900 text-xs text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100"
          >
            恢复默认外观
          </Button>
        </div>
      </aside>

      {/* 右侧设置内容区（全局 scrollbar-gutter: stable 预留滚动条槽位） */}
      <div className="min-w-0 flex-1 overflow-y-auto pl-6 pr-4 py-5">
        <div className="mx-auto max-w-2xl space-y-5">
          {section === "appearance" && (
            <>
              {/* 主题设置 */}
              <section className="space-y-2.5">
                <h3 className="text-xs font-semibold text-zinc-100">颜色主题</h3>

                <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-2.5">
                  {APP_THEMES.map((t) => {
                    const selected = theme === t.id;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => updateSettings({ theme: t.id as AppTheme })}
                        className={`flex flex-col rounded-lg border p-2.5 text-left transition-all ${
                          selected
                            ? "border-sky-500 bg-zinc-900 ring-1 ring-sky-500/40"
                            : "border-zinc-700 bg-zinc-900/70 hover:border-zinc-500"
                        }`}
                      >
                        {/* 迷你预览色卡 */}
                        <div
                          className="mb-2 flex h-12 w-full overflow-hidden rounded border border-black/20"
                          style={{ backgroundColor: t.swatchBg }}
                        >
                          <div
                            className="h-full w-6 shrink-0 border-r border-black/15"
                            style={{ backgroundColor: t.swatchPanel }}
                          />
                          <div className="flex flex-1 flex-col justify-center gap-1 px-2">
                            <div
                              className="h-1.5 w-14 rounded-full"
                              style={{ backgroundColor: t.swatchAccent }}
                            />
                            <div
                              className="h-1.5 w-20 rounded-full opacity-60"
                              style={{ backgroundColor: t.swatchText }}
                            />
                            <div
                              className="h-1.5 w-12 rounded-full opacity-35"
                              style={{ backgroundColor: t.swatchText }}
                            />
                          </div>
                        </div>

                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-xs font-medium text-zinc-100">{t.name}</span>
                          {selected && (
                            <span className="shrink-0 rounded bg-sky-500/20 px-1.5 py-0.5 text-[10px] font-medium text-sky-400">
                              使用中
                            </span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </section>

              {/* 编辑器与终端字号 */}
              <section className="space-y-3 border-t border-zinc-700/70 pt-4">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-xs font-semibold text-zinc-100">编辑器与终端字号</h3>
                  <button
                    type="button"
                    onClick={() => updateSettings({ fontSize: DEFAULT_SETTINGS.fontSize })}
                    className="shrink-0 rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
                  >
                    默认 13px
                  </button>
                </div>

                <div className="flex items-center gap-3 rounded-lg border border-zinc-700 bg-zinc-900/80 px-3 py-2.5">
                  <button
                    type="button"
                    onClick={() => updateSettings({ fontSize: fontSize - 1 })}
                    disabled={fontSize <= 10}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-zinc-700 bg-zinc-800 text-zinc-200 transition-colors hover:bg-zinc-700 disabled:opacity-40"
                    title="减小字号"
                  >
                    −
                  </button>
                  <input
                    type="range"
                    min={10}
                    max={24}
                    step={1}
                    value={fontSize}
                    onChange={(e) => updateSettings({ fontSize: Number(e.target.value) })}
                    className="min-w-0 flex-1 accent-sky-500 cursor-pointer"
                  />
                  <button
                    type="button"
                    onClick={() => updateSettings({ fontSize: fontSize + 1 })}
                    disabled={fontSize >= 24}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-zinc-700 bg-zinc-800 text-zinc-200 transition-colors hover:bg-zinc-700 disabled:opacity-40"
                    title="增大字号"
                  >
                    +
                  </button>
                  <span className="min-w-[58px] shrink-0 rounded-md border border-sky-500/40 bg-sky-500/15 px-2.5 py-1 text-center font-mono text-xs font-semibold text-sky-300 tabular-nums">
                    {fontSize} px
                  </span>
                </div>

                {/* 常用快捷档位 */}
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="mr-1 text-[11px] text-zinc-400">快捷字号：</span>
                  {[12, 13, 14, 15, 16, 18].map((sz) => (
                    <button
                      key={sz}
                      type="button"
                      onClick={() => updateSettings({ fontSize: sz })}
                      className={`rounded border px-2 py-0.5 font-mono text-[11px] transition-colors ${
                        fontSize === sz
                          ? "border-sky-500 bg-sky-600/20 text-sky-400"
                          : "border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
                      }`}
                    >
                      {sz}px
                    </button>
                  ))}
                </div>

                {/* 字号实时预览 */}
                <div
                  className="overflow-x-auto rounded-lg border border-zinc-700 bg-zinc-950 px-3.5 py-2.5 font-mono text-zinc-300 select-text"
                  style={{ fontSize: `${fontSize}px`, lineHeight: 1.55 }}
                >
                  <div>
                    <span className="text-sky-400">const</span> glance ={" "}
                    <span className="text-emerald-400">&quot;Glance IDE 本地/远程工作台&quot;</span>;
                  </div>
                </div>
              </section>

              {/* 资源管理器文字缩放 */}
              <section className="space-y-3 border-t border-zinc-700/70 pt-4">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-xs font-semibold text-zinc-100">资源管理器文字缩放</h3>
                  <button
                    type="button"
                    onClick={() =>
                      updateSettings({ explorerFontScale: DEFAULT_SETTINGS.explorerFontScale })
                    }
                    className="shrink-0 rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
                  >
                    默认 100%
                  </button>
                </div>

                <div className="flex items-center gap-3 rounded-lg border border-zinc-700 bg-zinc-900/80 px-3 py-2.5">
                  <button
                    type="button"
                    onClick={() => updateSettings({ explorerFontScale: explorerFontScale - 10 })}
                    disabled={explorerFontScale <= 80}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-zinc-700 bg-zinc-800 text-zinc-200 transition-colors hover:bg-zinc-700 disabled:opacity-40"
                    title="缩小资源管理器文字"
                  >
                    −
                  </button>
                  <input
                    type="range"
                    min={80}
                    max={200}
                    step={5}
                    value={explorerFontScale}
                    onChange={(e) => updateSettings({ explorerFontScale: Number(e.target.value) })}
                    className="min-w-0 flex-1 accent-sky-500 cursor-pointer"
                  />
                  <button
                    type="button"
                    onClick={() => updateSettings({ explorerFontScale: explorerFontScale + 10 })}
                    disabled={explorerFontScale >= 200}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-zinc-700 bg-zinc-800 text-zinc-200 transition-colors hover:bg-zinc-700 disabled:opacity-40"
                    title="放大资源管理器文字"
                  >
                    +
                  </button>
                  <span className="min-w-[58px] shrink-0 rounded-md border border-sky-500/40 bg-sky-500/15 px-2.5 py-1 text-center font-mono text-xs font-semibold text-sky-300 tabular-nums">
                    {explorerFontScale}%
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="mr-1 text-[11px] text-zinc-400">快捷缩放：</span>
                  {[85, 100, 115, 130, 150, 175].map((pct) => (
                    <button
                      key={pct}
                      type="button"
                      onClick={() => updateSettings({ explorerFontScale: pct })}
                      className={`rounded border px-2 py-0.5 font-mono text-[11px] transition-colors ${
                        explorerFontScale === pct
                          ? "border-sky-500 bg-sky-600/20 text-sky-400"
                          : "border-zinc-700 bg-zinc-900 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
                      }`}
                    >
                      {pct}%
                    </button>
                  ))}
                </div>

                <div className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-zinc-200 select-none">
                  <div
                    className="flex items-center"
                    style={{
                      gap: `${Math.max(4, Math.round(6 * (explorerFontScale / 100)))}px`,
                      fontSize: `${Number((14 * (explorerFontScale / 100)).toFixed(1))}px`,
                      lineHeight: 1.45,
                    }}
                  >
                    <span className="shrink-0 text-sky-400/90">
                      <IconFolder size={Math.round(14 * (explorerFontScale / 100))} />
                    </span>
                    <span className="truncate">src</span>
                  </div>
                  <div
                    className="flex items-center"
                    style={{
                      paddingLeft: `${Math.round(14 * (explorerFontScale / 100))}px`,
                      gap: `${Math.max(4, Math.round(6 * (explorerFontScale / 100)))}px`,
                      fontSize: `${Number((14 * (explorerFontScale / 100)).toFixed(1))}px`,
                      lineHeight: 1.45,
                    }}
                  >
                    <span className="shrink-0 text-zinc-400">
                      <IconFile size={Math.round(14 * (explorerFontScale / 100))} />
                    </span>
                    <span className="truncate">App.tsx</span>
                  </div>
                </div>
              </section>
            </>
          )}

          {section === "editor" && (
            <>
              <section className="space-y-1">
                <h3 className="text-xs font-semibold text-zinc-100">编辑器</h3>
              </section>

              <section className="rounded-lg border border-zinc-700 bg-zinc-900/70 divide-y divide-zinc-800">
                <div className="flex items-center justify-between gap-4 px-3.5 py-3">
                  <span className="min-w-0 text-xs font-medium text-zinc-100">
                    显示代码语法报错
                  </span>
                  <ToggleSwitch
                    checked={showEditorDiagnostics}
                    onChange={(v) => updateSettings({ showEditorDiagnostics: v })}
                    label="显示代码语法报错"
                  />
                </div>

                <div className="flex items-center justify-between gap-4 px-3.5 py-3">
                  <span className="min-w-0 text-xs font-medium text-zinc-100">
                    打开新文件时替换未修改标签
                  </span>
                  <ToggleSwitch
                    checked={keepOnlyModifiedTabs}
                    onChange={(v) => updateSettings({ keepOnlyModifiedTabs: v })}
                    label="打开新文件时替换未修改标签"
                  />
                </div>
              </section>
            </>
          )}

          {section === "ssh" && (
            <>
              <section className="space-y-1">
                <h3 className="text-xs font-semibold text-zinc-100">SSH 与终端</h3>
              </section>

              <section className="rounded-lg border border-zinc-700 bg-zinc-900/70 divide-y divide-zinc-800">
                <div className="flex items-center justify-between gap-4 px-3.5 py-3">
                  <span className="min-w-0 text-xs font-medium text-zinc-100">
                    SSH 连接成功自动打开终端
                  </span>
                  <ToggleSwitch
                    checked={autoOpenTerminalOnSsh}
                    onChange={(v) => updateSettings({ autoOpenTerminalOnSsh: v })}
                    label="SSH 连接成功自动打开终端"
                  />
                </div>
              </section>
            </>
          )}

          {section === "updates" && (
            <>
              {/* 当前版本与手动检查更新 */}
              <section className="rounded-lg border border-zinc-700 bg-zinc-900/90 p-3.5 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold text-zinc-100">{appInfo.name}</h3>
                      <span className="rounded bg-zinc-800 border border-zinc-700 px-1.5 py-0.5 font-mono text-[11px] text-sky-400">
                        v{appInfo.version}
                      </span>
                    </div>
                    <p className="mt-1 truncate text-[11px] text-zinc-400">
                      更新源：GitHub Releases (haha-nx/Glance-IDE)
                      {lastCheckedAt ? ` · 上次检查：${formatTime(lastCheckedAt)}` : ""}
                    </p>
                  </div>

                  <PrimaryButton
                    onClick={() => void updaterStore.getState().checkForUpdates({ manual: true })}
                    disabled={checking}
                    className="shrink-0 text-xs"
                  >
                    {checking ? "正在检查更新…" : "检查更新"}
                  </PrimaryButton>
                </div>
              </section>

              {/* 自动更新开关（默认全部关闭） */}
              <section className="rounded-lg border border-zinc-700 bg-zinc-900/70 divide-y divide-zinc-800">
                <div className="flex items-center justify-between gap-4 px-3.5 py-3">
                  <span className="min-w-0 text-xs font-medium text-zinc-100">
                    启动时自动检测更新
                  </span>
                  <ToggleSwitch
                    checked={autoCheckUpdate}
                    onChange={(v) => updateSettings({ autoCheckUpdate: v })}
                    label="启动时自动检测更新"
                  />
                </div>

                <div className="flex items-center justify-between gap-4 px-3.5 py-3">
                  <span className="min-w-0 text-xs font-medium text-zinc-100">
                    发现新版本自动下载更新包
                  </span>
                  <ToggleSwitch
                    checked={autoDownloadUpdate}
                    onChange={(v) => updateSettings({ autoDownloadUpdate: v })}
                    label="发现新版本自动下载更新包"
                  />
                </div>
              </section>

              {/* 更新检查结果区 */}
              {(updateError || actionMsg) && (
                <div className="rounded-lg border border-red-800/60 bg-red-950/30 px-3.5 py-2.5 text-xs text-red-300 select-text">
                  {updateError || actionMsg}
                </div>
              )}

              {updateResult && !updateResult.hasUpdate && (
                <div className="rounded-lg border border-emerald-700/50 bg-emerald-950/20 px-3.5 py-3 text-xs text-emerald-300">
                  当前已是最新版本（v{updateResult.currentVersion}，GitHub 最新发布：v
                  {updateResult.latestVersion}）。
                </div>
              )}

              {updateResult && updateResult.hasUpdate && (
                <div className="rounded-lg border border-sky-500/50 bg-zinc-900 p-3.5 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="shrink-0 rounded bg-sky-600 px-1.5 py-0.5 text-[10px] font-medium text-white">
                          发现新版本
                        </span>
                        <span className="font-mono text-xs font-semibold text-zinc-100">
                          v{updateResult.currentVersion} → v{updateResult.latestVersion}
                        </span>
                      </div>
                      <p className="mt-1 truncate text-xs font-medium text-zinc-200">
                        {updateResult.releaseName}
                      </p>
                    </div>
                  </div>

                  {updateResult.releaseNotes && (
                    <div className="max-h-36 overflow-y-auto rounded border border-zinc-800 bg-zinc-950 p-2.5 text-[11px] text-zinc-300 whitespace-pre-wrap select-text">
                      {updateResult.releaseNotes}
                    </div>
                  )}

                  {updateResult.assetName && (
                    <div className="flex items-center justify-between text-[11px] text-zinc-400">
                      <span className="font-mono truncate">
                        匹配安装包：{updateResult.assetName}
                      </span>
                      {updateResult.assetSize && (
                        <span className="shrink-0 ml-2">
                          {formatBytes(updateResult.assetSize)}
                        </span>
                      )}
                    </div>
                  )}

                  {downloading && downloadProgress && (
                    <div className="space-y-1.5 rounded border border-sky-700/40 bg-zinc-950/80 px-2.5 py-2 text-[11px]">
                      <div className="flex items-center justify-between text-zinc-300">
                        <span>正在下载更新包…</span>
                        <span className="font-mono text-sky-400">
                          {calcPercent(
                            downloadProgress.downloadedBytes,
                            downloadProgress.totalBytes,
                          )}
                          %
                          {downloadProgress.speedBytesPerSec > 0
                            ? ` · ${formatSpeed(downloadProgress.speedBytesPerSec)}`
                            : ""}
                        </span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                        <div
                          className="h-full bg-sky-500 transition-all duration-150"
                          style={{
                            width: `${calcPercent(
                              downloadProgress.downloadedBytes,
                              downloadProgress.totalBytes,
                            )}%`,
                          }}
                        />
                      </div>
                      <div className="flex items-center justify-between text-[10px] font-mono text-zinc-500">
                        <span>{formatBytes(downloadProgress.downloadedBytes)}</span>
                        <span>
                          {downloadProgress.totalBytes > 0
                            ? formatBytes(downloadProgress.totalBytes)
                            : "大小未知"}
                        </span>
                      </div>
                    </div>
                  )}

                  {downloadResult && (
                    <div className="rounded border border-emerald-700/50 bg-emerald-950/25 px-2.5 py-2 text-[11px] text-emerald-300 select-text">
                      {downloadResult.installMode === "in_place_app" ||
                      downloadResult.installMode === "silent_installer"
                        ? "更新包已就绪，点击「立即重启更新」完成升级"
                        : `安装包已就绪：${downloadResult.savedPath}`}
                    </div>
                  )}

                  <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                    {updateResult.releaseUrl && (
                      <Button
                        onClick={() => void updaterApi.openExternalUrl(updateResult.releaseUrl)}
                        className="border border-zinc-700 bg-zinc-800 text-xs text-zinc-300 hover:bg-zinc-700"
                      >
                        查看 GitHub Release
                      </Button>
                    )}

                    {downloading ? (
                      <Button
                        onClick={() => void updaterStore.getState().cancelDownload()}
                        className="border border-zinc-700 bg-zinc-800 text-xs text-red-300 hover:bg-zinc-700"
                      >
                        取消下载
                      </Button>
                    ) : downloadResult ? (
                      <>
                        <Button
                          onClick={() => void handleOpenInstaller(true)}
                          className="border border-zinc-700 bg-zinc-800 text-xs text-zinc-200 hover:bg-zinc-700"
                        >
                          查看更新包
                        </Button>
                        {downloadResult.installMode === "manual" ? (
                          <PrimaryButton
                            onClick={() => void handleOpenInstaller(false)}
                            className="text-xs"
                          >
                            启动安装程序
                          </PrimaryButton>
                        ) : (
                          <PrimaryButton
                            disabled={applying}
                            onClick={() => requestApplyUpdate(downloadResult.savedPath)}
                            className="text-xs"
                          >
                            {applying ? "正在准备重启…" : "立即重启更新"}
                          </PrimaryButton>
                        )}
                      </>
                    ) : (
                      updateResult.assetUrl && (
                        <PrimaryButton
                          onClick={() => void updaterStore.getState().downloadLatestInstaller()}
                          disabled={downloading}
                          className="text-xs"
                        >
                          {`下载更新${
                            updateResult.assetSize
                              ? ` (${formatBytes(updateResult.assetSize)})`
                              : ""
                          }`}
                        </PrimaryButton>
                      )
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          {section === "about" && (
            <div className="space-y-3 text-xs">
              <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-4 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-zinc-100">{appInfo.name}</span>
                  <span className="font-mono text-xs text-sky-400">v{appInfo.version}</span>
                </div>
                <p className="text-zinc-400">
                  {IS_MAC
                    ? "本地 / 远程 SSH 一体化桌面开发工作台"
                    : "本地 / 远程 SSH / WSL 一体化桌面开发工作台"}
                </p>
              </div>

              <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-4 space-y-2 text-zinc-300">
                <div className="font-medium text-zinc-100">当前配置摘要</div>
                <ul className="list-disc pl-5 space-y-1 text-zinc-400">
                  <li>界面主题：{APP_THEMES.find((t) => t.id === theme)?.name ?? theme}</li>
                  <li>编辑器与终端字号：{fontSize} px</li>
                  <li>资源管理器文字缩放：{explorerFontScale}%</li>
                  <li>显示代码语法报错：{showEditorDiagnostics ? "已开启" : "已关闭"}</li>
                  <li>打开新文件时替换未修改标签：{keepOnlyModifiedTabs ? "已开启" : "已关闭"}</li>
                  <li>SSH 连接成功自动打开终端：{autoOpenTerminalOnSsh ? "已开启" : "已关闭"}</li>
                  <li>启动时自动检测更新：{autoCheckUpdate ? "已开启" : "已关闭"}</li>
                  <li>发现新版本自动下载更新包：{autoDownloadUpdate ? "已开启" : "已关闭"}</li>
                  <li>凭据存储：系统安全钥匙串（Windows Credential Manager / macOS Keychain）</li>
                </ul>
                <div className="pt-2">
                  <Button
                    onClick={() => setSection("updates")}
                    className="border border-zinc-700 bg-zinc-800 text-xs text-zinc-200 hover:bg-zinc-700"
                  >
                    前往检查更新
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
