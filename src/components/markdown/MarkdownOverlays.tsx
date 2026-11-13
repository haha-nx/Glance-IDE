import type { ReactNode } from "react";
import { IconClose } from "../common/icons";
import { Button, Modal, PrimaryButton } from "../common/Modal";

export interface MarkdownWysiwygProps {
  uri: string;
  headerRight?: ReactNode;
}

export interface TocItem {
  id: string;
  level: number;
  text: string;
  element: HTMLElement;
}

export interface ContextMenuState {
  x: number;
  y: number;
  inTable: boolean;
}

export type MarkdownSubmenu = "heading" | "format" | "insert" | "table" | null;

/** Markdown 左侧文档大纲侧边栏 */
export function MarkdownTocSidebar({
  tocItems,
  onClose,
}: {
  tocItems: TocItem[];
  onClose: () => void;
}) {
  return (
    <div className="w-60 shrink-0 border-r border-zinc-800 bg-zinc-950/90 p-3 flex flex-col min-h-0 select-none">
      <div className="flex items-center justify-between pb-2 mb-2 border-b border-zinc-800 text-xs font-medium text-zinc-300">
        <span className="flex items-center gap-1.5">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="8" y1="6" x2="21" y2="6" />
            <line x1="8" y1="12" x2="21" y2="12" />
            <line x1="8" y1="18" x2="21" y2="18" />
            <line x1="3" y1="6" x2="3.01" y2="6" />
            <line x1="3" y1="12" x2="3.01" y2="12" />
            <line x1="3" y1="18" x2="3.01" y2="18" />
          </svg>
          文档大纲
        </span>
        <button
          onClick={onClose}
          className="text-zinc-500 hover:text-zinc-300 p-0.5 rounded hover:bg-zinc-800"
          title="关闭大纲"
          aria-label="关闭文档大纲"
        >
          <IconClose size={12} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto space-y-0.5">
        {tocItems.length === 0 ? (
          <p className="text-xs text-zinc-500 py-6 text-center">暂无标题段落</p>
        ) : (
          tocItems.map((item) => (
            <button
              key={item.id}
              onClick={() => {
                item.element.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
              style={{ paddingLeft: `${(item.level - 1) * 12 + 8}px` }}
              className="flex w-full items-center text-left text-xs py-1 text-zinc-400 hover:bg-zinc-800/80 hover:text-sky-300 rounded truncate transition-colors"
              title={item.text}
            >
              <span className="truncate">{item.text}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

/** Typora 风格右键菜单 */
export function MarkdownContextMenu({
  contextMenu,
  hoverSubmenu,
  onHoverSubmenu,
  onClose,
  onInsertHeading,
  onExecFormat,
  onInsertInlineCode,
  onOpenInsertTable,
  onInsertCodeBlock,
  onInsertBlockquote,
  onInsertUnorderedList,
  onInsertOrderedList,
  onInsertTaskItem,
  onInsertHorizontalRule,
  onAddTableRow,
  onRemoveTableRow,
  onAddTableCol,
  onRemoveTableCol,
  onDeleteEntireTable,
}: {
  contextMenu: ContextMenuState;
  hoverSubmenu: MarkdownSubmenu;
  onHoverSubmenu: (submenu: MarkdownSubmenu) => void;
  onClose: () => void;
  onInsertHeading: (level: number) => void;
  onExecFormat: (cmd: string) => void;
  onInsertInlineCode: () => void;
  onOpenInsertTable: () => void;
  onInsertCodeBlock: () => void;
  onInsertBlockquote: () => void;
  onInsertUnorderedList: () => void;
  onInsertOrderedList: () => void;
  onInsertTaskItem: () => void;
  onInsertHorizontalRule: () => void;
  onAddTableRow: () => void;
  onRemoveTableRow: () => void;
  onAddTableCol: () => void;
  onRemoveTableCol: () => void;
  onDeleteEntireTable: () => void;
}) {
  return (
    <div
      id="md-wysiwyg-context-menu"
      style={{ top: `${contextMenu.y}px`, left: `${contextMenu.x}px` }}
      className="fixed z-[9999] w-52 rounded-lg border border-zinc-700/80 bg-zinc-950/98 py-1.5 text-xs text-zinc-200 shadow-2xl backdrop-blur-md select-none"
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {/* 段落子菜单 */}
      <div
        className="relative px-3 py-1.5 flex items-center justify-between hover:bg-zinc-800/80 cursor-pointer rounded-sm"
        onMouseEnter={() => onHoverSubmenu("heading")}
      >
        <span>段落格式</span>
        <span className="text-zinc-500 text-[10px]">▸</span>

        {hoverSubmenu === "heading" && (
          <div className="absolute left-full top-0 ml-1 w-36 rounded-lg border border-zinc-700/80 bg-zinc-950/95 py-1 shadow-2xl backdrop-blur-md">
            {[1, 2, 3, 4].map((lvl) => (
              <button
                key={lvl}
                onClick={() => onInsertHeading(lvl)}
                className="flex w-full items-center justify-between px-3 py-1 text-left hover:bg-sky-600 hover:text-white"
              >
                <span>{["一级标题", "二级标题", "三级标题", "四级标题"][lvl - 1]}</span>
                <span className="text-zinc-500 text-[10px]">H{lvl}</span>
              </button>
            ))}
            <div className="my-1 border-t border-zinc-800" />
            <button
              onClick={() => onInsertHeading(0)}
              className="flex w-full items-center justify-between px-3 py-1 text-left hover:bg-sky-600 hover:text-white"
            >
              <span>普通段落</span>
              <span className="text-zinc-500 text-[10px]">P</span>
            </button>
          </div>
        )}
      </div>

      {/* 字体格式子菜单 */}
      <div
        className="relative px-3 py-1.5 flex items-center justify-between hover:bg-zinc-800/80 cursor-pointer rounded-sm"
        onMouseEnter={() => onHoverSubmenu("format")}
      >
        <span>字体样式</span>
        <span className="text-zinc-500 text-[10px]">▸</span>

        {hoverSubmenu === "format" && (
          <div className="absolute left-full top-0 ml-1 w-36 rounded-lg border border-zinc-700/80 bg-zinc-950/95 py-1 shadow-2xl backdrop-blur-md">
            <button
              onClick={() => onExecFormat("bold")}
              className="flex w-full items-center justify-between px-3 py-1 text-left hover:bg-sky-600 hover:text-white"
            >
              <span className="font-bold">加粗</span>
              <span className="text-zinc-500 text-[10px]">Ctrl+B</span>
            </button>
            <button
              onClick={() => onExecFormat("italic")}
              className="flex w-full items-center justify-between px-3 py-1 text-left hover:bg-sky-600 hover:text-white"
            >
              <span className="italic">斜体</span>
              <span className="text-zinc-500 text-[10px]">Ctrl+I</span>
            </button>
            <button
              onClick={() => onExecFormat("strikeThrough")}
              className="flex w-full items-center justify-between px-3 py-1 text-left hover:bg-sky-600 hover:text-white"
            >
              <span className="line-through">删除线</span>
            </button>
            <button
              onClick={onInsertInlineCode}
              className="flex w-full items-center justify-between px-3 py-1 text-left hover:bg-sky-600 hover:text-white"
            >
              <span className="font-mono text-sky-400">&lt;代码&gt;</span>
            </button>
          </div>
        )}
      </div>

      <div className="my-1 border-t border-zinc-800" />

      {/* 插入元素 */}
      <button
        onClick={() => {
          onClose();
          onOpenInsertTable();
        }}
        onMouseEnter={() => onHoverSubmenu(null)}
        className="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-sky-600 hover:text-white"
      >
        <span>插入表格…</span>
        <span className="text-zinc-500 text-[10px]">Table</span>
      </button>

      <button
        onClick={onInsertCodeBlock}
        onMouseEnter={() => onHoverSubmenu(null)}
        className="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-sky-600 hover:text-white"
      >
        <span>代码块</span>
        <span className="text-zinc-500 text-[10px]">```</span>
      </button>

      <button
        onClick={onInsertBlockquote}
        onMouseEnter={() => onHoverSubmenu(null)}
        className="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-sky-600 hover:text-white"
      >
        <span>引用块</span>
        <span className="text-zinc-500 text-[10px]">&gt;</span>
      </button>

      <button
        onClick={onInsertUnorderedList}
        onMouseEnter={() => onHoverSubmenu(null)}
        className="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-sky-600 hover:text-white"
      >
        <span>无序列表</span>
        <span className="text-zinc-500 text-[10px]">•</span>
      </button>

      <button
        onClick={onInsertOrderedList}
        onMouseEnter={() => onHoverSubmenu(null)}
        className="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-sky-600 hover:text-white"
      >
        <span>有序列表</span>
        <span className="text-zinc-500 text-[10px]">1.</span>
      </button>

      <button
        onClick={onInsertTaskItem}
        onMouseEnter={() => onHoverSubmenu(null)}
        className="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-sky-600 hover:text-white"
      >
        <span>待办清单</span>
        <span className="text-zinc-500 text-[10px]">☑</span>
      </button>

      <button
        onClick={onInsertHorizontalRule}
        onMouseEnter={() => onHoverSubmenu(null)}
        className="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-sky-600 hover:text-white"
      >
        <span>分割线</span>
        <span className="text-zinc-500 text-[10px]">---</span>
      </button>

      {/* 表格专属快捷操作 */}
      {contextMenu.inTable && (
        <>
          <div className="my-1 border-t border-zinc-800" />
          <div
            className="relative px-3 py-1.5 flex items-center justify-between hover:bg-zinc-800/80 cursor-pointer rounded-sm text-sky-400"
            onMouseEnter={() => onHoverSubmenu("table")}
          >
            <span>表格操作</span>
            <span className="text-zinc-500 text-[10px]">▸</span>

            {hoverSubmenu === "table" && (
              <div className="absolute left-full top-0 ml-1 w-36 rounded-lg border border-zinc-700/80 bg-zinc-950/95 py-1 shadow-2xl backdrop-blur-md text-zinc-200">
                <button
                  onClick={() => {
                    onAddTableRow();
                    onClose();
                  }}
                  className="flex w-full items-center px-3 py-1 text-left hover:bg-sky-600 hover:text-white"
                >
                  在下方插入行
                </button>
                <button
                  onClick={() => {
                    onRemoveTableRow();
                    onClose();
                  }}
                  className="flex w-full items-center px-3 py-1 text-left text-amber-400 hover:bg-sky-600 hover:text-white"
                >
                  删除当前行
                </button>
                <button
                  onClick={() => {
                    onAddTableCol();
                    onClose();
                  }}
                  className="flex w-full items-center px-3 py-1 text-left hover:bg-sky-600 hover:text-white"
                >
                  在右侧插入列
                </button>
                <button
                  onClick={() => {
                    onRemoveTableCol();
                    onClose();
                  }}
                  className="flex w-full items-center px-3 py-1 text-left text-amber-400 hover:bg-sky-600 hover:text-white"
                >
                  删除当前列
                </button>
                <div className="my-1 border-t border-zinc-800" />
                <button
                  onClick={() => {
                    onDeleteEntireTable();
                    onClose();
                  }}
                  className="flex w-full items-center px-3 py-1 text-left text-red-400 hover:bg-red-600 hover:text-white"
                >
                  删除整个表格
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** 插入表格模态框（复用统一 Modal，提供 Escape / ARIA 支持） */
export function TableInsertModal({
  rows,
  cols,
  onRowsChange,
  onColsChange,
  onClose,
  onConfirm,
}: {
  rows: number;
  cols: number;
  onRowsChange: (val: number) => void;
  onColsChange: (val: number) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      title="插入表格"
      width={340}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <PrimaryButton onClick={onConfirm}>插入表格</PrimaryButton>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between text-xs">
          <label className="text-zinc-400">行数 (Rows)：</label>
          <input
            type="number"
            min={1}
            max={30}
            value={rows}
            onChange={(e) => onRowsChange(Number(e.target.value))}
            className="w-24 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-center font-mono text-xs text-zinc-200 outline-none focus:border-sky-500"
          />
        </div>

        <div className="flex items-center justify-between text-xs">
          <label className="text-zinc-400">列数 (Columns)：</label>
          <input
            type="number"
            min={1}
            max={20}
            value={cols}
            onChange={(e) => onColsChange(Number(e.target.value))}
            className="w-24 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-center font-mono text-xs text-zinc-200 outline-none focus:border-sky-500"
          />
        </div>
      </div>
    </Modal>
  );
}
