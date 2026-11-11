import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, errorInfo: null };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("ErrorBoundary 捕获异常:", error, errorInfo);
    this.setState({ error, errorInfo });
  }

  handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen w-screen flex-col items-center justify-center bg-[var(--glance-bg)] p-8 text-zinc-300 select-text">
          <div className="flex max-w-xl flex-col items-center rounded-xl border border-red-800/60 bg-zinc-900/90 p-6 shadow-2xl backdrop-blur-md">
            <div className="mb-4 rounded-full bg-red-950/80 p-3 text-red-400 border border-red-700/50">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            </div>
            <h2 className="text-base font-semibold text-zinc-100">Glance IDE 渲染遇到异常</h2>
            <p className="mt-2 text-center text-xs text-zinc-400">
              界面组件在渲染过程中发生错误，已安全隔离以防止进程崩溃。
            </p>
            <div className="mt-4 max-h-48 w-full overflow-y-auto rounded border border-zinc-800 bg-zinc-950 p-3 font-mono text-[11px] text-red-400/90 break-all">
              {this.state.error?.message || String(this.state.error)}
              {this.state.errorInfo?.componentStack && (
                <div className="mt-2 text-zinc-500 whitespace-pre-wrap">
                  {this.state.errorInfo.componentStack}
                </div>
              )}
            </div>
            <div className="mt-6 flex gap-3">
              <button
                onClick={this.handleReload}
                className="rounded bg-sky-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-sky-500 transition-colors"
              >
                刷新工作台
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
