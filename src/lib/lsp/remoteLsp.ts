import * as monaco from "monaco-editor";
import { create } from "zustand";
import { lspApi } from "../../services/lsp";
import { sshApi } from "../../services/ssh";
import { explorerStore } from "../../stores/explorer";

/**
 * 远程 LSP 桥（路线图 M6，§6.2/§6.4/§6.5）。
 *
 * 冻结决策（Spike 结论，详见 docs/Handoff.md）：
 * - 传输：Tauri Channel（Rust 侧 SSH exec 无 PTY + JSON-RPC 组帧）；不引入本地 WebSocket。
 * - 客户端：不引入 monaco-languageclient（其 8.x/9.x 强制绑定 @codingame/monaco-vscode-api
 *   全家桶，会替换 vanilla Monaco，与本项目 EditorHost/Model 架构冲突）；
 *   前端直接消费 JSON-RPC JSON 消息，自建轻量 Monaco 映射（补全/悬停/定义跳转/诊断）。
 * - 缓存键（§6.5）：device_identity_id + workspace_root + language（控制器实例即上下文）。
 * - 同步策略：didChange 全量文本 + 250ms 防抖（first 版本 §5.4 边界内）。
 */

/** 语言 → 服务器候选（按序回退，§6.2 首选工具） */
const SERVER_SPECS: Record<string, Array<{ server: string; args: string[] }>> = {
  cpp: [{ server: "clangd", args: [] }],
  c: [{ server: "clangd", args: [] }],
  python: [{ server: "pylsp", args: [] }, { server: "pyright-langserver", args: ["--stdio"] }],
};

const REMOTE_PREFIX = "remote://";

