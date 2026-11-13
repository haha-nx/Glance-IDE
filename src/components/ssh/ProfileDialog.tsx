import { useRef, useState } from "react";
import { Button, Modal, PrimaryButton } from "../common/Modal";
import type { AuthMethod, ConnectionProfileDto, ProfileInput } from "../../types/ssh";

interface ProfileDialogProps {
  /** 传入则为编辑模式 */
  existing: ConnectionProfileDto | null;
  /** 新建时预填（来自发现面板候选） */
  prefill?: { host: string; port: number } | null;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: ProfileInput) => void;
}

const AUTH_OPTIONS: { value: AuthMethod; label: string }[] = [
  { value: "password", label: "密码" },
  { value: "public_key", label: "私钥文件" },
];

/**
 * 非受控表单：提交时读取 DOM 值。
 * 便于系统级自动化（AX setValue）与后续 e2e 测试；密码字段同理，仅提交瞬间在内存中。
 */
export function ProfileDialog({ existing, prefill, busy, onCancel, onSubmit }: ProfileDialogProps) {
  const nameRef = useRef<HTMLInputElement>(null);
  const hostRef = useRef<HTMLInputElement>(null);
  const portRef = useRef<HTMLInputElement>(null);
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const keyPathRef = useRef<HTMLInputElement>(null);
  const keyPassRef = useRef<HTMLInputElement>(null);
  const authRef = useRef<AuthMethod>(existing?.authMethod ?? "password");
  const [authMethod, setAuthMethod] = useState<AuthMethod>(existing?.authMethod ?? "password");
  const [validationError, setValidationError] = useState<string | null>(null);

  const initialHost = existing?.host ?? prefill?.host ?? "";
  const initialPort = existing?.port ?? prefill?.port ?? 22;

  function submit() {
    setValidationError(null);
    const rawName = nameRef.current?.value.trim() ?? "";
    const host = hostRef.current?.value.trim() ?? "";
    const name = rawName || host; // 选填项，不填则直接显示 IP
    const username = usernameRef.current?.value.trim() ?? "";
    const port = Math.max(1, Math.min(65535, Number(portRef.current?.value) || 22));
    const password = passwordRef.current?.value ?? "";
    const keyPath = keyPathRef.current?.value.trim() ?? "";
    const keyPass = keyPassRef.current?.value ?? "";

    if (!host || !username) {
      setValidationError("主机与用户名不能为空");
      return;
    }
    if (authMethod === "password" && !existing && !password) {
      setValidationError("密码认证需要提供密码");
      return;
    }
    if (authMethod === "public_key" && !keyPath && !existing?.keyPath) {
      setValidationError("公钥认证需要提供私钥文件路径");
      return;
    }
    onSubmit({
      name,
      host,
      port,
      username,
      authMethod,
      password: password || undefined,
      keyPath: keyPath || undefined,
      keyPassphrase: keyPass || undefined,
      identityMode: "device_pool", // 首版统一设备池模式：single 也由 0..n 身份表达
    });
  }

  const inputClass =
    "w-full rounded border border-zinc-600 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-200 outline-none focus:border-sky-600";
  const labelClass = "mb-1 block text-xs text-zinc-500";

  return (
    <Modal
      title={existing ? "编辑连接配置" : "新建连接配置"}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>取消</Button>
          <PrimaryButton onClick={submit} disabled={busy}>
            {busy ? "保存中…" : "保存"}
          </PrimaryButton>
        </>
      }
      width={440}
    >
      <div className="space-y-3">
        {validationError && (
          <div
            role="alert"
            className="rounded border border-[var(--glance-danger-border)] bg-[var(--glance-danger-bg)] px-2.5 py-1.5 text-xs text-[var(--glance-danger-text)]"
          >
            {validationError}
          </div>
        )}
        <div>
          <label className={labelClass}>配置名称（选填，留空则默认显示主机 IP）</label>
          <input
            ref={nameRef}
            autoFocus
            defaultValue={existing?.name ?? ""}
            placeholder="选填，留空显示 IP"
            className={inputClass}
          />
        </div>
        <div className="flex gap-2">
          <div className="flex-1">
            <label className={labelClass}>主机（IP / 主机名）</label>
            <input
              ref={hostRef}
              defaultValue={initialHost}
              placeholder="192.168.1.100"
              className={inputClass}
            />
          </div>
          <div className="w-20">
            <label className={labelClass}>端口</label>
            <input
              ref={portRef}
              defaultValue={String(initialPort)}
              inputMode="numeric"
              className={inputClass}
            />
          </div>
        </div>
        <div>
          <label className={labelClass}>用户名</label>
          <input
            ref={usernameRef}
            defaultValue={existing?.username ?? ""}
            placeholder="root / 用户名"
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass}>认证方式</label>
          <div className="flex gap-2">
            {AUTH_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => {
                  authRef.current = opt.value;
                  setAuthMethod(opt.value);
                }}
                className={`flex-1 rounded border px-2 py-1.5 text-sm transition-colors ${
                  authMethod === opt.value
                    ? "border-sky-600 bg-sky-600/10 text-sky-300"
                    : "border-zinc-600 text-zinc-400 hover:border-zinc-500"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {authMethod === "password" && (
          <div>
            <label className={labelClass}>
              {existing ? "密码（留空则不修改）" : "密码"}
            </label>
            <input
              ref={passwordRef}
              type="password"
              defaultValue=""
              placeholder="仅存于系统钥匙串"
              className={inputClass}
            />
            <p className="mt-1 text-[11px] text-zinc-600">密码只写入 macOS 钥匙串 / Windows 凭据管理器，数据库不保存明文。</p>
          </div>
        )}

        {authMethod === "public_key" && (
          <>
            <div>
              <label className={labelClass}>私钥文件路径</label>
              <input
                ref={keyPathRef}
                defaultValue={existing?.keyPath ?? ""}
                placeholder="~/.ssh/id_ed25519"
                className={`${inputClass} select-text font-mono text-xs`}
              />
            </div>
            <div>
              <label className={labelClass}>私钥口令（可选，留空则不修改）</label>
              <input ref={keyPassRef} type="password" defaultValue="" className={inputClass} />
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
