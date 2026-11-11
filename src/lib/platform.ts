/**
 * 运行平台判定：WKWebView 的 UA 固定包含 "Mac OS X"。
 * macOS 走原生窗口形态（系统菜单栏 + 原生红绿灯），且不提供 WSL 相关功能。
 */
export const IS_MAC =
  typeof navigator !== "undefined" && /Mac OS X|Macintosh/.test(navigator.userAgent);