export function parseRemoteUri(uri: string): { deviceId: string; path: string } | null {
  if (!uri.startsWith(REMOTE_PREFIX)) return null;
  const rest = uri.slice(REMOTE_PREFIX.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  return { deviceId: rest.slice(0, slash), path: rest.slice(slash) };
}

/** 远端路径 → LSP 文档 URI（目标设备本机文件系统视角） */
function toDocUri(path: string): string {
  return "file://" + encodeURI(path);
}

function fromDocUri(docUri: string, deviceId: string): string {
  const path = decodeURIComponent(docUri.replace(/^file:\/\//, ""));
  return `${REMOTE_PREFIX}${deviceId}${path}`;
}

// ── 状态栏可见状态 ─────────────────────────────────────────────────────────────

export interface LspStatus {
  state: "starting" | "ready" | "failed" | "closed";
  server?: string;
  message?: string;
}

interface LspStatusState {
  statuses: Record<string, LspStatus>; // deviceId → status
  set: (deviceId: string, status: LspStatus) => void;
  clear: (deviceId: string) => void;
}

export const lspStatusStore = create<LspStatusState>()((set) => ({
  statuses: {},
  set: (deviceId, status) =>
    set((s) => ({ statuses: { ...s.statuses, [deviceId]: status } })),
  clear: (deviceId) =>
    set((s) => {
      const next = { ...s.statuses };
      delete next[deviceId];
      return { statuses: next };
    }),
}));

// ── LSP ↔ JSON-RPC 基础 ────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

// ── 控制器：一个 (device, workspace, language) 一条远程语言服务器 ──────────────

class RemoteLspController {
  readonly deviceId: string;
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly languageId: string;
  private lspId: string | null = null;
  private specIndex = 0;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private openedDocs = new Map<string, monaco.editor.ITextModel>(); // modelUri → model
  private docVersions = new Map<string, number>();
  private changeDisposals = new Map<string, monaco.IDisposable>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private providers: monaco.IDisposable[] = [];
  private disposed = false;
  private started = false;

  constructor(deviceId: string, sessionId: string, workspaceRoot: string, languageId: string) {
    this.deviceId = deviceId;
    this.sessionId = sessionId;
    this.workspaceRoot = workspaceRoot;
    this.languageId = languageId;
  }

  /** 启动：开通道 → initialize 握手 → 注册 Provider → 补打开已存在文档 */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.updateStatus("starting");
    await this.openChannel();
  }

  private async openChannel(): Promise<void> {
    const specs = SERVER_SPECS[this.languageId] ?? [];
    const spec = specs[this.specIndex];
    if (!spec) {
      this.updateStatus("failed", { message: `没有可用的语言服务器（${this.languageId}）` });
      return;
    }
    try {
      const info = await lspApi.open(
        this.sessionId,
        this.workspaceRoot,
        this.languageId,
        spec.server,
        spec.args,
        (e) => this.onEvent(e),
      );
      this.lspId = info.lspId;
      this.updateStatus("starting", { server: spec.server });
      await this.handshake(spec.server);
    } catch (err) {
      await this.failover(String(err));
    }
  }

  private async handshake(server: string): Promise<void> {
    try {
      const result = (await this.request("initialize", {
        processId: null,
        rootUri: toDocUri(this.workspaceRoot),
        capabilities: {
          textDocument: {
            hover: { contentFormat: ["markdown", "plaintext"] },
            completion: { completionItem: { snippetSupport: true } },
          },
        },
      })) as Json;
      this.notify("initialized", {});
      this.registerProviders(result);
      for (const [uri, model] of this.openedDocs) {
        this.sendDidOpen(uri, model);
      }
      this.updateStatus("ready", { server });
    } catch (err) {
      await this.failover(String(err));
    }
  }

  /** 服务器启动失败/握手失败：尝试下一候选（§6.6 降级可见） */
  private async failover(reason: string): Promise<void> {
    this.cleanupChannel();
    const specs = SERVER_SPECS[this.languageId] ?? [];
    if (this.specIndex + 1 < specs.length) {
      this.specIndex += 1;
      await this.openChannel();
      return;
    }
    this.updateStatus("failed", { message: reason });
  }

  private onEvent(e: {
    type: "message" | "stderr" | "closed";
    message?: unknown;
    text?: string;
    reason?: string | null;
  }): void {
    if (this.disposed) return;
    if (e.type === "message" && e.message) {
      this.onMessage(e.message as Json);
    } else if (e.type === "closed") {
      // 远端进程退出/会话断开：整体释放（Provider 与诊断一并清理）
      void this.dispose();
    }
  }

  private onMessage(msg: Json): void {
    const id = msg.id as number | null;
    if (id != null && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(id);
      if (p) {
        this.pending.delete(id);
        if (msg.error) {
          p.reject(new Error(JSON.stringify(msg.error)));
        } else {
          p.resolve(msg.result);
        }
      }
      return;
    }
    const method = msg.method as string | undefined;
    if (method === "textDocument/publishDiagnostics") {
      this.onDiagnostics(msg.params as Json);
    }
    // window/showMessage 等通知暂不处理（§6.4 首版边界）
  }

  private onDiagnostics(params: Json): void {
    const docUri = params.uri as string | undefined;
    if (!docUri) return;
    const modelUri = fromDocUri(docUri, this.deviceId);
    const model = this.openedDocs.get(modelUri);
    if (!model || model.isDisposed()) return;
    const diagnostics = (params.diagnostics ?? []) as Array<Json>;
    const markers: monaco.editor.IMarkerData[] = diagnostics.map((d) => {
      const range = d.range as Json;
      const severity = (d.severity as number) ?? 1;
      return {
        startLineNumber: ((range.start as Json).line as number) + 1,
        startColumn: ((range.start as Json).character as number) + 1,
        endLineNumber: ((range.end as Json).line as number) + 1,
        endColumn: ((range.end as Json).character as number) + 1,
        message: (d.message as string) ?? "",
        severity: toMarkerSeverity(severity),
        source: (d.source as string) ?? undefined,
        code: d.code != null ? String(d.code) : undefined,
      };
    });
    monaco.editor.setModelMarkers(model, "remote-lsp", markers);
  }

  // ── Monaco Provider 注册 ──────────────────────────────────────────────────

  private registerProviders(initializeResult: Json): void {
    const caps = (initializeResult.capabilities ?? {}) as Json;
    const completionCaps = (caps.completionProvider ?? null) as Json | null;
    const triggerCharacters = ((completionCaps?.triggerCharacters ?? []) as string[]).filter(
      (c) => typeof c === "string" && c.length > 0,
    );

    this.providers.push(
      monaco.languages.registerCompletionItemProvider(this.languageId, {
        triggerCharacters,
        provideCompletionItems: (model, position) => this.provideCompletion(model, position),
      }),
    );
    this.providers.push(
      monaco.languages.registerHoverProvider(this.languageId, {
        provideHover: (model, position) => this.provideHover(model, position),
      }),
    );
    this.providers.push(
      monaco.languages.registerDefinitionProvider(this.languageId, {
        provideDefinition: (model, position) => this.provideDefinition(model, position),
      }),
    );
  }

  private async provideCompletion(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
  ): Promise<monaco.languages.CompletionList> {
    if (!this.canServe(model)) return { suggestions: [] };
    try {
      const result = (await this.request("textDocument/completion", {
        textDocument: { uri: toDocUri(this.docPath(model)) },
        position: { line: position.lineNumber - 1, character: position.column - 1 },
      })) as Json | Json[] | null;
      const items = Array.isArray(result) ? result : ((result?.items ?? []) as Array<Json>);
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const suggestions: monaco.languages.CompletionItem[] = [];
      for (const [idx, item] of items.entries()) {
        suggestions.push(toMonacoCompletion(item, range, idx));
      }
      return { suggestions };
    } catch {
      return { suggestions: [] };
    }
  }

  private async provideHover(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
  ): Promise<monaco.languages.Hover | null> {
    if (!this.canServe(model)) return null;
    try {
      const result = (await this.request("textDocument/hover", {
        textDocument: { uri: toDocUri(this.docPath(model)) },
        position: { line: position.lineNumber - 1, character: position.column - 1 },
      })) as Json | null;
      if (!result || result.contents == null) return null;
      const md = normalizeHoverContents(result.contents);
      if (!md) return null;
      const range = result.range as Json | undefined;
      return {
        contents: [{ value: md }],
        range: range
          ? {
              startLineNumber: ((range.start as Json).line as number) + 1,
              startColumn: ((range.start as Json).character as number) + 1,
              endLineNumber: ((range.end as Json).line as number) + 1,
              endColumn: ((range.end as Json).character as number) + 1,
            }
          : undefined,
      };
    } catch {
      return null;
    }
  }

  private async provideDefinition(
    model: monaco.editor.ITextModel,
    position: monaco.Position,
  ): Promise<monaco.languages.Definition | null> {
    if (!this.canServe(model)) return null;
    try {
      const result = (await this.request("textDocument/definition", {
        textDocument: { uri: toDocUri(this.docPath(model)) },
        position: { line: position.lineNumber - 1, character: position.column - 1 },
      })) as Json | Array<Json> | null;
      const locations = Array.isArray(result) ? result : result ? [result] : [];
      const out: Array<{ uri: monaco.Uri; range: monaco.IRange }> = [];
      for (const loc of locations) {
        const docUri = loc.uri as string | undefined;
        if (!docUri) continue;
        const range = (loc.range ?? ((loc.targetSelectionRange as Json) ?? {})) as Json;
        const start = (range.start ?? { line: 0, character: 0 }) as Json;
        out.push({
          uri: monaco.Uri.parse(fromDocUri(docUri, this.deviceId)),
          range: {
            startLineNumber: ((start.line as number) ?? 0) + 1,
            startColumn: ((start.character as number) ?? 0) + 1,
            endLineNumber: ((start.line as number) ?? 0) + 1,
            endColumn: 1,
          },
        });
      }
      return out.length > 0 ? out : null;
    } catch {
      return null;
    }
  }

  // ── 文档同步 ──────────────────────────────────────────────────────────────

  private docPath(model: monaco.editor.ITextModel): string {
    const parsed = parseRemoteUri(model.uri.toString());
    return parsed ? parsed.path : "/";
  }

  private canServe(model: monaco.editor.ITextModel): boolean {
    if (this.disposed || !this.lspId) return false;
    const parsed = parseRemoteUri(model.uri.toString());
    return parsed != null && parsed.deviceId === this.deviceId;
  }

  /** 管理器入口：模型打开即挂接（无论是否激活标签，诊断需后台推送） */
  attachModel(model: monaco.editor.ITextModel): void {
    if (this.disposed || !this.canServe(model)) return;
    const key = model.uri.toString();
    if (this.openedDocs.has(key)) return;
    this.openedDocs.set(key, model);
    if (this.lspId) {
      this.sendDidOpen(key, model);
      this.watchChanges(key, model);
    }
    // 未 ready 时由 start() 流程在握手完成后统一 didOpen + watch
  }

  private sendDidOpen(key: string, model: monaco.editor.ITextModel): void {
    const version = model.getVersionId();
    this.docVersions.set(key, version);
    this.notify("textDocument/didOpen", {
      textDocument: {
        uri: toDocUri(this.docPath(model)),
        languageId: this.languageId,
        version,
        text: model.getValue(),
      },
    });
    this.watchChanges(key, model);
  }

  private watchChanges(key: string, model: monaco.editor.ITextModel): void {
    if (this.changeDisposals.has(key)) return;
    const disposal = model.onDidChangeContent(() => {
      // 全量同步 + 防抖（§6.4 首版：语义正确优先于带宽）
      const prev = this.debounceTimers.get(key);
      if (prev) clearTimeout(prev);
      this.debounceTimers.set(
        key,
        setTimeout(() => {
          this.debounceTimers.delete(key);
          if (this.disposed || !this.lspId || model.isDisposed()) return;
          const version = model.getVersionId();
          this.docVersions.set(key, version);
          this.notify("textDocument/didChange", {
            textDocument: { uri: toDocUri(this.docPath(model)), version },
            contentChanges: [{ text: model.getValue() }],
          });
        }, 250),
      );
    });
    this.changeDisposals.set(key, disposal);
  }

  /** 模型关闭（标签关闭/工作区切换）：didClose + 解除订阅 */
  detachModel(uri: string): void {
    const model = this.openedDocs.get(uri);
    if (!model) return;
    this.openedDocs.delete(uri);
    this.changeDisposals.get(uri)?.dispose();
    this.changeDisposals.delete(uri);
    const timer = this.debounceTimers.get(uri);
    if (timer) clearTimeout(timer);
    this.debounceTimers.delete(uri);
    if (this.lspId && !model.isDisposed()) {
      this.notify("textDocument/didClose", {
        textDocument: { uri: toDocUri(this.docPath(model)) },
      });
    }
    if (!model.isDisposed()) {
      monaco.editor.setModelMarkers(model, "remote-lsp", []);
    }
  }

  handleModelDisposed(uri: string): void {
    this.detachModel(uri);
  }

  // ── 请求/通知 ─────────────────────────────────────────────────────────────

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    if (!this.lspId || !lspApi.send(this.lspId, { jsonrpc: "2.0", id, method, params })) {
      this.pending.delete(id);
      return Promise.reject(new Error("LSP 通道不可用"));
    }
    // 请求超时（避免悬挂）：30s
    const timer = setTimeout(() => {
      const p = this.pending.get(id);
      if (p) {
        this.pending.delete(id);
        p.reject(new Error("LSP 请求超时"));
      }
    }, 30_000);
    void timer;
    return promise;
  }

  private notify(method: string, params: unknown): void {
    if (!this.lspId) return;
    void lspApi.send(this.lspId, { jsonrpc: "2.0", method, params });
  }

  // ── 生命周期 ──────────────────────────────────────────────────────────────

  private updateStatus(state: LspStatus["state"], extra?: { server?: string; message?: string }): void {
    lspStatusStore.getState().set(this.deviceId, {
      state,
      server: extra?.server ?? lspStatusStore.getState().statuses[this.deviceId]?.server,
      message: extra?.message,
    });
  }

  private cleanupChannel(): void {
    this.pending.forEach((p) => p.reject(new Error("LSP 通道已关闭")));
    this.pending.clear();
    if (this.lspId) {
      void lspApi.close(this.lspId);
      this.lspId = null;
    }
  }

  /** 完整关闭：shutdown/exit 协议语义 + 释放 Provider 与订阅 */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const [uri, model] of this.openedDocs) {
      if (!model.isDisposed() && this.lspId) {
        this.notify("textDocument/didClose", {
          textDocument: { uri: toDocUri(this.docPath(model)) },
        });
      }
      this.changeDisposals.get(uri)?.dispose();
      const t = this.debounceTimers.get(uri);
      if (t) clearTimeout(t);
      if (!model.isDisposed()) {
        monaco.editor.setModelMarkers(model, "remote-lsp", []);
      }
    }
    this.openedDocs.clear();
    this.changeDisposals.clear();
    this.debounceTimers.clear();
    if (this.lspId) {
      try {
        await lspApi.send(this.lspId, { jsonrpc: "2.0", id: this.nextId++, method: "shutdown", params: null });
        this.notify("exit", null);
      } catch {
        /* 通道已亡 */
      }
    }
    this.cleanupChannel();
    this.providers.forEach((d) => d.dispose());
    this.providers = [];
    lspStatusStore.getState().clear(this.deviceId);
  }
}

