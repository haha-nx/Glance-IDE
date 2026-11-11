/**
 * 空白窗口判定：`open_new_window` 会注入 `?blank=1`，表示这是一个
 * 「全新空白工作台」窗口，不应恢复任何历史工作区 / SSH 会话。
 */
export function isBlankWindow(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return new URLSearchParams(window.location.search).get("blank") === "1";
  } catch {
    return false;
  }
}

export type PendingProfilePrefill = { host: string; port: number };

/**
 * 待消费的「新建 SSH 连接」预填数据。
 *
 * 发现面板点击连接时，RemotePanel 尚未挂载（监听器未注册），
 * 直接派发 window 事件会丢失；这里用模块级单例暂存，面板挂载后主动取用。
 */
let pendingPrefill: PendingProfilePrefill | null = null;

export function setPendingPrefill(prefill: PendingProfilePrefill | null): void {
  pendingPrefill = prefill;
}

export function takePendingPrefill(): PendingProfilePrefill | null {
  const value = pendingPrefill;
  pendingPrefill = null;
  return value;
}

/** 待直连的已保存 SSH 配置（发现面板命中已保存 IP 时使用） */
let pendingConnectProfileId: string | null = null;

export function setPendingProfileConnect(id: string | null): void {
  pendingConnectProfileId = id;
}

export function takePendingProfileConnect(): string | null {
  const value = pendingConnectProfileId;
  pendingConnectProfileId = null;
  return value;
}
