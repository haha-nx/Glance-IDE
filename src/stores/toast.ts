import { create } from "zustand";

export type ToastKind = "info" | "success" | "warning" | "error";

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastState {
  toasts: ToastItem[];
  push: (kind: ToastKind, message: string, durationMs?: number) => number;
  dismiss: (id: number) => void;
}

let nextToastId = 1;
const dismissTimers = new Map<number, ReturnType<typeof setTimeout>>();

export const toastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (kind, message, durationMs = 4500) => {
    const id = nextToastId++;
    set((s) => ({
      toasts: [...s.toasts.slice(-4), { id, kind, message }],
    }));
    if (durationMs > 0) {
      const timer = setTimeout(() => {
        dismissTimers.delete(id);
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
      }, durationMs);
      dismissTimers.set(id, timer);
    }
    return id;
  },
  dismiss: (id) => {
    const timer = dismissTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      dismissTimers.delete(id);
    }
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));

export function showToast(message: string, kind: ToastKind = "info", durationMs = 4200): number {
  return toastStore.getState().push(kind, message, durationMs);
}

export function showErrorToast(message: string, durationMs = 5500): number {
  return toastStore.getState().push("error", message, durationMs);
}