// ── 映射辅助 ──────────────────────────────────────────────────────────────────

function toMarkerSeverity(severity: number): monaco.MarkerSeverity {
  switch (severity) {
    case 1:
      return monaco.MarkerSeverity.Error;
    case 2:
      return monaco.MarkerSeverity.Warning;
    case 3:
      return monaco.MarkerSeverity.Info;
    default:
      return monaco.MarkerSeverity.Hint;
  }
}

/** LSP CompletionItemKind(1-25) → Monaco（命名常量，未知回退 Value） */
function toCompletionKind(kind: unknown): monaco.languages.CompletionItemKind {
  const k = typeof kind === "number" ? kind : 12;
  const map: Record<number, monaco.languages.CompletionItemKind> = {
    1: monaco.languages.CompletionItemKind.Text,
    2: monaco.languages.CompletionItemKind.Method,
    3: monaco.languages.CompletionItemKind.Function,
    4: monaco.languages.CompletionItemKind.Constructor,
    5: monaco.languages.CompletionItemKind.Field,
    6: monaco.languages.CompletionItemKind.Variable,
    7: monaco.languages.CompletionItemKind.Class,
    8: monaco.languages.CompletionItemKind.Interface,
    9: monaco.languages.CompletionItemKind.Module,
    10: monaco.languages.CompletionItemKind.Property,
    11: monaco.languages.CompletionItemKind.Unit,
    12: monaco.languages.CompletionItemKind.Value,
    13: monaco.languages.CompletionItemKind.Enum,
    14: monaco.languages.CompletionItemKind.Keyword,
    15: monaco.languages.CompletionItemKind.Snippet,
    16: monaco.languages.CompletionItemKind.Color,
    17: monaco.languages.CompletionItemKind.File,
    18: monaco.languages.CompletionItemKind.Reference,
    19: monaco.languages.CompletionItemKind.Folder,
    20: monaco.languages.CompletionItemKind.EnumMember,
    21: monaco.languages.CompletionItemKind.Constant,
    22: monaco.languages.CompletionItemKind.Struct,
    23: monaco.languages.CompletionItemKind.Event,
    24: monaco.languages.CompletionItemKind.Operator,
    25: monaco.languages.CompletionItemKind.Interface,
  };
  return map[k] ?? monaco.languages.CompletionItemKind.Value;
}

