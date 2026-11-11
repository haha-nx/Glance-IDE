import { useEffect } from "react";

/**
 * 全局说明气泡（Tooltip）。
 *
 * 为什么不用原生 `title`：原生 title 的显示延迟由操作系统/浏览器控制（macOS WKWebView
 * 通常要 1–2 秒甚至更久），无法配置，表现为「鼠标放上去半天才出提示」。
 *
 * 这里的做法：
 * - 把现有 `title` 统一迁移到 `data-tooltip`（同时补 `aria-label`，保留无障碍语义）
 * - 自己画气泡，悬停 250ms 后出现，移出立即消失，并自动贴边翻转
 * - MutationObserver 兜底后续动态出现的 title
 */
const SHOW_DELAY = 250;
const GAP = 6;
const EDGE = 8;

export function TooltipLayer() {
  useEffect(() => {
    const bubble = document.createElement("div");
    bubble.className = "glance-tooltip";
    document.body.appendChild(bubble);

    let timer: number | null = null;
    let current: HTMLElement | null = null;

    const hide = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      current = null;
      bubble.style.display = "none";
    };

    const place = (el: HTMLElement) => {
      const text = el.getAttribute("data-tooltip");
      if (!text) return;
      bubble.textContent = text;
      bubble.style.display = "block";
      bubble.style.visibility = "hidden";

      const rect = el.getBoundingClientRect();
      const bw = bubble.offsetWidth;
      const bh = bubble.offsetHeight;
      // 侧边栏主按钮放右侧；面板内子按钮默认放下方
      const side = el.getAttribute("data-tooltip-side") ?? "bottom";

      let left: number;
      let top: number;
      if (side === "right") {
        left = rect.right + GAP;
        top = rect.top + rect.height / 2 - bh / 2;
        top = Math.max(EDGE, Math.min(top, window.innerHeight - bh - EDGE));
        // 右侧空间不足时回退到下方
        if (left + bw > window.innerWidth - EDGE) {
          left = Math.max(EDGE, Math.min(rect.left + rect.width / 2 - bw / 2, window.innerWidth - bw - EDGE));
          top = rect.bottom + GAP;
          if (top + bh > window.innerHeight - EDGE) top = Math.max(EDGE, rect.top - bh - GAP);
        }
      } else {
        left = rect.left + rect.width / 2 - bw / 2;
        left = Math.max(EDGE, Math.min(left, window.innerWidth - bw - EDGE));
        top = rect.bottom + GAP;
        if (top + bh > window.innerHeight - EDGE) top = Math.max(EDGE, rect.top - bh - GAP);
      }

      bubble.style.left = `${Math.round(left)}px`;
      bubble.style.top = `${Math.round(top)}px`;
      bubble.style.visibility = "visible";
    };

    const schedule = (el: HTMLElement, immediate = false) => {
      if (current === el) return;
      hide();
      current = el;
      if (immediate) {
        place(el);
        return;
      }
      timer = window.setTimeout(() => {
        timer = null;
        if (current === el && el.isConnected) place(el);
      }, SHOW_DELAY);
    };

    const onOver = (e: MouseEvent) => {
      const target = e.target as Element | null;
      const el = target?.closest?.("[data-tooltip]") as HTMLElement | null;
      if (el) schedule(el);
    };

    const onOut = (e: MouseEvent) => {
      if (!current) return;
      const to = e.relatedTarget as Node | null;
      if (to && current.contains(to)) return;
      hide();
    };

    const convert = (root: ParentNode) => {
      const nodes: Element[] = [];
      if (root instanceof Element && root.hasAttribute("title")) nodes.push(root);
      root.querySelectorAll?.("[title]").forEach((el) => nodes.push(el));
      for (const el of nodes) {
        if (!(el instanceof HTMLElement)) continue;
        const title = el.getAttribute("title");
        if (!title) continue;
        el.setAttribute("data-tooltip", title);
        el.removeAttribute("title");
        if (!el.hasAttribute("aria-label")) el.setAttribute("aria-label", title);
      }
    };

    convert(document);

    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes" && record.attributeName === "title") {
          convert(record.target as Element);
        } else if (record.type === "childList") {
          record.addedNodes.forEach((node) => {
            if (node instanceof Element) convert(node);
          });
        }
      }
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["title"],
    });

    document.addEventListener("mouseover", onOver, true);
    document.addEventListener("mouseout", onOut, true);
    const onFocusIn = (e: FocusEvent) => {
      const el = (e.target as Element | null)?.closest?.("[data-tooltip]") as HTMLElement | null;
      if (el) schedule(el, true);
    };
    document.addEventListener("mousedown", hide, true);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", hide);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);

    return () => {
      observer.disconnect();
      document.removeEventListener("mouseover", onOver, true);
      document.removeEventListener("mouseout", onOut, true);
      document.removeEventListener("mousedown", hide, true);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", hide);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
      bubble.remove();
    };
  }, []);

  return null;
}
