import { useEffect, useState } from "react";
import { appApi } from "../../services/files";
import { Button, Modal } from "./Modal";

/** 设置弹窗（首个版本提供基础信息与说明，后续接入主题/编辑器偏好） */
export function SettingsModal({ onClose }: { onClose: () => void }) {
  const [version, setVersion] = useState("Glance IDE");

  useEffect(() => {
    appApi
      .getInfo()
      .then((i) => setVersion(`${i.name} ${i.version}`))
      .catch(() => {});
  }, []);

  return (
    <Modal title="设置" onClose={onClose} width={440}>
      <div className="space-y-3 text-sm text-zinc-300">
        <div className="rounded border border-zinc-700 bg-zinc-900 px-3 py-2">
          <p className="text-xs text-zinc-500">关于</p>
          <p className="mt-1">{version}</p>
          <p className="mt-1 text-xs text-zinc-500">本地 / 远程一体化开发工作台</p>
        </div>
        <div className="rounded border border-zinc-700 bg-zinc-900 px-3 py-2">
          <p className="text-xs text-zinc-500">通用</p>
          <ul className="mt-1 list-disc pl-5 text-xs text-zinc-400">
            <li>界面主题：暗色（当前唯一）</li>
            <li>编辑器字号：13px / 等宽字体</li>
            <li>凭据存储：系统钥匙串（macOS Keychain）</li>
          </ul>
          <p className="mt-2 text-[11px] text-zinc-600">
            完整设置项（主题切换、字体、终端外观）将随后续迭代提供。
          </p>
        </div>
        <div className="flex justify-end">
          <Button onClick={onClose}>关闭</Button>
        </div>
      </div>
    </Modal>
  );
}