function toMonacoCompletion(
  item: Json,
  range: monaco.IRange,
  index: number,
): monaco.languages.CompletionItem {
  const label =
    typeof item.label === "string"
      ? item.label
      : ((item.label as Json)?.label as string) ?? "";
  const insertFormat = item.insertTextFormat as number | undefined; // 1=plain 2=snippet
  let insertText =
    typeof item.insertText === "string" ? item.insertText : label;
  let insertTextRules: monaco.languages.CompletionItemInsertTextRule | undefined;
  let finalRange = range;

  // textEdit 优先（精确替换范围）
  const textEdit = item.textEdit as Json | undefined;
  if (textEdit && typeof textEdit.newText === "string") {
    insertText = textEdit.newText;
    const r = textEdit.range as Json | undefined;
    if (r) {
      finalRange = {
        startLineNumber: ((r.start as Json).line as number) + 1,
        startColumn: ((r.start as Json).character as number) + 1,
        endLineNumber: ((r.end as Json).line as number) + 1,
        endColumn: ((r.end as Json).character as number) + 1,
      };
    }
  }
  if (insertFormat === 2) {
    insertTextRules = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
  }

  const doc = item.documentation;
  let documentation: monaco.IMarkdownString | string | undefined;
  if (typeof doc === "string") {
    documentation = doc;
  } else if (doc && typeof doc === "object") {
    const kind = (doc as Json).kind as string | undefined;
    const value = (doc as Json).value as string | undefined;
    if (typeof value === "string") {
      documentation = { value: kind === "markdown" ? value : "```text\n" + value + "\n```" };
    }
  }

  return {
    label,
    kind: toCompletionKind(item.kind),
    insertText,
    insertTextRules,
    range: finalRange,
    detail: typeof item.detail === "string" ? item.detail : undefined,
    documentation,
    sortText: typeof item.sortText === "string" ? item.sortText : String(index).padStart(6, "0"),
    filterText: typeof item.filterText === "string" ? item.filterText : undefined,
    preselect: item.preselect === true,
  };
}

