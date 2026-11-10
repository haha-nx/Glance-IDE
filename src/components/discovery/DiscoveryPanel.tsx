import { useEffect, useRef, useState } from "react";
import {
  discoveryApi,
  type DiscoveryCandidate,
} from "../../services/discovery";
import { IconPlug, IconRefresh } from "../common/icons";

/**
 * 局域网发现面板（M5）：
 * - 网段三个框 + "1-254" + 22端口框，自动填入本机实际 IP
 * - 仅展示确认有 SSH 对应端口可以连接的 IP
 * - 紧凑单行展示设备：IP 与连接箭头图标按钮
 */
export function DiscoveryPanel() {
  const [octet1, setOctet1] = useState("192");
  const [octet2, setOctet2] = useState("168");
  const [octet3, setOctet3] = useState("1");
  const [port, setPort] = useState("22");

  const [scanning, setScanning] = useState(false);
  const [searched, setSearched] = useState(false);
  const [candidates, setCandidates] = useState<DiscoveryCandidate[]>([]);
  const [status, setStatus] = useState<string>("");
  const scanAbort = useRef(false);

  // 自动检测本机实际正在使用的物理 LAN IP 并填入前三段（排查过滤代理、VPN、虚拟机网卡）
  const loadLocalIp = async () => {
    try {
      const def = await discoveryApi.defaultRoute();
      const list = await discoveryApi.interfaces();

      // 1. 优先使用已过滤代理与虚拟网卡的物理默认路由 IP
      let chosenIp: string | null = def;

      // 2. 如果 defaultRoute 无法获取，优先选择非虚拟物理网卡
      if (!chosenIp) {
        const physical = list.find((i) => !i.isVirtual) || list[0];
        chosenIp = physical?.ipv4 ?? null;
      }

      if (chosenIp) {
        const parts = chosenIp.split(".");
        if (parts.length >= 3) {
          setOctet1(parts[0]);
          setOctet2(parts[1]);
          setOctet3(parts[2]);
        }
      }
    } catch (err) {
      console.warn("读取本机 IP 失败:", err);
    }
  };

  useEffect(() => {
    void loadLocalIp();
    return () => {
      scanAbort.current = true;
      void discoveryApi.cancel().catch(() => {});
    };
  }, []);

  function addCandidate(c: DiscoveryCandidate) {
    if (c.kind !== "ssh") return;

    setCandidates((prev) => {
      const key = `${c.ip}:${c.port}`;
      const exists = prev.find((p) => `${p.ip}:${p.port}` === key);
      if (exists) {
        return prev.map((p) =>
          `${p.ip}:${p.port}` === key
            ? {
                ...p,
                banner: c.banner ?? p.banner,
                hostname: c.hostname ?? p.hostname,
              }
            : p,
        );
      }
      return [...prev, c];
    });
  }

  const selectedCidr = `${octet1.trim() || "192"}.${octet2.trim() || "168"}.${octet3.trim() || "1"}.0/24`;

  async function startScan() {
    if (scanning) return;
    const targetPort = Number(port.trim()) || 22;

    setScanning(true);
    setSearched(true);
    scanAbort.current = false;
    setCandidates([]);
    setStatus(`正在扫描 ${selectedCidr}（端口 ${targetPort}）…`);

    try {
      await discoveryApi.scan(selectedCidr, [targetPort], addCandidate);
      setStatus(scanAbort.current ? "已取消" : "扫描完成");
    } catch (err) {
      setStatus(`扫描失败：${String(err)}`);
    } finally {
      setScanning(false);
    }
  }

  function cancelScan() {
    scanAbort.current = true;
    void discoveryApi.cancel();
    setStatus("已取消");
    setScanning(false);
  }

  function connectTo(c: DiscoveryCandidate) {
    window.dispatchEvent(
      new CustomEvent("glance:prefill-profile", {
        detail: { host: c.ip, port: c.port },
      }),
    );
    window.dispatchEvent(
      new CustomEvent("glance:activate-panel", { detail: "remote" }),
    );
  }

  const visibleCandidates = candidates.filter((c) => c.kind === "ssh");

  return (
    <div className="flex h-full flex-col bg-zinc-900 select-none">
      {/* 标题 */}
      <div className="flex h-9 shrink-0 items-center justify-between px-3 text-xs font-semibold uppercase tracking-wide text-zinc-400 border-b border-zinc-800">
        <span>IP 搜索与设备发现</span>
        <button
          title="刷新本机网段"
          onClick={() => void loadLocalIp()}
          className="text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          <IconRefresh size={14} />
        </button>
      </div>

      {/* 网段与端口输入区 */}
      <div className="space-y-2.5 border-b border-zinc-800 p-3">
        <div>
          <label className="text-[11px] text-zinc-400 mb-1.5 block">扫描网段与 SSH 端口：</label>
          <div className="flex items-center gap-1 font-mono text-xs text-zinc-300 w-full overflow-hidden">
            <input
              type="text"
              value={octet1}
              onChange={(e) => setOctet1(e.target.value)}
              className="w-9 shrink-0 rounded border border-zinc-700 bg-zinc-950 px-1 py-0.5 text-center outline-none focus:border-sky-500 text-xs"
            />
            <span className="text-zinc-500 font-bold">.</span>
            <input
              type="text"
              value={octet2}
              onChange={(e) => setOctet2(e.target.value)}
              className="w-9 shrink-0 rounded border border-zinc-700 bg-zinc-950 px-1 py-0.5 text-center outline-none focus:border-sky-500 text-xs"
            />
            <span className="text-zinc-500 font-bold">.</span>
            <input
              type="text"
              value={octet3}
              onChange={(e) => setOctet3(e.target.value)}
              className="w-9 shrink-0 rounded border border-zinc-700 bg-zinc-950 px-1 py-0.5 text-center outline-none focus:border-sky-500 text-xs"
            />
            <span className="text-zinc-500 font-bold">.</span>
            <span className="rounded bg-zinc-800/80 px-1 py-0.5 text-zinc-400 text-[11px] whitespace-nowrap shrink-0">
              1-254
            </span>
            <span className="text-zinc-500 font-bold">:</span>
            <input
              type="text"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder="22"
              className="w-11 shrink-0 rounded border border-zinc-700 bg-zinc-950 px-1 py-0.5 text-center outline-none focus:border-sky-500 text-xs"
            />
          </div>
        </div>

        <div className="flex items-center gap-2">
          {scanning ? (
            <button
              onClick={cancelScan}
              className="flex h-7 items-center justify-center rounded border border-zinc-700 bg-zinc-800 px-3 text-xs text-zinc-300 hover:bg-zinc-700 transition-colors"
            >
              取消扫描
            </button>
          ) : (
            <button
              onClick={() => void startScan()}
              disabled={scanning}
              className="flex h-7 items-center justify-center gap-1.5 rounded bg-sky-600 px-3 text-xs font-medium text-white hover:bg-sky-500 disabled:opacity-50 transition-colors leading-none"
            >
              <IconPlug size={12} className="shrink-0" />
              <span>开始扫描</span>
            </button>
          )}
        </div>

        {status && <p className="text-[11px] text-zinc-400 truncate">{status}</p>}
      </div>

      {/* 结果列表（仅显示单行 IP 与连接箭头图标按钮） */}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {visibleCandidates.length === 0 ? (
          <div className="px-2 py-4 text-center text-xs text-zinc-500">
            {scanning ? "正在检测可用 SSH 设备…" : searched ? "未发现确认可用的 SSH 设备" : "点击“开始扫描”搜索局域网 SSH 设备"}
          </div>
        ) : (
          visibleCandidates.map((c) => (
            <div
              key={`${c.ip}:${c.port}`}
              className="mb-1.5 flex h-8 items-center justify-between rounded-md border border-zinc-800 bg-zinc-950/70 px-2.5 transition-colors hover:border-zinc-700"
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 shrink-0" title="SSH 可用" />
                <span className="font-mono text-xs font-medium text-zinc-200 truncate">
                  {c.ip}:{c.port}
                </span>
              </div>
              <button
                onClick={() => connectTo(c)}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-zinc-700 bg-zinc-900 text-sky-400 hover:bg-sky-600 hover:text-white hover:border-sky-600 transition-colors"
                title="去连接该设备"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="12 5 19 12 12 19" />
                </svg>
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
