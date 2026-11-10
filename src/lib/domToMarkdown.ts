/**
 * 轻量且规范的 DOM 节点转 Markdown 序列化工具。
 * 配合 contenteditable 实现所见即所得编辑的双向同步。
 */

export function domToMarkdown(root: HTMLElement): string {
  const lines: string[] = [];
  serializeChildren(root, lines);
  return lines.join("").trim() + "\n";
}

function serializeChildren(node: Node, out: string[]) {
  for (let i = 0; i < node.childNodes.length; i++) {
    serializeNode(node.childNodes[i], out);
  }
}

function serializeNode(node: Node, out: string[]) {
  if (node.nodeType === Node.TEXT_NODE) {
    out.push(node.textContent || "");
    return;
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return;

  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();

  switch (tag) {
    case "h1":
      out.push("\n# ");
      serializeChildren(el, out);
      out.push("\n\n");
      break;
    case "h2":
      out.push("\n## ");
      serializeChildren(el, out);
      out.push("\n\n");
      break;
    case "h3":
      out.push("\n### ");
      serializeChildren(el, out);
      out.push("\n\n");
      break;
    case "h4":
      out.push("\n#### ");
      serializeChildren(el, out);
      out.push("\n\n");
      break;
    case "h5":
      out.push("\n##### ");
      serializeChildren(el, out);
      out.push("\n\n");
      break;
    case "h6":
      out.push("\n###### ");
      serializeChildren(el, out);
      out.push("\n\n");
      break;
    case "p":
      out.push("\n");
      serializeChildren(el, out);
      out.push("\n\n");
      break;
    case "br":
      out.push("\n");
      break;
    case "strong":
    case "b":
      out.push("**");
      serializeChildren(el, out);
      out.push("**");
      break;
    case "em":
    case "i":
      out.push("*");
      serializeChildren(el, out);
      out.push("*");
      break;
    case "del":
    case "s":
    case "strike":
      out.push("~~");
      serializeChildren(el, out);
      out.push("~~");
      break;
    case "code":
      // 如果处于 pre 内部则由 pre 处理，否则为行内代码
      if (el.parentElement?.tagName.toLowerCase() === "pre") {
        serializeChildren(el, out);
      } else {
        out.push("`");
        serializeChildren(el, out);
        out.push("`");
      }
      break;
    case "pre": {
      const codeEl = el.querySelector("code");
      const langClass = codeEl?.className.match(/language-(\w+)/);
      const lang = langClass ? langClass[1] : "";
      const text = (codeEl || el).textContent || "";
      out.push(`\n\`\`\`${lang}\n${text.replace(/\n$/, "")}\n\`\`\`\n\n`);
      break;
    }
    case "blockquote": {
      const inner: string[] = [];
      serializeChildren(el, inner);
      const text = inner.join("").trim();
      const blockText = text
        .split("\n")
        .map((l) => (l.trim() ? `> ${l}` : ">"))
        .join("\n");
      out.push(`\n${blockText}\n\n`);
      break;
    }
    case "ul": {
      out.push("\n");
      for (let i = 0; i < el.children.length; i++) {
        const li = el.children[i] as HTMLElement;
        if (li.tagName.toLowerCase() === "li") {
          serializeListItem(li, "-", out);
        }
      }
      out.push("\n");
      break;
    }
    case "ol": {
      out.push("\n");
      let count = 1;
      for (let i = 0; i < el.children.length; i++) {
        const li = el.children[i] as HTMLElement;
        if (li.tagName.toLowerCase() === "li") {
          serializeListItem(li, `${count}.`, out);
          count++;
        }
      }
      out.push("\n");
      break;
    }
    case "hr":
      out.push("\n---\n\n");
      break;
    case "a": {
      const href = el.getAttribute("href") || "";
      out.push("[");
      serializeChildren(el, out);
      out.push(`](${href})`);
      break;
    }
    case "img": {
      const src = el.getAttribute("src") || "";
      const alt = el.getAttribute("alt") || "";
      out.push(`![${alt}](${src})`);
      break;
    }
    case "table": {
      out.push("\n" + serializeTable(el) + "\n\n");
      break;
    }
    case "input": {
      if (el.getAttribute("type") === "checkbox" && !el.closest("li")) {
        const checked = (el as HTMLInputElement).checked;
        out.push(checked ? "[x] " : "[ ] ");
      }
      break;
    }
    default:
      serializeChildren(el, out);
      break;
  }
}

function serializeListItem(li: HTMLElement, prefix: string, out: string[]) {
  const checkbox = li.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
  const itemOut: string[] = [];

  for (let i = 0; i < li.childNodes.length; i++) {
    const child = li.childNodes[i];
    if (
      child.nodeType === Node.ELEMENT_NODE &&
      (child as HTMLElement).tagName.toLowerCase() === "input"
    ) {
      continue;
    }
    serializeNode(child, itemOut);
  }

  const text = itemOut.join("").trim();
  if (checkbox) {
    const state = checkbox.checked ? "[x]" : "[ ]";
    out.push(`- ${state} ${text}\n`);
  } else {
    out.push(`${prefix} ${text}\n`);
  }
}

function serializeTableCell(cell: HTMLElement): string {
  const cellOut: string[] = [];
  serializeChildren(cell, cellOut);
  return cellOut.join("").trim().replace(/\|/g, "\\|").replace(/\n+/g, " ");
}

function serializeTable(table: HTMLElement): string {
  const rows = Array.from(table.querySelectorAll("tr"));
  if (rows.length === 0) return "";

  const grid: string[][] = [];
  rows.forEach((row) => {
    const cells = Array.from(row.querySelectorAll("th, td")).map((c) =>
      serializeTableCell(c as HTMLElement),
    );
    if (cells.length > 0) grid.push(cells);
  });

  if (grid.length === 0) return "";

  const colCount = Math.max(...grid.map((r) => r.length));
  const normalized = grid.map((r) => {
    const copy = [...r];
    while (copy.length < colCount) copy.push("");
    return copy;
  });

  const header = normalized[0];
  const sep = new Array(colCount).fill("---");
  const dataRows = normalized.slice(1);

  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${sep.join(" | ")} |`,
    ...dataRows.map((r) => `| ${r.join(" | ")} |`),
  ];

  return lines.join("\n");
}