/** LSP Hover.contents 三形态 → Markdown 文本 */
function normalizeHoverContents(contents: unknown): string | null {
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) {
    return contents
      .map((c) => normalizeHoverContents(c))
      .filter(Boolean)
      .join("\n\n");
  }
  if (contents && typeof contents === "object") {
    const obj = contents as Json;
    if (typeof obj.value === "string") {
      const kind = obj.kind as string | undefined;
      if (kind === "plaintext") return "```text\n" + obj.value + "\n```";
      return obj.value;
    }
    if (typeof obj.language === "string" && typeof obj.value === "string") {
      return "```" + obj.language + "\n" + obj.value + "\n```";
    }
  }
  return null;
}

// ── 管理器（单例）：键 = device_identity_id + workspace + language（§6.5）──────

class LspManager {
  private controllers = new Map<string, RemoteLspController>();
  /** deviceId → 已挂接模型 URI 集合（控制器就绪前到达的模型在此排队） */
  private modelUris = new Map<string, Set<string>>();

  private key(deviceId: string, workspace: string, language: string): string {
    return `${deviceId}|${workspace}|${language}`;
  }

  /** 模型创建事件入口（models.ts 经 window 事件解耦） */
  handleModelCreated(uri: string): void {
    const parsed = parseRemoteUri(uri);
    if (!parsed) return;
    const set = this.modelUris.get(parsed.deviceId) ?? new Set<string>();
    set.add(uri);
    this.modelUris.set(parsed.deviceId, set);
    void this.ensureController(uri, parsed);
  }

