import { tabsStore } from "../../stores/tabs";
import { Button, Modal, PrimaryButton } from "../common/Modal";

/** 未保存更改确认（关闭标签时） */
export function UnsavedCloseModal() {
  const pendingCloseId = tabsStore((s) => s.pendingCloseId);
  const tab = tabsStore((s) => s.tabs.find((t) => t.uri === s.pendingCloseId));
  const confirmClose = tabsStore((s) => s.confirmClose);
  const cancelClose = tabsStore((s) => s.cancelClose);

  if (!pendingCloseId || !tab) return null;

  return (
    <Modal
      title="未保存的更改"
      onClose={cancelClose}
      footer={
        <>
          <Button onClick={cancelClose}>取消</Button>
          <Button
            onClick={() => void confirmClose(pendingCloseId, true)}
            className="bg-zinc-700 text-zinc-200 hover:bg-zinc-600"
          >
            不保存
          </Button>
          <PrimaryButton onClick={() => void confirmClose(pendingCloseId, false)}>
            保存并关闭
          </PrimaryButton>
        </>
      }
    >
      <p>
        <span className="text-zinc-100">{tab.name}</span> 有未保存的更改，是否在关闭前保存？
      </p>
    </Modal>
  );
}

/** 保存冲突（远端文件已被修改）——遵循路线图 §5.4：默认不静默覆盖 */
export function SaveConflictModal() {
  const conflict = tabsStore((s) => s.pendingConflict);
  const loadRemote = tabsStore((s) => s.resolveConflictLoadRemote);
  const overwrite = tabsStore((s) => s.resolveConflictOverwrite);
  const dismiss = tabsStore((s) => s.dismissConflict);

  if (!conflict) return null;

  const remoteTime = new Date(conflict.remoteMtimeMs).toLocaleString("zh-CN");

  return (
    <Modal
      title="文件冲突"
      onClose={dismiss}
      footer={
        <>
          <Button onClick={dismiss}>取消</Button>
          <Button onClick={() => void loadRemote()}>加载远端版本（丢弃本地）</Button>
          <PrimaryButton onClick={() => void overwrite()}>用本地版本覆盖</PrimaryButton>
        </>
      }
    >
      <p className="mb-2">
        文件 <span className="text-zinc-100">{conflict.path}</span>{" "}
        在打开后被其他程序修改过。
      </p>
      <p className="text-xs text-zinc-500">远端最后修改时间：{remoteTime}</p>
      <p className="mt-2 text-xs text-amber-500">
        请确认是否使用当前编辑器内容覆盖磁盘文件，或加载磁盘最新版本。
      </p>
    </Modal>
  );
}
