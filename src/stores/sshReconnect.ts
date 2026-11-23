import { create } from "zustand";
import { sshApi } from "../services/ssh";

export interface SshReconnectAttempt {
  attemptId: string;
  generation: number;
}

interface SshReconnectState {
  reconnecting: boolean;
  attemptId: string | null;
  generation: number;
  startupCancelled: boolean;
  cancelledPendingRemote: boolean;

  beginStartup(): SshReconnectAttempt | null;
  beginManual(): SshReconnectAttempt;
  isActive(generation: number): boolean;
  finish(generation: number): void;
  cancelForLocalOpen(): boolean;
  consumeCancelledPendingRemote(): boolean;
  clearCancelledPendingRemote(): void;
}

/**
 * 窗口级 SSH 重连控制状态：
 * 当窗口启动自动重连（或手动重试重连）进行中，用户选择打开本地文件/文件夹时，
 * 立即取消当前重连并抑制后续连接失败弹窗与过期结果回写。
 */
export const sshReconnectStore = create<SshReconnectState>()((set, get) => ({
  reconnecting: false,
  attemptId: null,
  generation: 0,
  startupCancelled: false,
  cancelledPendingRemote: false,

  beginStartup: () => {
    const cur = get();
    if (cur.startupCancelled) return null;
    const nextGen = cur.generation + 1;
    const attemptId = `ssh-reconnect-${Date.now()}-${nextGen}`;
    set({
      reconnecting: true,
      attemptId,
      generation: nextGen,
      cancelledPendingRemote: false,
    });
    return { attemptId, generation: nextGen };
  },

  beginManual: () => {
    const nextGen = get().generation + 1;
    const attemptId = `ssh-reconnect-${Date.now()}-${nextGen}`;
    set({
      reconnecting: true,
      attemptId,
      generation: nextGen,
      startupCancelled: false,
      cancelledPendingRemote: false,
    });
    return { attemptId, generation: nextGen };
  },

  isActive: (generation) => {
    const s = get();
    return s.reconnecting && s.generation === generation;
  },

  finish: (generation) => {
    if (get().generation === generation) {
      set({ reconnecting: false, attemptId: null });
    }
  },

  cancelForLocalOpen: () => {
    const cur = get();
    const wasReconnecting = cur.reconnecting;
    const attemptId = cur.attemptId;
    set({
      reconnecting: false,
      attemptId: null,
      generation: cur.generation + 1,
      startupCancelled: true,
      cancelledPendingRemote: cur.cancelledPendingRemote || wasReconnecting,
    });
    if (attemptId) {
      void sshApi.cancelConnect(attemptId);
    }
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("glance:ssh-reconnect-cancelled"));
    }
    return wasReconnecting;
  },

  consumeCancelledPendingRemote: () => {
    const cur = get().cancelledPendingRemote;
    if (cur) set({ cancelledPendingRemote: false });
    return cur;
  },

  clearCancelledPendingRemote: () => {
    if (get().cancelledPendingRemote) {
      set({ cancelledPendingRemote: false });
    }
  },
}));
