import { useEffect, useRef, type ReactNode } from "react";

interface ModalProps {
  title: string;
  children: ReactNode;
  onClose?: () => void;
  footer?: ReactNode;
  width?: number;
}

export function Modal({ title, children, onClose, footer, width = 420 }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div
        ref={ref}
        tabIndex={-1}
        className="rounded-lg border border-zinc-700 bg-zinc-800 shadow-2xl outline-none"
        style={{ width, maxWidth: "calc(100vw - 32px)" }}
      >
        <div className="border-b border-zinc-700 px-4 py-3 text-sm font-medium text-zinc-100">
          {title}
        </div>
        <div className="px-4 py-3 text-sm text-zinc-300">{children}</div>
        {footer && (
          <div className="flex justify-end gap-2 border-t border-zinc-700 px-4 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

export function Button(props: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { className = "", ...rest } = props;
  return (
    <button
      {...rest}
      className={`rounded px-3 py-1.5 text-sm transition-colors disabled:opacity-50 ${
        className || "bg-zinc-700 text-zinc-200 hover:bg-zinc-600"
      }`}
    />
  );
}

export function PrimaryButton(
  props: React.ButtonHTMLAttributes<HTMLButtonElement>,
) {
  const { className = "", ...rest } = props;
  return (
    <button
      {...rest}
      className={`rounded bg-sky-600 px-3 py-1.5 text-sm text-white transition-colors hover:bg-sky-500 disabled:opacity-50 ${className}`}
    />
  );
}

export function DangerButton(
  props: React.ButtonHTMLAttributes<HTMLButtonElement>,
) {
  const { className = "", ...rest } = props;
  return (
    <button
      {...rest}
      className={`rounded bg-red-600/90 px-3 py-1.5 text-sm text-white transition-colors hover:bg-red-500 disabled:opacity-50 ${className}`}
    />
  );
}
