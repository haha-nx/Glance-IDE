import type { ReactNode } from "react";
import { tabsStore } from "../../stores/tabs";
import { tabDragStore, type TabDragState } from "../../stores/tabDrag";
import { IconClose, IconWarning } from "../../components/common/icons";

interface TabBarProps {
  /** 所属编辑器分组 */
  groupId: string;
  /** 右侧工具区（Diff / 拆分等） */
  actions?: ReactNode;
}

/** 根据指针位置计算拖放目标：标签栏（移动/重排）或编辑区（中心合并 / 四边拆分） */
function computeDropTarget(x: number, y: number): TabDragState["target"] {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  if (!el) return null;

  const bar = el.closest<HTMLElement>("[data-tabbar-group]");
  if (bar) {
    const groupId = bar.dataset.tabbarGroup!;
    const tabEls = Array.from(bar.querySelectorAll<HTMLElement>("[data-tab-uri]"));
    let index = tabEls.length;
    for (let i = 0; i < tabEls.length; i++) {
      const r = tabEls[i].getBoundingClientRect();
      if (x < r.left + r.width / 2) {
        index = i;
        break;
      }
    }
    return { groupId, zone: "tabbar", index };
  }

  const body = el.closest<HTMLElement>("[data-group-body]");
  if (body) {
    const groupId = body.dataset.groupBody!;
    const r = body.getBoundingClientRect();
    const fx = (x - r.left) / r.width;
    const fy = (y - r.top) / r.height;
    const edges: Array<["left" | "right" | "top" | "bottom", number]> = [
      ["left", fx],
      ["right", 1 - fx],
      ["top", fy],
      ["bottom", 1 - fy],
    ];
    edges.sort((a, b) => a[1] - b[1]);
    const [side, dist] = edges[0];
    return { groupId, zone: dist < 0.3 ? side : "center" };
  }
  return null;
}

/** 标签按下：立即激活；移动超过阈值后进入拖拽，松开时按目标执行移动/拆分 */
function onTabPointerDown(e: React.PointerEvent, uri: string, groupId: string, label: string) {
  if (e.button !== 0) return;
  tabsStore.getState().activateInGroup(groupId, uri);

  const sx = e.clientX;
  const sy = e.clientY;
  let dragging = false;

  const move = (ev: PointerEvent) => {
    if (!dragging) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
      dragging = true;
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
    }
    tabDragStore.getState().setDrag({ uri, fromGroupId: groupId, label, x: ev.clientX, y: ev.clientY });
    tabDragStore.getState().setTarget(computeDropTarget(ev.clientX, ev.clientY));
  };

  const finish = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", finish);
    if (!dragging) return;
    document.body.style.cursor = "";
    document.body.style.userSelect = "";

    const target = tabDragStore.getState().target;
    tabDragStore.getState().setDrag(null);
    tabDragStore.getState().setTarget(null);
    if (!target) return;

    const store = tabsStore.getState();
    if (target.zone === "tabbar") {
      store.moveTab(uri, groupId, target.groupId, target.index);
    } else if (target.zone === "center") {
      if (target.groupId !== groupId) store.moveTab(uri, groupId, target.groupId);
    } else {
      store.splitTab(uri, groupId, target.groupId, target.zone);
    }
  };

  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", finish);
  window.addEventListener("pointercancel", finish);
}

export function TabBar({ groupId, actions }: TabBarProps) {
  const allTabs = tabsStore((s) => s.tabs);
  const group = tabsStore((s) => s.groups[groupId]);
  const isActiveGroup = tabsStore((s) => s.activeGroupId === groupId);
  const closeInGroup = tabsStore((s) => s.closeInGroup);
  const dropTarget = tabDragStore((s) => (s.target?.groupId === groupId && s.target.zone === "tabbar" ? s.target : null));

  const tabs = (group?.tabUris ?? [])
    .map((uri) => allTabs.find((t) => t.uri === uri))
    .filter((t): t is NonNullable<typeof t> => !!t);

  return (
    <div className={`flex h-9 shrink-0 items-stretch border-b border-zinc-800 ${isActiveGroup ? "bg-zinc-950" : "bg-[var(--glance-bg-inactive)]"}`}>
      <div
        data-tabbar-group={groupId}
        className={`flex min-w-0 flex-1 items-stretch overflow-x-auto ${dropTarget ? "bg-sky-500/10" : ""}`}
      >
        {tabs.map((tab, i) => {
          const isActive = group?.activeUri === tab.uri;
          const indicator =
            dropTarget && dropTarget.index === i
              ? "shadow-[inset_2px_0_0_#38bdf8]"
              : dropTarget && dropTarget.index === tabs.length && i === tabs.length - 1
                ? "shadow-[inset_-2px_0_0_#38bdf8]"
                : "";
          return (
            <div
              key={tab.uri}
              data-tab-uri={tab.uri}
              onPointerDown={(e) => onTabPointerDown(e, tab.uri, groupId, tab.name)}
              onAuxClick={(e) => {
                if (e.button === 1) closeInGroup(groupId, tab.uri);
              }}
              title={tab.path}
              className={`group relative flex min-w-28 max-w-64 shrink-0 cursor-pointer items-center gap-1.5 border-r border-zinc-800 px-3 text-[13px] ${indicator} ${
                isActive
                  ? `bg-zinc-900 ${isActiveGroup ? "text-zinc-100" : "text-zinc-400"}`
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {isActive && isActiveGroup && <span className="absolute inset-x-0 top-0 h-px bg-sky-500" />}
              {tab.error ? (
                <span className="text-red-400">
                  <IconWarning size={14} />
                </span>
              ) : tab.diff ? (
                <span className="shrink-0 font-mono text-[11px] text-sky-400" title="文件对比">
                  ⇄
                </span>
              ) : (
                <span className={`h-2 w-2 shrink-0 rounded-full ${tab.dirty ? "bg-amber-400" : "bg-transparent"}`} />
              )}
              <span className="truncate">{tab.name}</span>
              <button
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  closeInGroup(groupId, tab.uri);
                }}
                className={`ml-auto rounded px-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 ${
                  isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                }`}
                title="关闭"
              >
                <IconClose size={12} />
              </button>
            </div>
          );
        })}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1 border-l border-zinc-800 px-2">{actions}</div>}
    </div>
  );
}
