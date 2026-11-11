import { monaco, languageForFileName } from "./monaco";
import { tabsStore } from "../stores/tabs";

/**
 * Monaco Model 注册表：
 * - 同一资源 URI 只创建一个稳定 Model
 * - modelUri 使用自定义 scheme，本地为 local://<posix-path>
 * - 远程资源（M3）将使用 remote://<device-identity-id>/<path>，天然按设备隔离
 */

/** 资源路径 → Model URI：远程 remote:// 与 wsl:// 本身即稳定 URI；本地加 local:// 前缀 */
export function toModelUri(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (normalized.startsWith("remote://") || normalized.startsWith("wsl://")) return normalized;
  return `local://${normalized}`;
}

interface ModelRecord {
  model: monaco.editor.ITextModel;
  changeSub: monaco.IDisposable;
}

const registry = new Map<string, ModelRecord>();
const suppressed = new Set<string>();

function onModelContent(uri: string): void {
  if (suppressed.has(uri)) return;
  tabsStore.getState().markDirty(uri, true);
}

export function hasModel(uri: string): boolean {
  return registry.has(uri);
}

export function getOrCreateModel(
  uri: string,
  initialValue: string,
  fileName: string,
): monaco.editor.ITextModel {
  const existing = registry.get(uri);
  if (existing) return existing.model;

  const parsedUri = monaco.Uri.parse(uri);
  const monacoExisting = monaco.editor.getModel(parsedUri);
  if (monacoExisting) {
    monacoExisting.setValue(initialValue);
    const changeSub = monacoExisting.onDidChangeContent(() => onModelContent(uri));
    registry.set(uri, { model: monacoExisting, changeSub });
    return monacoExisting;
  }

  const model = monaco.editor.createModel(
    initialValue,
    languageForFileName(fileName),
    parsedUri,
  );
  const changeSub = model.onDidChangeContent(() => onModelContent(uri));
  registry.set(uri, { model, changeSub });
  // 通知远程 LSP 桥（M6）：经 window 事件解耦，避免 models→lsp→tabs→models 循环
  window.dispatchEvent(new CustomEvent("glance:model-created", { detail: { uri } }));
  return model;
}

export function getModel(uri: string): monaco.editor.ITextModel | undefined {
  return registry.get(uri)?.model;
}

/** 静默替换内容（冲突后加载远端版本），不触发 dirty 标记 */
export function setModelValueQuiet(uri: string, value: string): void {
  const record = registry.get(uri);
  if (!record) return;
  suppressed.add(uri);
  try {
    record.model.pushEditOperations(
      [],
      [
        {
          range: record.model.getFullModelRange(),
          text: value,
        },
      ],
      () => null,
    );
  } finally {
    // 等待本微任务内的变更事件派发完毕后再解除抑制
    queueMicrotask(() => suppressed.delete(uri));
  }
}

export function disposeModel(uri: string): void {
  const record = registry.get(uri);
  if (!record) return;
  record.changeSub.dispose();
  record.model.dispose();
  registry.delete(uri);
  // 通知远程 LSP 桥：didClose + 解除订阅
  window.dispatchEvent(new CustomEvent("glance:model-disposed", { detail: { uri } }));
}