  handleModelDisposed(uri: string): void {
    const parsed = parseRemoteUri(uri);
    if (!parsed) return;
    this.modelUris.get(parsed.deviceId)?.delete(uri);
    for (const c of this.controllers.values()) {
      c.handleModelDisposed(uri);
    }
  }

  /** 会话断开/设备下线：释放该设备全部控制器 */
  async disposeDevice(deviceId: string): Promise<void> {
    const keys = [...this.controllers.keys()].filter((k) =>
      k.startsWith(`${deviceId}|`),
    );
    for (const k of keys) {
      const c = this.controllers.get(k);
      this.controllers.delete(k);
      await c?.dispose();
    }
  }

  private async ensureController(uri: string, parsed: { deviceId: string; path: string }): Promise<void> {
    const model = monaco.editor
      .getModels()
      .find((m) => m.uri.toString() === uri);
    if (!model) return;
    const languageId = model.getLanguageId();
    if (!SERVER_SPECS[languageId]) {
      lspStatusStore.getState().set(parsed.deviceId, {
        state: "closed",
        message: `${languageId} 无远程语言服务器支持`,
      });
      return;
    }

    // 工作区根：优先当前远程根（同设备），否则文件所在目录
    const root = explorerStore.getState().rootPath;
    let workspaceRoot: string;
    const rootParsed = root ? parseRemoteUri(root) : null;
    if (rootParsed && rootParsed.deviceId === parsed.deviceId) {
      workspaceRoot = rootParsed.path;
    } else {
      const idx = parsed.path.lastIndexOf("/");
      workspaceRoot = idx > 0 ? parsed.path.slice(0, idx) : "/";
    }

    const key = this.key(parsed.deviceId, workspaceRoot, languageId);
    let controller = this.controllers.get(key);
    if (!controller) {
      // 找到该设备的活跃会话（远程操作按 device_identity_id 路由，§9.3）
      let sessionId: string | null = null;
      try {
        const sessions = await sshApi.listSessions();
        sessionId =
          sessions.find((s) => s.deviceIdentityId === parsed.deviceId)?.sessionId ?? null;
      } catch {
        sessionId = null;
      }
      if (!sessionId) {
        lspStatusStore.getState().set(parsed.deviceId, {
          state: "closed",
          message: "设备未连接，语言智能降级",
        });
        return;
      }
      controller = new RemoteLspController(
        parsed.deviceId,
        sessionId,
        workspaceRoot,
        languageId,
      );
      this.controllers.set(key, controller);
      await controller.start().catch(() => {
        this.controllers.delete(key);
      });
    }
    controller.attachModel(model);
  }
}

