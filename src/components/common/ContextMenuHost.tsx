import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IS_MAC } from "../../lib/platform";
import { contextMenuStore, type ContextMenuEntry } from "../../stores/contextMenu";

interface ContextMenuHostProps {
  onOpenFolder: () => void;
  onOpenFile: () => void;
  onNewTerminal: () => void;
  onOpenSettings: () => void;
}

const TEXT_INPUT_TYPES = new Set([
  "",
  "text",
  "search",
  "url",
  "tel",
  "email",
  "password",
  "number",
]);

const MOD = IS_MAC ? "⌘" : "Ctrl+";

function isEditableInputOrTextarea(el: HTMLElement | null): el is HTMLInputElement | HTMLTextAreaElement {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return !el.disabled;
  if (el instanceof HTMLInputElement) {
    const t = (el.getAttribute("type") ?? "").toLowerCase();
    return TEXT_INPUT_TYPES.has(t) && !el.disabled;
  }
  return false;
}

function writeClipboard(text: string): void {
  if (!text) return;
  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text).catch(() => {
      try {
        document.execCommand("copy");
      } catch {
        /* 忽略 */
      }
    });
    return;
  }
  try {
    document.execCommand("copy");
  } catch {
    /* 忽略 */
  }
}

/** 通过原生 value setter 替换选区文本并派发 input 事件，确保 React 受控输入框同步更新 */
function replaceInputRange(
  el: HTMLInputElement | HTMLTextAreaElement,
  start: number,
  end: number,
  replacement: string,
): void {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  const nextValue = el.value.slice(0, start) + replacement + el.value.slice(end);
  if (nativeSetter) {
    nativeSetter.call(el, nextValue);
  } else {
    el.value = nextValue;
  }
  const cursor = start + replacement.length;
  el.focus();
  try {
    el.setSelectionRange(cursor, cursor);
  } catch {
    /* number 等不支持选区的输入类型忽略 */
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function buildEditableMenuItems(
  editableEl: HTMLInputElement | HTMLTextAreaElement | HTMLElement,
): ContextMenuEntry[] {
  if (isEditableInputOrTextarea(editableEl)) {
    const start = editableEl.selectionStart ?? 0;
    const end = editableEl.selectionEnd ?? 0;
    const hasSelection = end > start;
    const selectedText = hasSelection ? editableEl.value.slice(start, end) : "";
    const readOnly = editableEl.readOnly;

    return [
      {
        label: "剪切",
        shortcut: `${MOD}X`,
        disabled: readOnly || !hasSelection,
        action: () => {
          writeClipboard(selectedText);
          replaceInputRange(editableEl, start, end, "");
        },
      },
      {
        label: "复制",
        shortcut: `${MOD}C`,
        disabled: !hasSelection,
        action: () => {
          writeClipboard(selectedText);
          editableEl.focus();
        },
      },
      {
        label: "粘贴",
        shortcut: `${MOD}V`,
        disabled: readOnly,
        action: async () => {
          try {
            const text = await navigator.clipboard.readText();
            const curStart = editableEl.selectionStart ?? editableEl.value.length;
            const curEnd = editableEl.selectionEnd ?? editableEl.value.length;
            replaceInputRange(editableEl, curStart, curEnd, text);
          } catch {
            editableEl.focus();
            document.execCommand("paste");
          }
        },
      },
      { type: "separator" },
      {
        label: "全选",
        shortcut: `${MOD}A`,
        disabled: editableEl.value.length === 0,
        action: () => {
          editableEl.focus();
          editableEl.select();
        },
      },
    ];
  }

  const sel = window.getSelection();
  const selectedText = sel?.toString() ?? "";
  const hasSelection = selectedText.length > 0;
  return [
    {
      label: "剪切",
      shortcut: `${MOD}X`,
      disabled: !hasSelection,
      action: () => {
        editableEl.focus();
        document.execCommand("cut");
      },
    },
    {
      label: "复制",
      shortcut: `${MOD}C`,
      disabled: !hasSelection,
      action: () => {
        writeClipboard(selectedText);
      },
    },
    {
      label: "粘贴",
      shortcut: `${MOD}V`,
      action: async () => {
        editableEl.focus();
        try {
          const text = await navigator.clipboard.readText();
          if (text) document.execCommand("insertText", false, text);
        } catch {
          document.execCommand("paste");
        }
      },
    },
    { type: "separator" },
    {
      label: "全选",
      shortcut: `${MOD}A`,
      action: () => {
        editableEl.focus();
        document.execCommand("selectAll");
      },
    },
  ];
}

/** 全局自定义右键菜单宿主与 WebView 原生菜单拦截器 */
export function ContextMenuHost({
  onOpenFolder,
  onOpenFile,
  onNewTerminal,
  onOpenSettings,
}: ContextMenuHostProps) {
  const menu = contextMenuStore((s) => s.menu);
  const close = contextMenuStore((s) => s.close);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; ready: boolean }>({
    left: 0,
    top: 0,
    ready: false,
  });

  const actionsRef = useRef({ onOpenFolder, onOpenFile, onNewTerminal, onOpenSettings });
  actionsRef.current = { onOpenFolder, onOpenFile, onNewTerminal, onOpenSettings };

  // 测量并把菜单钳制在视口内（溢出右侧或底部时优先翻折到指针另一侧）
  useLayoutEffect(() => {
    if (!menu) {
      setPos({ left: 0, top: 0, ready: false });
      return;
    }
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = menu.x;
    let top = menu.y;
    if (left + rect.width + margin > vw) {
      left = Math.max(margin, menu.x - rect.width);
    }
    if (left + rect.width + margin > vw) {
      left = Math.max(margin, vw - rect.width - margin);
    }
    if (top + rect.height + margin > vh) {
      top = Math.max(margin, menu.y - rect.height);
    }
    if (top + rect.height + margin > vh) {
      top = Math.max(margin, vh - rect.height - margin);
    }
    setPos({ left, top, ready: true });
  }, [menu]);

  // 菜单展开期间：点击外部 / Escape / 失焦 / 缩放 / 外部滚动自动关闭
  useEffect(() => {
    if (!menu) return;
    const onMouseDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onBlur = () => close();
    const onResize = () => close();
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && menuRef.current?.contains(e.target)) return;
      close();
    };

    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [menu, close]);

  // 全局兜底 contextmenu 拦截：禁止出现浏览器/WebView2 原生菜单
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      const target = e.target instanceof HTMLElement ? e.target : null;

      // 代码编辑区放行 Monaco 主题化代码菜单（避免被外层吞掉或双重弹出）
      if (target?.closest(".monaco-editor")) {
        contextMenuStore.getState().close();
        return;
      }

      e.preventDefault();

      const editable = target?.closest<HTMLElement>(
        "textarea, input, [contenteditable='true'], [contenteditable='']",
      );
      if (editable && (isEditableInputOrTextarea(editable) || editable.isContentEditable)) {
        contextMenuStore.getState().open(e.clientX, e.clientY, buildEditableMenuItems(editable));
        return;
      }

      const selectedText = window.getSelection()?.toString() ?? "";
      if (selectedText.trim().length > 0) {
        contextMenuStore.getState().open(e.clientX, e.clientY, [
          {
            label: "复制",
            shortcut: `${MOD}C`,
            action: () => writeClipboard(selectedText),
          },
          { type: "separator" },
          {
            label: "设置",
            shortcut: `${MOD},`,
            action: () => actionsRef.current.onOpenSettings(),
          },
        ]);
        return;
      }

      contextMenuStore.getState().open(e.clientX, e.clientY, [
        {
          label: "打开文件夹…",
          action: () => actionsRef.current.onOpenFolder(),
        },
        {
          label: "打开文件…",
          action: () => actionsRef.current.onOpenFile(),
        },
        { type: "separator" },
        {
          label: "新建终端",
          action: () => actionsRef.current.onNewTerminal(),
        },
        {
          label: "设置",
          shortcut: `${MOD},`,
          action: () => actionsRef.current.onOpenSettings(),
        },
      ]);
    };

    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, []);

  if (!menu) return null;

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      onMouseDown={(e) => e.preventDefault()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      style={{
        left: `${pos.left}px`,
        top: `${pos.top}px`,
        opacity: pos.ready ? 1 : 0,
      }}
      className="glance-menu fixed z-[10000] min-w-[180px] backdrop-blur-md"
    >
      {menu.items.map((item, idx) => {
        if (item.type === "separator") {
          return <div key={`sep-${idx}`} className="glance-menu-sep" />;
        }
        return (
          <button
            key={`${item.label}-${idx}`}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return;
              close();
              void item.action();
            }}
            className={`glance-menu-item ${item.danger ? "glance-menu-item-danger" : ""}`}
          >
            <span className="truncate">{item.label}</span>
            {item.shortcut && <span className="glance-menu-shortcut">{item.shortcut}</span>}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
