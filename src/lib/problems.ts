/**
 * Problem Matcher（M4 任务 4.4）：GCC/Clang 与 Python 风格错误输出 → Problem 对象。
 * 输入为 ANSI 转义剥离后的多行文本。
 */

export interface Problem {
  file: string;
  line: number;
  col: number;
  severity: "error" | "warning" | "note";
  message: string;
  /** 原始行（保留现场，路径无法解析时不丢日志 ） */
  raw: string;
}

const ANSI_RE = /\x1B\[[0-9;]*[A-Za-z]/g;

// gcc/clang: path:line:col: severity: message
const GCC_RE = /^(.+?):(\d+):(\d+):\s*(fatal error|error|warning|note):\s*(.*)$/;
// python: File "path", line N
const PY_RE = /^\s*File "(.+?)", line (\d+)/;
// python 下一行缩进 + Error 类型: 消息
const PY_MSG_RE = /^\s*(\w*(?:Error|Exception|Warning))(?::\s?(.*))?$/;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

export function parseProblems(text: string): Problem[] {
  const clean = stripAnsi(text);
  const lines = clean.split(/\r?\n/);
  const problems: Problem[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const gcc = GCC_RE.exec(line);
    if (gcc) {
      problems.push({
        file: gcc[1],
        line: Number(gcc[2]),
        col: Number(gcc[3]),
        severity: gcc[4].includes("error")
          ? "error"
          : gcc[4] === "warning"
            ? "warning"
            : "note",
        message: gcc[5],
        raw: line,
      });
      continue;
    }
    const py = PY_RE.exec(line);
    if (py) {
      // 下一行匹配 Python 错误类型时才成对收集
      const next = lines[i + 1];
      if (next) {
        const msg = PY_MSG_RE.exec(next);
        if (msg) {
          problems.push({
            file: py[1],
            line: Number(py[2]),
            col: 1,
            severity: "error",
            message: `${msg[1]}: ${msg[2] ?? ""}`.trim(),
            raw: `${line}\n${next}`,
          });
        }
      }
    }
  }
  return problems;
}

/** 相对路径 → 绝对（结合任务 cwd） */
export function resolveProblemPath(problem: Problem, cwd: string): string {
  const file = problem.file;
  if (file.startsWith("/") || /^[A-Za-z]:[\\/]/.test(file)) {
    return file;
  }
  if (!cwd) return file;
  return `${cwd.replace(/\/+$/, "")}/${file}`;
}
