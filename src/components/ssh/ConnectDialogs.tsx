import { useState } from "react";
import { Button, Modal, PrimaryButton } from "../common/Modal";
import type { ConnectOutcome, ConnectionProfileDto } from "../../types/ssh";

interface RegisterIdentityDialogProps {
  profile: ConnectionProfileDto;
  outcome: Extract<ConnectOutcome, { status: "unknownIdentity" | "identityChanged" }>;
  busy: boolean;
  onCancel: () => void;
  /** 确认登记（含用户输入的设备备注名），由父级完成 approve + 重连 */
  onConfirm: (displayName: string | null) => void;
}

/**
 * 未知/变化 Host Key 的登记对话框（路线图 §4.5，ADR-007）：
 * - unknownIdentity：设备池为空的首次登记
 * - identityChanged：端点返回的指纹不属于设备池（轮换未登记 或 密钥变化）
 * 两者都必须由用户明确登记，绝不自动放行。
 */
export function RegisterIdentityDialog({
  profile,
  outcome,
  busy,
  onCancel,
  onConfirm,
}: RegisterIdentityDialogProps) {
  const [displayName, setDisplayName] = useState("");
  const isChanged = outcome.status === "identityChanged";

  return (
    <Modal
      title={isChanged ? "设备身份变化警告" : "发现新设备身份"}
      onClose={onCancel}
      footer={
        <>
          <Button onClick={onCancel}>取消</Button>
          <PrimaryButton onClick={() => onConfirm(displayName.trim() || null)} disabled={busy}>
            {busy ? "连接中…" : "登记并连接"}
          </PrimaryButton>
        </>
      }
    >
      {isChanged ? (
        <div className="mb-3 space-y-2">
          <p className="text-amber-400">
            当前端点返回的 Host Key 不在「{profile.name}」的设备池中。可能原因：
          </p>
          <ul className="list-disc pl-5 text-xs text-zinc-400">
            <li>另一台设备正在使用相同的 IP（设备轮换，尚未登记）</li>
            <li>该设备重装系统或重新生成了 Host Key</li>
            <li>存在中间人攻击风险</li>
          </ul>
          <p className="text-xs text-zinc-500">
            该配置已信任 {outcome.expected.length} 台设备。请通过树莓派本地控制台等
            <span className="text-zinc-300"> 带外方式 </span>
            核对下方指纹后再登记。
          </p>
        </div>
      ) : (
        <p className="mb-3 text-sm text-zinc-400">
          这是「{profile.name}」首次登记的设备身份。建议通过设备本地控制台或现场标签
          <span className="text-zinc-300"> 带外核对 </span>
          指纹后再登记。
        </p>
      )}

      <div className="mb-3 space-y-1.5">
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <span>算法</span>
          <span className="text-zinc-300">{outcome.keyAlgorithm}</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <span>指纹</span>
          <code className="select-text break-all rounded bg-zinc-900 px-2 py-1 font-mono text-[11px] text-sky-300">
            {outcome.fingerprint}
          </code>
        </div>
      </div>

      <input
        autoFocus
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value)}
        placeholder="设备备注名（如：Raspberry Pi A）"
        className="w-full rounded border border-zinc-600 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-200 outline-none focus:border-sky-600"
      />
    </Modal>
  );
}
