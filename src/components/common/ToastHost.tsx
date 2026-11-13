import { toastStore, type ToastKind } from "../../stores/toast";
import { IconWarning } from "./icons";

const KIND_CLASS: Record<ToastKind, string> = {
  error:
    "border-[var(--glance-danger-border)] bg-[var(--glance-danger-bg)] text-[var(--glance-danger-text)]",
  warning:
    "border-[var(--glance-warning-border)] bg-[var(--glance-warning-bg)] text-[var(--glance-warning-text)]",
  success:
    "border-[var(--glance-success-border)] bg-[var(--glance-success-bg)] text-[var(--glance-success-text)]",
  info: "border-zinc-700 bg-zinc-900 text-zinc-200",
};

/** 全局轻量级 Toast 消息队列，替代原生阻塞式 alert()。 */
export function ToastHost() {
  const toasts = toastStore((s) => s.toasts);
  const dismiss = toastStore((s) => s.dismiss);

  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-9 right-4 z-[9999] flex max-w-sm flex-col gap-2"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role={toast.kind === "error" || toast.kind === "warning" ? "alert" : "status"}
          className={`pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2 text-xs shadow-2xl backdrop-blur-sm ${KIND_CLASS[toast.kind]}`}
        >
          {(toast.kind === "error" || toast.kind === "warning") && (
            <IconWarning size={15} className="mt-0.5 shrink-0" />
          )}
          <span className="min-w-0 flex-1 break-all select-text leading-relaxed">
            {toast.message}
          </span>
          <button
            type="button"
            onClick={() => dismiss(toast.id)}
            aria-label="关闭通知"
            className="shrink-0 rounded px-1 text-current opacity-70 transition-opacity hover:opacity-100"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