export const lspManager = new LspManager();

// models.ts ↔ LSP 解耦事件（避免 models→lsp→tabs→models 循环依赖）
window.addEventListener("glance:model-created", (e) => {
  const detail = (e as CustomEvent<{ uri: string }>).detail;
  if (detail?.uri) lspManager.handleModelCreated(detail.uri);
});
window.addEventListener("glance:model-disposed", (e) => {
  const detail = (e as CustomEvent<{ uri: string }>).detail;
  if (detail?.uri) lspManager.handleModelDisposed(detail.uri);
});
window.addEventListener("glance:session-disconnected", (e) => {
  const detail = (e as CustomEvent<{ deviceIdentityId: string }>).detail;
  if (detail?.deviceIdentityId) void lspManager.disposeDevice(detail.deviceIdentityId);
});
// 重连：释放旧上下文后，为该设备已打开的模型重新走一遍挂接流程
// （Model 常驻注册表，不会重新触发 model-created，需显式复活）
window.addEventListener("glance:session-connected", (e) => {
  const detail = (e as CustomEvent<{ deviceIdentityId: string }>).detail;
  if (!detail?.deviceIdentityId) return;
  const deviceId = detail.deviceIdentityId;
  void lspManager.disposeDevice(deviceId).then(() => {
    const prefix = `remote://${deviceId}`;
    for (const model of monaco.editor.getModels()) {
      const uri = model.uri.toString();
      if (uri.startsWith(prefix)) lspManager.handleModelCreated(uri);
    }
  });
});
