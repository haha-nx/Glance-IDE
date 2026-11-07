import { useEffect, useRef, useState } from "react";
import {
  discoveryApi,
  type DiscoveryCandidate,
  type InterfaceInfo,
} from "../../services/discovery";
import { Button, PrimaryButton } from "../common/Modal";
import { IconPlug, IconRefresh } from "../common/icons";

/**
 * 局域网发现面板（M5，§8）：
 * - 默认仅建议当前网卡 /24，用户确认后才开始（§8.3）
 * - 候选 = Endpoint Candidate 而非设备身份（§8.4）；连接才触发 Host Key 流程
 */
export function DiscoveryPanel() {
  const [interfaces, setInterfaces] = useState<InterfaceInfo[]>([]);
  const [selectedCidr, setSelectedCidr] = useState<string>("");
  const [ports, setPorts] = useState("22");
  const [scanning, setScanning] = useState(false);
  const [searched, setSearched] = useState(false);
  const [mdnsOn, setMdnsOn] = useState(false);
  const [candidates, setCandidates] = useState<DiscoveryCandidate[]>([]);
  const [status, setStatus] = useState<string>("");
  const scanAbort = useRef(false);

  useEffect(() => {
    void (async () => {
      try {
        const list = await discoveryApi.interfaces();
        setInterfaces(list);
        const def = await discoveryApi.defaultRoute();
        const preferred = list.find((i) => i.ipv4 === def) ?? list[0];
        if (preferred) setSelectedCidr(preferred.suggestedCidr);
      } catch (err) {
        setStatus(String(err));
      }
    })();
    return () => {
      scanAbort.current = true;
      void discoveryApi.cancel().catch(() => {});
      void discoveryApi.mdnsCancel().catch(() => {});
    };
  }, []);

  function addCandidate(c: DiscoveryCandidate) {
    setCandidates((prev) => {
      const key = `${c.ip}:${c.port}`;
      const exists = prev.find((p) => `${p.ip}:${p.port}` === key);
      if (exists) {
        // 升级信息（如 mDNS 主机名 / SSH banner）
        return prev.map((p) =>
          `${p.ip}:${p.port}` === key
            ? {
                ...p,
                kind: c.kind === "ssh" || p.kind === "ssh" ? "ssh" : c.kind,
                banner: c.banner ?? p.banner,
                hostname: c.hostname ?? p.hostname,
              }
            : p,
        );
      }
      return [...prev, c];
    });
  }

  async function startScan() {
    if (scanning || !selectedCidr) return;
    const portList = ports
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
    if (portList.length === 0) {
      setStatus("端口列表无效");
      return;
    }
    setScanning(true);
    scanAbort.current = false;
    setStatus(`正在扫描 ${selectedCidr}（端口 ${portList.join(", ")}）…`);
    try {
      const count = await discoveryApi.scan(selectedCidr, portList, addCandidate);
      setSearched(true);
      setStatus(scanAbort.current ? "已取消" : `扫描完成，发现 ${count} 个候选`);
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

  function toggleMdns() {
    if (mdnsOn) {
      void discoveryApi.mdnsCancel();
      setMdnsOn(false);
    } else {
      setMdnsOn(true);
      void discoveryApi.mdnsStart(addCandidate).catch(() => setMdnsOn(false));
    }
  }

  function connectTo(c: DiscoveryCandidate) {
    // 候选只是端点：跳转远程面板，预填新建连接对话框（身份仍走 Host Key 流程 §8.4）
    window.dispatchEvent(
      new CustomEvent("glance:prefill-profile", {
        detail: { host: c.ip, port: c.port },
      }),
    );
    window.dispatchEvent(
      new CustomEvent("glance:activate-panel", { detail: "ssh" }),
    );
  }

  function kindBadge(c: DiscoveryCandidate) {
    if (c.kind === "ssh")
      return <span className="rounded bg-emerald-900/60 px-1.5 py-0.5 text-[10px] text-emerald-400">SSH 已确认</span>;
    if (c.kind === "open")
      return <span className="rounded bg-amber-900/60 px-1.5 py-0.5 text-[10px] text-amber-400">端口开放·未确认</span>;
    return <span className="rounded bg-sky-900/60 px-1.5 py-0.5 text-[10px] text-sky-400">mDNS</span>;
  }

  return (
    <div className="flex h-full flex-col bg-zinc-900">
      <div className="flex h-9 shrink-0 items-center justify-between px-3 text-xs font-semibold uppercase tracking-wide text-zinc-400">
        <span>局域网发现</span>
        <button
          title="刷新网卡"
          onClick={() => void discoveryApi.interfaces().then(setInterfaces)}
          className="text-zinc-500 hover:text-zinc-300"
        >
          <IconRefresh size={14} />
        </button>
      </div>

      <div className="space-y-2 border-b border-zinc-800 px-3 pb-3">
        <p className="text-[11px] leading-relaxed text-zinc-500">
          扫描仅探测端口开放性并读取 SSH 横幅，<span className="text-zinc-300">不尝试登录、不建立信任</span>。
          更大网段请显式输入 CIDR 并确认你有该网络的扫描授权。
        </p>
        {interfaces.length === 0 ? (
          <p className="text-xs text-zinc-600">未检测到可用 IPv4 网卡</p>
        ) : (
          <div className="space-y-1">
            {interfaces.map((iface) => (
              <label
                key={`${iface.name}-${iface.ipv4}`}
                className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-zinc-800"
              >
                <input
                  type="radio"
                  name="cidr"
                  checked={selectedCidr === iface.suggestedCidr}
                  onChange={() => setSelectedCidr(iface.suggestedCidr)}
                  className="accent-sky-600"
                />
                <span className="text-zinc-300">{iface.ipv4}</span>
                <span className="truncate text-zinc-600" title={iface.name}>
                  {iface.name}
                </span>
                <span className="ml-auto font-mono text-[10px] text-zinc-600">{iface.suggestedCidr}</span>
              </label>
            ))}
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <input
            value={selectedCidr}
            onChange={(e) => setSelectedCidr(e.target.value)}
            placeholder="CIDR（如 192.168.1.0/24）"
            className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-xs text-zinc-200 outline-none focus:border-sky-600"
          />
          <input
            value={ports}
            onChange={(e) => setPorts(e.target.value)}
            placeholder="端口"
            className="w-16 rounded border border-zinc-700 bg-zinc-950 px-2 py-1 font-mono text-xs text-zinc-200 outline-none focus:border-sky-600"
          />
        </div>
        <div className="flex gap-1.5">
          {scanning ? (
            <Button onClick={cancelScan}>取消扫描</Button>
          ) : (
            <PrimaryButton onClick={() => void startScan()} disabled={!selectedCidr}>
              <span className="inline-flex items-center gap-1">
                <IconPlug size={12} /> 开始扫描
              </span>
            </PrimaryButton>
          )}
          <Button onClick={toggleMdns} className={mdnsOn ? "bg-sky-900/60 text-sky-300" : ""}>
            {mdnsOn ? "mDNS 监听中" : "mDNS 发现"}
          </Button>
        </div>
        {status && <p className="text-[11px] text-zinc-500">{status}</p>}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {candidates.length === 0 ? (
          <div className="px-1 py-1 text-xs text-zinc-600">
            <p>暂无候选设备</p>
            {searched && !scanning && (
              <p className="mt-2 rounded border border-amber-900/50 bg-amber-950/30 p-2 text-[11px] leading-relaxed text-amber-400">
                扫描完成但无结果？macOS 本地网络权限可能未授予：
                <br />
                系统设置 → 隐私与安全性 → 本地网络 → 允许 Glance IDE，然后重新扫描。
              </p>
            )}
          </div>
        ) : (
          candidates.map((c) => (
            <div
              key={`${c.ip}:${c.port}:${c.source}`}
              className="mb-1.5 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2"
            >
              <div className="flex items-center justify-between">
                <span className="font-mono text-sm text-zinc-200">
                  {c.ip}:{c.port}
                </span>
                {kindBadge(c)}
              </div>
              <div className="mt-1 flex items-center justify-between">
                <span className="truncate text-[11px] text-zinc-500">
                  {c.hostname && <span className="mr-2">{c.hostname}</span>}
                  {c.banner && <span className="font-mono">{c.banner}</span>}
                  <span className="ml-2 text-zinc-700">via {c.source}</span>
                </span>
                <button
                  onClick={() => connectTo(c)}
                  className="rounded px-1.5 py-0.5 text-xs text-sky-400 hover:bg-sky-950 hover:text-sky-300"
                >
                  新建连接 →
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
