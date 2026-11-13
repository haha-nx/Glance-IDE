import { useEffect, useRef, useState, useCallback } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { getModel } from "../../lib/models";
import { tabsStore } from "../../stores/tabs";
import { domToMarkdown } from "../../lib/domToMarkdown";
import {
  MarkdownContextMenu,
  MarkdownTocSidebar,
  TableInsertModal,
  type ContextMenuState,
  type MarkdownSubmenu,
  type MarkdownWysiwygProps,
  type TocItem,
} from "./MarkdownOverlays";

export function MarkdownWysiwyg({ uri, headerRight }: MarkdownWysiwygProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const [stats, setStats] = useState({ chars: 0, lines: 0 });
  const [tocOpen, setTocOpen] = useState(false);
  const [tocItems, setTocItems] = useState<TocItem[]>([]);

  // 表格插入弹窗（输入几行几列）
  const [tableModalOpen, setTableModalOpen] = useState(false);
  const [modalRows, setModalRows] = useState(3);
  const [modalCols, setModalCols] = useState(3);

  // 表格右上角操作按钮（悬停表格时显示）
  const [activeTable, setActiveTable] = useState<HTMLTableElement | null>(null);
  const [tableToolbarPos, setTableToolbarPos] = useState<{ top: number; right: number } | null>(null);
  const [tableResizeOpen, setTableResizeOpen] = useState(false);
  const [targetRows, setTargetRows] = useState(3);
  const [targetCols, setTargetCols] = useState(3);

  // 右键菜单（参考 Typora 风格）
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [hoverSubmenu, setHoverSubmenu] = useState<MarkdownSubmenu>(null);

  const isComposingRef = useRef(false);
  const isInternalChangeRef = useRef(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedRangeRef = useRef<Range | null>(null);

  // 提取并更新大纲目录
  const refreshToc = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const headings = Array.from(container.querySelectorAll("h1, h2, h3, h4, h5, h6")) as HTMLElement[];
    const items: TocItem[] = headings.map((h, i) => {
      const level = parseInt(h.tagName.substring(1), 10) || 1;
      const text = h.innerText.trim() || `标题 ${i + 1}`;
      if (!h.id) {
        h.id = `glance-heading-${i}-${Math.random().toString(36).slice(2, 6)}`;
      }
      return { id: h.id, level, text, element: h };
    });
    setTocItems(items);
  }, []);

  // 从 Monaco Model 重新渲染到可编辑 DOM
  const renderFromModel = useCallback(() => {
    const model = getModel(uri);
    if (!model || !containerRef.current) return;
    const text = model.getValue();
    const rawHtml = marked.parse(text, { async: false, gfm: true }) as string;
    const cleanHtml = DOMPurify.sanitize(rawHtml, {
      ADD_TAGS: ["input"],
      ADD_ATTR: ["type", "checked", "disabled"],
    });

    containerRef.current.innerHTML = cleanHtml;

    // 允许复选框可交互
    const checkboxes = containerRef.current.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach((cb) => {
      (cb as HTMLInputElement).disabled = false;
    });

    setStats({
      chars: text.length,
      lines: text.split("\n").filter((l) => l.trim().length > 0).length,
    });

    refreshToc();
  }, [uri, refreshToc]);

  const syncDomToModel = useCallback(
    (el: HTMLElement | null, updateUiState: boolean) => {
      if (!el) return;
      const md = domToMarkdown(el);
      const model = getModel(uri);
      if (model && model.getValue() !== md) {
        isInternalChangeRef.current = true;
        try {
          model.pushEditOperations(
            [],
            [{ range: model.getFullModelRange(), text: md }],
            () => null,
          );
          tabsStore.getState().markDirty(uri, true);
        } finally {
          queueMicrotask(() => {
            isInternalChangeRef.current = false;
          });
        }
      }
      if (updateUiState) {
        setStats({
          chars: md.length,
          lines: md.split("\n").filter((l) => l.trim().length > 0).length,
        });
        refreshToc();
      }
    },
    [uri, refreshToc],
  );

  // 初始化与外部变更监听
  useEffect(() => {
    const mountedEl = containerRef.current;
    const attachModelListener = () => {
      const m = getModel(uri);
      if (!m) return undefined;
      return m.onDidChangeContent(() => {
        if (isInternalChangeRef.current) return;
        renderFromModel();
      });
    };

    if (getModel(uri)) {
      renderFromModel();
    }
    let sub = attachModelListener();

    // 监听 Model 异步创建完成事件（远程 SSH / WSL 读取完成后派发）
    const handleModelCreated = (e: Event) => {
      const detail = (e as CustomEvent<{ uri: string }>).detail;
      if (detail && detail.uri === uri) {
        renderFromModel();
        sub?.dispose();
        sub = attachModelListener();
      }
    };
    window.addEventListener("glance:model-created", handleModelCreated);

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
        // 卸载/切模式前立刻把防抖队列里的 DOM 变更冲刷回 Monaco Model，防止丢失最后 250ms 的编辑
        syncDomToModel(mountedEl ?? containerRef.current, false);
      }
      sub?.dispose();
      window.removeEventListener("glance:model-created", handleModelCreated);
    };
  }, [uri, renderFromModel, syncDomToModel]);

  // 当用户在富文本区域编辑时，防抖同步回 Monaco TextModel
  const handleContentChange = () => {
    if (isComposingRef.current) return;
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);

    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      syncDomToModel(containerRef.current, true);
    }, 250);
  };
  const handleContentChangeRef = useRef(handleContentChange);
  handleContentChangeRef.current = handleContentChange;

  // 监听待办复选框事件
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleChange = (e: Event) => {
      const target = e.target as HTMLElement;
      if (target && target.tagName.toLowerCase() === "input" && target.getAttribute("type") === "checkbox") {
        handleContentChangeRef.current();
      }
    };

    container.addEventListener("change", handleChange);
    return () => container.removeEventListener("change", handleChange);
  }, []);

  // 点击外部关闭右键菜单（延时绑定以避免捕获当前右键点击事件）
  useEffect(() => {
    if (!contextMenu) return;
    const onPointerDown = (e: MouseEvent) => {
      const menu = document.getElementById("md-wysiwyg-context-menu");
      if (menu && menu.contains(e.target as Node)) {
        return;
      }
      setContextMenu(null);
      setHoverSubmenu(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setContextMenu(null);
        setHoverSubmenu(null);
      }
    };

    const timer = setTimeout(() => {
      window.addEventListener("mousedown", onPointerDown);
      window.addEventListener("keydown", onKeyDown);
    }, 60);

    return () => {
      clearTimeout(timer);
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [contextMenu]);

  // 监听表格悬停，显示表格右上角工具栏
  const handleContainerMouseMove = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const table = target.closest("table") as HTMLTableElement | null;
    const scrollContainer = scrollAreaRef.current;

    if (table && scrollContainer) {
      setActiveTable(table);
      const tRect = table.getBoundingClientRect();
      const cRect = scrollContainer.getBoundingClientRect();
      setTableToolbarPos({
        top: tRect.top - cRect.top + scrollContainer.scrollTop + 4,
        right: cRect.right - tRect.right + 8,
      });
    } else if (!target.closest("#table-floating-toolbar") && !tableResizeOpen) {
      setActiveTable(null);
      setTableToolbarPos(null);
    }
  };

  // 保存与恢复选区
  const saveSelection = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && containerRef.current?.contains(sel.anchorNode)) {
      savedRangeRef.current = sel.getRangeAt(0).cloneRange();
    }
  };

  const restoreSelection = () => {
    const container = containerRef.current;
    if (!container) return;
    container.focus();
    const sel = window.getSelection();
    if (!sel) return;

    if (savedRangeRef.current && container.contains(savedRangeRef.current.commonAncestorContainer)) {
      sel.removeAllRanges();
      sel.addRange(savedRangeRef.current);
    } else {
      const range = document.createRange();
      range.selectNodeContents(container);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  };

  // 右键事件处理
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    saveSelection();

    const target = e.target as HTMLElement;
    const inTable = !!target.closest("table");

    // 计算右键菜单位置（防止超出视口右/下边界）
    const x = Math.min(e.clientX, window.innerWidth - 230);
    const y = Math.min(e.clientY, window.innerHeight - 380);

    setContextMenu({ x, y, inTable });
    setHoverSubmenu(null);
  };

  // 格式化命令执行（原生可撤销）
  function execFormat(command: string, value: string | undefined = undefined) {
    restoreSelection();
    document.execCommand(command, false, value);
    handleContentChange();
    saveSelection();
    setContextMenu(null);
  }

  // 在光标处安全插入 HTML 片段，优先使用 execCommand 以支持 Ctrl+Z 撤销
  function insertHtmlAtCursor(html: string) {
    restoreSelection();
    const success = document.execCommand("insertHTML", false, html);
    if (!success) {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      range.deleteContents();
      const tpl = document.createElement("template");
      tpl.innerHTML = html.trim();
      const frag = tpl.content;
      const lastChild = frag.lastElementChild || frag.lastChild;
      range.insertNode(frag);
      if (lastChild) {
        range.setStartAfter(lastChild);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    }

    containerRef.current?.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      (cb as HTMLInputElement).disabled = false;
    });

    handleContentChange();
    saveSelection();
    setContextMenu(null);
  }

  function insertHeading(level: number) {
    if (level === 0) {
      execFormat("formatBlock", "<p>");
    } else {
      execFormat("formatBlock", `<h${level}>`);
    }
  }

  function insertOrderedList() {
    execFormat("insertOrderedList");
  }

  function insertUnorderedList() {
    execFormat("insertUnorderedList");
  }

  function insertTaskItem() {
    insertHtmlAtCursor(`<ul><li class="task-list-item"><input type="checkbox"> 新待办事项</li></ul><p><br></p>`);
  }

  function insertBlockquote() {
    restoreSelection();
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) {
      document.execCommand("formatBlock", false, "<blockquote>");
      handleContentChange();
      setContextMenu(null);
    } else {
      insertHtmlAtCursor(`<blockquote><p>引用内容</p></blockquote><p><br></p>`);
    }
  }

  // 代码块：选中文本则将选中段落转为代码块；未选中文本插入空白代码块
  function insertCodeBlock() {
    restoreSelection();
    const sel = window.getSelection();
    const selectedText = sel ? sel.toString() : "";
    if (selectedText.trim()) {
      const escaped = selectedText
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      insertHtmlAtCursor(`<pre><code>${escaped}\n</code></pre><p><br></p>`);
    } else {
      insertHtmlAtCursor(`<pre><code>// 在此输入代码\n</code></pre><p><br></p>`);
    }
  }

  // 插入指定行数和列数的表格
  function insertCustomTable(rows: number, cols: number) {
    setTableModalOpen(false);
    const r = Math.max(1, Math.min(30, rows));
    const c = Math.max(1, Math.min(20, cols));

    let theadCells = "";
    for (let j = 1; j <= c; j++) {
      theadCells += `<th>表头 ${j}</th>`;
    }

    let tbodyRows = "";
    for (let i = 1; i <= r; i++) {
      let rowCells = "";
      for (let j = 1; j <= c; j++) {
        rowCells += `<td>单元格 ${i}-${j}</td>`;
      }
      tbodyRows += `<tr>${rowCells}</tr>`;
    }

    const tableHtml = `<table><thead><tr>${theadCells}</tr></thead><tbody>${tbodyRows}</tbody></table><p><br></p>`;
    insertHtmlAtCursor(tableHtml);
  }

  function insertHorizontalRule() {
    insertHtmlAtCursor(`<hr><p><br></p>`);
  }

  // 表格动态操作：添加行
  function addTableRow() {
    if (!activeTable) return;
    const tbody = activeTable.querySelector("tbody") || activeTable;
    const firstRow = activeTable.querySelector("tr");
    const colCount = firstRow ? firstRow.children.length : 3;

    const tr = document.createElement("tr");
    for (let j = 0; j < colCount; j++) {
      const td = document.createElement("td");
      td.innerHTML = "新单元格";
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
    handleContentChange();
  }

  // 表格动态操作：删除行
  function removeTableRow() {
    if (!activeTable) return;
    const tbody = activeTable.querySelector("tbody");
    if (tbody && tbody.rows.length > 1) {
      tbody.deleteRow(tbody.rows.length - 1);
      handleContentChange();
    }
  }

  // 表格动态操作：添加列
  function addTableCol() {
    if (!activeTable) return;
    const theadTr = activeTable.querySelector("thead tr");
    if (theadTr) {
      const th = document.createElement("th");
      th.innerHTML = "新列";
      theadTr.appendChild(th);
    }
    const tbodyRows = Array.from(activeTable.querySelectorAll("tbody tr"));
    tbodyRows.forEach((row) => {
      const td = document.createElement("td");
      td.innerHTML = "-";
      row.appendChild(td);
    });
    handleContentChange();
  }

  // 表格动态操作：删除列
  function removeTableCol() {
    if (!activeTable) return;
    const theadTr = activeTable.querySelector("thead tr");
    if (theadTr && theadTr.children.length > 1) {
      theadTr.removeChild(theadTr.lastElementChild!);
    }
    const tbodyRows = Array.from(activeTable.querySelectorAll("tbody tr"));
    tbodyRows.forEach((row) => {
      if (row.children.length > 1) {
        row.removeChild(row.lastElementChild!);
      }
    });
    handleContentChange();
  }

  // 表格动态操作：删除整个表格
  function deleteEntireTable() {
    if (!activeTable) return;
    activeTable.remove();
    setActiveTable(null);
    setTableToolbarPos(null);
    setTableResizeOpen(false);
    handleContentChange();
  }

  // 打开表格设置行列面板
  function openResizePopover() {
    if (!activeTable) return;
    const r = activeTable.querySelectorAll("tbody tr").length || 1;
    const c = activeTable.querySelector("tr")?.children.length || 1;
    setTargetRows(r);
    setTargetCols(c);
    setTableResizeOpen((v) => !v);
  }

  // 表格动态操作：调整行列尺寸
  function applyTableResize() {
    if (!activeTable) return;
    const targetR = Math.max(1, Math.min(50, targetRows));
    const targetC = Math.max(1, Math.min(20, targetCols));

    // 1. 调整表头 thead
    let thead = activeTable.querySelector("thead");
    if (!thead) {
      thead = document.createElement("thead");
      activeTable.prepend(thead);
    }
    let theadTr = thead.querySelector("tr");
    if (!theadTr) {
      theadTr = document.createElement("tr");
      thead.appendChild(theadTr);
    }
    while (theadTr.children.length < targetC) {
      const th = document.createElement("th");
      th.innerHTML = `表头 ${theadTr.children.length + 1}`;
      theadTr.appendChild(th);
    }
    while (theadTr.children.length > targetC) {
      theadTr.removeChild(theadTr.lastElementChild!);
    }

    // 2. 调整表体 tbody
    let tbody = activeTable.querySelector("tbody");
    if (!tbody) {
      tbody = document.createElement("tbody");
      activeTable.appendChild(tbody);
    }
    Array.from(tbody.querySelectorAll("tr")).forEach((tr) => {
      while (tr.children.length < targetC) {
        const td = document.createElement("td");
        td.innerHTML = "-";
        tr.appendChild(td);
      }
      while (tr.children.length > targetC) {
        tr.removeChild(tr.lastElementChild!);
      }
    });

    while (tbody.rows.length < targetR) {
      const tr = document.createElement("tr");
      for (let c = 0; c < targetC; c++) {
        const td = document.createElement("td");
        td.innerHTML = "-";
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    while (tbody.rows.length > targetR) {
      tbody.deleteRow(tbody.rows.length - 1);
    }

    setTableResizeOpen(false);
    handleContentChange();
  }

  // 快捷键拦截（支持 Ctrl+Z 撤销与 Ctrl+Y 重做）
  const handleKeyDown = (e: React.KeyboardEvent) => {
    const isMeta = e.metaKey || e.ctrlKey;
    if (isMeta && e.key.toLowerCase() === "b") {
      e.preventDefault();
      execFormat("bold");
    } else if (isMeta && e.key.toLowerCase() === "i") {
      e.preventDefault();
      execFormat("italic");
    } else if (isMeta && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      syncDomToModel(containerRef.current, true);
      void tabsStore.getState().saveTab(uri);
    } else if (isMeta && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (e.shiftKey) {
        document.execCommand("redo");
      } else {
        document.execCommand("undo");
      }
      handleContentChange();
    } else if (isMeta && e.key.toLowerCase() === "y") {
      e.preventDefault();
      document.execCommand("redo");
      handleContentChange();
    }
  };

  return (
    <div className="flex h-full w-full min-h-0 flex-1 flex-col bg-zinc-900 select-text overflow-hidden">
      {/* 顶部工具栏：仅保留大纲按钮 + 右侧字数统计与预览/源码切换 */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-950 px-3 text-xs">
        <div className="flex items-center gap-2">
          {/* 大纲侧边栏切换按钮 */}
          <button
            onClick={() => setTocOpen((v) => !v)}
            className={`flex items-center gap-1.5 rounded border px-2.5 py-1 text-xs transition-colors ${
              tocOpen
                ? "border-sky-500 bg-sky-600/25 text-sky-300 font-medium shadow-sm"
                : "border-zinc-700/70 bg-zinc-900 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
            }`}
            title="查看或收起文档大纲侧边栏"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="8" y1="6" x2="21" y2="6" />
              <line x1="8" y1="12" x2="21" y2="12" />
              <line x1="8" y1="18" x2="21" y2="18" />
              <line x1="3" y1="6" x2="3.01" y2="6" />
              <line x1="3" y1="12" x2="3.01" y2="12" />
              <line x1="3" y1="18" x2="3.01" y2="18" />
            </svg>
            <span>大纲</span>
          </button>
        </div>

        {/* 右侧：字数、段落统计 + 预览/源码切换按钮 */}
        <div className="flex shrink-0 items-center gap-3 text-[11px] text-zinc-500">
          <span>{stats.chars} 字</span>
          <span>{stats.lines} 段</span>
          {headerRight}
        </div>
      </div>

      {/* 主编辑区 + 左侧大纲侧边栏 */}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {/* 文档大纲侧边栏（置于左侧，不影响全局 IDE 侧边栏） */}
        {tocOpen && (
          <MarkdownTocSidebar tocItems={tocItems} onClose={() => setTocOpen(false)} />
        )}

        {/* 原地编辑排版区域 */}
        <div
          ref={scrollAreaRef}
          onMouseMove={handleContainerMouseMove}
          onContextMenu={handleContextMenu}
          className="relative min-h-0 flex-1 overflow-y-auto px-12 py-8"
        >
          {/* 表格右上角浮动操作按钮 */}
          {activeTable && tableToolbarPos && (
            <div
              id="table-floating-toolbar"
              style={{ top: `${tableToolbarPos.top}px`, right: `${tableToolbarPos.right}px` }}
              className="absolute z-40 flex items-center gap-1 rounded border border-zinc-700 bg-zinc-900/90 px-1.5 py-0.5 text-[11px] text-zinc-300 shadow-lg backdrop-blur"
            >
              <button onClick={addTableRow} className="rounded px-1 py-0.5 hover:bg-zinc-800" title="在下方增加一行">
                + 行
              </button>
              <button onClick={removeTableRow} className="rounded px-1 py-0.5 hover:bg-zinc-800 text-amber-400" title="删除行">
                - 行
              </button>
              <button onClick={addTableCol} className="rounded px-1 py-0.5 hover:bg-zinc-800" title="在右侧增加一列">
                + 列
              </button>
              <button onClick={removeTableCol} className="rounded px-1 py-0.5 hover:bg-zinc-800 text-amber-400" title="删除列">
                - 列
              </button>
              <button onClick={openResizePopover} className="rounded px-1.5 py-0.5 hover:bg-zinc-800 text-sky-400 font-medium" title="精确设置表格行数和列数">
                设置行列
              </button>
              <button onClick={deleteEntireTable} className="rounded px-1 py-0.5 hover:bg-zinc-800 text-red-400" title="删除整个表格">
                删除
              </button>

              {/* 表格尺寸设置弹出框 */}
              {tableResizeOpen && (
                <div
                  onMouseDown={(e) => e.stopPropagation()}
                  className="absolute right-0 top-full mt-1 z-50 flex flex-col gap-2 rounded border border-zinc-700 bg-zinc-950 p-2.5 shadow-2xl backdrop-blur-md"
                >
                  <p className="text-[11px] font-medium text-zinc-300">调整表格行列数：</p>
                  <div className="flex items-center gap-2">
                    <label className="text-[10px] text-zinc-400">行数：</label>
                    <input
                      type="number"
                      min={1}
                      max={50}
                      value={targetRows}
                      onChange={(e) => setTargetRows(Number(e.target.value))}
                      className="w-12 rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-center text-xs text-zinc-200 outline-none"
                    />
                    <label className="text-[10px] text-zinc-400">列数：</label>
                    <input
                      type="number"
                      min={1}
                      max={20}
                      value={targetCols}
                      onChange={(e) => setTargetCols(Number(e.target.value))}
                      className="w-12 rounded border border-zinc-700 bg-zinc-900 px-1 py-0.5 text-center text-xs text-zinc-200 outline-none"
                    />
                  </div>
                  <div className="flex justify-end gap-1.5 mt-1">
                    <button
                      onClick={() => setTableResizeOpen(false)}
                      className="rounded px-2 py-0.5 text-[11px] text-zinc-400 hover:bg-zinc-800"
                    >
                      取消
                    </button>
                    <button
                      onClick={applyTableResize}
                      className="rounded bg-sky-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-sky-500"
                    >
                      应用
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          <div
            ref={containerRef}
            contentEditable
            suppressContentEditableWarning
            onContextMenu={handleContextMenu}
            onInput={handleContentChange}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={() => {
              isComposingRef.current = false;
              handleContentChange();
            }}
            onMouseUp={saveSelection}
            onKeyUp={saveSelection}
            className="markdown-body mx-auto min-h-full max-w-4xl outline-none"
            style={{ caretColor: "#38bdf8" }}
          />
        </div>
      </div>

      {/* Typora 风格右键菜单 */}
      {contextMenu && (
        <MarkdownContextMenu
          contextMenu={contextMenu}
          hoverSubmenu={hoverSubmenu}
          onHoverSubmenu={setHoverSubmenu}
          onClose={() => setContextMenu(null)}
          onInsertHeading={insertHeading}
          onExecFormat={execFormat}
          onInsertInlineCode={() => insertHtmlAtCursor("<code>行内代码</code> ")}
          onOpenInsertTable={() => setTableModalOpen(true)}
          onInsertCodeBlock={insertCodeBlock}
          onInsertBlockquote={insertBlockquote}
          onInsertUnorderedList={insertUnorderedList}
          onInsertOrderedList={insertOrderedList}
          onInsertTaskItem={insertTaskItem}
          onInsertHorizontalRule={insertHorizontalRule}
          onAddTableRow={addTableRow}
          onRemoveTableRow={removeTableRow}
          onAddTableCol={addTableCol}
          onRemoveTableCol={removeTableCol}
          onDeleteEntireTable={deleteEntireTable}
        />
      )}

      {/* 插入表格弹窗（Modal） */}
      {tableModalOpen && (
        <TableInsertModal
          rows={modalRows}
          cols={modalCols}
          onRowsChange={setModalRows}
          onColsChange={setModalCols}
          onClose={() => setTableModalOpen(false)}
          onConfirm={() => insertCustomTable(modalRows, modalCols)}
        />
      )}
    </div>
  );
}
