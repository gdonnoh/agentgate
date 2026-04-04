import { useState, useEffect, useCallback } from "react";
import { createPublicClient, http, keccak256, toHex, toBytes, recoverMessageAddress } from "viem";
import { hederaTestnet, NetworkId, NETWORKS, DEPLOYMENTS } from "../lib/chains";
import { REGISTRY_ABI } from "../lib/abi";
import { useWallet } from "../hooks/useWallet";

// ── ABIs ────────────────────────────────────────────────────────────────────

const PAYMASTER_READ_ABI = [
  {
    name: "endpointBalance",
    type: "function",
    inputs: [{ name: "hash", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    name: "endpointGasShareBps",
    type: "function",
    inputs: [{ name: "hash", type: "bytes32" }],
    outputs: [{ name: "", type: "uint16" }],
    stateMutability: "view",
  },
  {
    name: "endpointOwner",
    type: "function",
    inputs: [{ name: "hash", type: "bytes32" }],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
] as const;

const PAYMASTER_WRITE_ABI = [
  {
    name: "fundAndSetGasShare",
    type: "function",
    inputs: [
      { name: "url", type: "string" },
      { name: "bps", type: "uint16" },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    name: "setGasShare",
    type: "function",
    inputs: [
      { name: "url", type: "string" },
      { name: "bps", type: "uint16" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

// ── Types ────────────────────────────────────────────────────────────────────

interface EndpointInfo {
  balance: bigint;
  bps: number;
  owner: `0x${string}`;
}

interface MyEndpoint {
  id: number;
  url: string;
  pricePerCall: string;   // formatted USD
  active: boolean;
  totalCalls: number;
  totalRevenue: string;   // formatted USD
  registeredAt: Date;
  gasBudget: bigint;      // wei from paymaster
  gasSharePct: number;    // 0–100
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function endpointHash(url: string): `0x${string}` {
  return keccak256(toHex(toBytes(url)));
}

function formatNative(wei: bigint, decimals = 6): string {
  const d = 10n ** 18n;
  const whole = wei / d;
  const frac  = ((wei % d) * 10n ** BigInt(decimals)) / d;
  return `${whole}.${frac.toString().padStart(decimals, "0")}`;
}

const inputStyle: React.CSSProperties = {
  background: "#0d0d0d", border: "1px solid #252525", borderRadius: 6,
  color: "#e5e7eb", fontFamily: "'JetBrains Mono', monospace", fontSize: 12,
  padding: "9px 12px", outline: "none", width: "100%",
  boxSizing: "border-box", transition: "border-color 0.2s",
};

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <label style={{ fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: "0.08em" }}>
          {label}
        </label>
        {hint && <span style={{ fontSize: 10, color: "#444" }}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

// ── Component ────────────────────────────────────────────────────────────────
export function ManageEndpoint(_props: { networkId: NetworkId }) {
  const wallet = useWallet();

  const [selectedNet] = useState<NetworkId>("hedera");
  const [url,         setUrl]         = useState("");

  // My Endpoints
  const [myEndpoints,     setMyEndpoints]     = useState<MyEndpoint[]>([]);
  const [myEndpointsLoading, setMyEndpointsLoading] = useState(false);

  // Look-up state
  const [looking,     setLooking]     = useState(false);
  const [lookError,   setLookError]   = useState<string | null>(null);
  const [info,        setInfo]        = useState<EndpointInfo | null>(null);

  // Top-up form
  const [topUpAmt,    setTopUpAmt]    = useState("0.001");
  const [newBps,      setNewBps]      = useState(10000);
  const [saving,      setSaving]      = useState(false);
  const [saveStep,    setSaveStep]    = useState("");
  const [saveError,   setSaveError]   = useState<string | null>(null);
  const [saveDone,    setSaveDone]    = useState<string | null>(null); // tx hash

  // Endpoint ID from registry (for proxy config)
  const [selectedEndpointId, setSelectedEndpointId] = useState<number | null>(null);

  // Proxy config
  const [proxyEnabled,    setProxyEnabled]    = useState(false);
  const [backendUrl,      setBackendUrl]      = useState("");
  const [headerRows,      setHeaderRows]      = useState<{ key: string; value: string }[]>([{ key: "", value: "" }]);
  const [proxySaving,     setProxySaving]     = useState(false);
  const [proxyDone,       setProxyDone]       = useState(false);
  const [proxyError,      setProxyError]      = useState<string | null>(null);

  // Active proxy state (fetched on lookup)
  const [activeProxy,     setActiveProxy]     = useState<{ backendUrl: string; headerKeys: string[]; proxyUrl: string } | null>(null);
  const [deactivating,    setDeactivating]    = useState(false);
  const [deactivateError, setDeactivateError] = useState<string | null>(null);

  const selectedNetData = NETWORKS[selectedNet];
  const paymasterAddr   = DEPLOYMENTS[selectedNet].paymaster;

  // ── Fetch all endpoints for connected wallet ──────────────────────────────

  const fetchMyEndpoints = useCallback(async (address: `0x${string}`) => {
    setMyEndpointsLoading(true);
    try {
      const chain        = hederaTestnet;
      const publicClient = createPublicClient({ chain, transport: http(NETWORKS["hedera"].rpc) });
      const d            = DEPLOYMENTS["hedera"];

      const ids = await publicClient.readContract({
        address: d.publisherRegistry,
        abi: REGISTRY_ABI,
        functionName: "getPublisherEndpoints",
        args: [address],
      }) as bigint[];

      const results = await Promise.all(ids.map(async (id) => {
        const ep = await publicClient.readContract({
          address: d.publisherRegistry,
          abi: REGISTRY_ABI,
          functionName: "endpoints",
          args: [id],
        }) as readonly [bigint, `0x${string}`, string, bigint, `0x${string}`, boolean, bigint, bigint, bigint];

        // Also read paymaster gas budget + share for this URL
        let gasBudget = 0n;
        let gasSharePct = 0;
        try {
          const urlHash = keccak256(toHex(toBytes(ep[2])));
          const [bal, bps] = await Promise.all([
            publicClient.readContract({
              address: d.paymaster,
              abi: PAYMASTER_READ_ABI,
              functionName: "endpointBalance",
              args: [urlHash],
            }) as Promise<bigint>,
            publicClient.readContract({
              address: d.paymaster,
              abi: PAYMASTER_READ_ABI,
              functionName: "endpointGasShareBps",
              args: [urlHash],
            }) as Promise<number>,
          ]);
          gasBudget    = bal;
          gasSharePct  = Math.round(Number(bps) / 100);
        } catch { /* paymaster data optional */ }

        return {
          id:           Number(ep[0]),
          url:          ep[2],
          pricePerCall: (Number(ep[3]) / 1_000_000).toFixed(4),
          active:       ep[5],
          totalCalls:   Number(ep[6]),
          totalRevenue: (Number(ep[7]) / 1_000_000).toFixed(4),
          registeredAt: new Date(Number(ep[8]) * 1000),
          gasBudget,
          gasSharePct,
        } as MyEndpoint;
      }));

      setMyEndpoints(results.filter((e) => e.url));
    } catch (e: any) {
      console.warn("[ManageEndpoint] fetchMyEndpoints failed:", e.message);
    } finally {
      setMyEndpointsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (wallet.state.connected && wallet.state.address) {
      fetchMyEndpoints(wallet.state.address);
    } else {
      setMyEndpoints([]);
    }
  }, [wallet.state.connected, wallet.state.address, fetchMyEndpoints]);

  // ── Look up on-chain data ──────────────────────────────────────────────────

  async function handleLookup() {
    const trimmed = url.trim();
    if (!trimmed) return;
    setLooking(true);
    setLookError(null);
    setInfo(null);
    setSaveDone(null);
    setSaveError(null);
    setSelectedEndpointId(null);
    setProxyEnabled(false);
    setProxyDone(false);
    setProxyError(null);
    setActiveProxy(null);
    setDeactivateError(null);

    try {
      const chain        = hederaTestnet;
      const publicClient = createPublicClient({ chain, transport: http(NETWORKS[selectedNet].rpc) });
      const hash         = endpointHash(trimmed);
      const d            = DEPLOYMENTS[selectedNet];

      const [balance, bps, owner] = await Promise.all([
        publicClient.readContract({ address: paymasterAddr, abi: PAYMASTER_READ_ABI, functionName: "endpointBalance", args: [hash] }),
        publicClient.readContract({ address: paymasterAddr, abi: PAYMASTER_READ_ABI, functionName: "endpointGasShareBps", args: [hash] }),
        publicClient.readContract({ address: paymasterAddr, abi: PAYMASTER_READ_ABI, functionName: "endpointOwner", args: [hash] }),
      ]);

      setInfo({ balance: balance as bigint, bps: Number(bps), owner: owner as `0x${string}` });
      setNewBps(Number(bps));

      // Find endpointId from registry by scanning
      try {
        const nextId = await publicClient.readContract({
          address: d.publisherRegistry,
          abi: REGISTRY_ABI,
          functionName: "nextEndpointId",
          args: [],
        }) as bigint;
        const total = Number(nextId);
        const ids   = Array.from({ length: Math.min(total, 200) }, (_, i) => BigInt(i));
        const eps   = await Promise.all(ids.map((id) =>
          publicClient.readContract({
            address: d.publisherRegistry,
            abi: REGISTRY_ABI,
            functionName: "endpoints",
            args: [id],
          }).catch(() => null)
        ));
        const match = eps.find((ep) => ep && (ep as any)[2] === trimmed);
        if (match) {
          const eid = Number((match as any)[0]);
          setSelectedEndpointId(eid);
          // Check if proxy is already active
          try {
            const SERVER = (import.meta as any).env?.VITE_SERVER_URL || "http://localhost:4021";
            const pr = await fetch(`${SERVER}/api/publisher/proxy-config/${eid}`);
            if (pr.ok) {
              const pd = await pr.json() as any;
              setActiveProxy({ backendUrl: pd.backendUrl, headerKeys: pd.headerKeys ?? [], proxyUrl: pd.proxyUrl });
            }
          } catch { /* proxy check optional */ }
        }
      } catch { /* endpoint ID optional */ }
    } catch (e: any) {
      setLookError(e.shortMessage || e.message || String(e));
    } finally {
      setLooking(false);
    }
  }

  // ── Proxy config ─────────────────────────────────────────────────────────────

  async function handleProxyConfig() {
    if (!wallet.state.connected || selectedEndpointId === null) return;
    const addr = wallet.state.address!;
    setProxySaving(true);
    setProxyError(null);
    setProxyDone(false);
    try {
      const timestamp = Date.now();
      const injectHeaders = Object.fromEntries(
        headerRows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value.trim()])
      );
      const message = `AgentGate proxy config\nendpointId:${selectedEndpointId}\nbackendUrl:${backendUrl}\ntimestamp:${timestamp}`;
      const signature = await (window as any).ethereum.request({
        method: "personal_sign",
        params: [message, addr],
      });

      // Verify locally before sending
      const recovered = await recoverMessageAddress({ message, signature });
      if (recovered.toLowerCase() !== addr.toLowerCase()) throw new Error("Signature mismatch");

      const res = await fetch("/api/publisher/proxy-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpointId: selectedEndpointId,
          backendUrl,
          injectHeaders,
          walletAddress: addr,
          signature,
          timestamp,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error((j as any).error || `HTTP ${res.status}`);
      }
      setProxyDone(true);
    } catch (e: any) {
      setProxyError(e.message || String(e));
    } finally {
      setProxySaving(false);
    }
  }

  // ── Deactivate proxy ─────────────────────────────────────────────────────

  async function handleDeactivateProxy() {
    if (!wallet.state.connected || selectedEndpointId === null) return;
    const addr = wallet.state.address!;
    setDeactivating(true);
    setDeactivateError(null);
    try {
      const timestamp = Date.now();
      const message   = `AgentGate deactivate proxy\nendpointId: ${selectedEndpointId}\ntimestamp: ${timestamp}`;
      const signature = await (window as any).ethereum.request({
        method: "personal_sign",
        params: [message, addr],
      });
      const SERVER = (import.meta as any).env?.VITE_SERVER_URL || "http://localhost:4021";
      const res = await fetch(`${SERVER}/api/publisher/proxy-config/${selectedEndpointId}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ walletAddress: addr, signature, timestamp }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error((j as any).error || `HTTP ${res.status}`);
      }
      setActiveProxy(null);
      setProxyDone(false);
    } catch (e: any) {
      setDeactivateError(e.message || String(e));
    } finally {
      setDeactivating(false);
    }
  }

  // ── Save changes ───────────────────────────────────────────────────────────

  async function handleSave(mode: "topup" | "shareOnly") {
    if (!wallet.state.connected) { await wallet.connect(); return; }
    if (wallet.state.chainId !== NETWORKS[selectedNet].chainId) {
      await wallet.switchNetwork(selectedNet); return;
    }
    setSaving(true);
    setSaveError(null);
    setSaveDone(null);

    try {
      let txHash: string;

      if (mode === "topup") {
        setSaveStep("Sending deposit + updating gas share…");
        const wei = BigInt(Math.round(parseFloat(topUpAmt) * 1e18));
        txHash = await wallet.writeContract(
          selectedNet, paymasterAddr, PAYMASTER_WRITE_ABI as any,
          "fundAndSetGasShare", [url.trim(), newBps], wei
        );
      } else {
        setSaveStep("Updating gas share percentage…");
        txHash = await wallet.writeContract(
          selectedNet, paymasterAddr, PAYMASTER_WRITE_ABI as any,
          "setGasShare", [url.trim(), newBps]
        );
      }

      setSaveDone(txHash);
      // Refresh on-chain data after short delay
      setTimeout(() => handleLookup(), 2000);
    } catch (e: any) {
      setSaveError(e.shortMessage || e.message || String(e));
    } finally {
      setSaving(false);
      setSaveStep("");
    }
  }

  const isOwner      = info && wallet.state.connected &&
    wallet.state.address?.toLowerCase() === info.owner.toLowerCase();
  const wrongNetwork = wallet.state.connected && wallet.state.chainId !== NETWORKS[selectedNet].chainId;
  const gasSharePct  = Math.round(newBps / 100);
  const topUpFloat   = parseFloat(topUpAmt) || 0;

  const totalRevenue = myEndpoints.reduce((s, e) => s + parseFloat(e.totalRevenue), 0);
  const totalCalls   = myEndpoints.reduce((s, e) => s + e.totalCalls, 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>

      {/* ── My Endpoints (wallet connected) ─────────────────────────────────── */}
      {!wallet.state.connected ? (
        <div style={{
          padding: "20px 16px", borderRadius: 8,
          background: "#080808", border: "1px solid #1a1a1a",
          display: "flex", flexDirection: "column", alignItems: "center", gap: 12,
        }}>
          <div style={{ fontSize: 13, color: "#555" }}>Connect your wallet to see your published endpoints</div>
          <button
            onClick={wallet.connect}
            style={{
              padding: "10px 24px", fontFamily: "'JetBrains Mono', monospace",
              fontSize: 12, fontWeight: 700, borderRadius: 6, cursor: "pointer",
              border: `1px solid ${selectedNetData.color}`,
              background: `${selectedNetData.color}22`, color: selectedNetData.color,
            }}
          >
            🔗 connect wallet
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {/* Header row */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#4ade80" }} />
              <span style={{ fontSize: 11, color: "#666", fontFamily: "'JetBrains Mono', monospace" }}>
                {wallet.state.address!.slice(0, 10)}…{wallet.state.address!.slice(-4)}
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {myEndpoints.length > 0 && (
                <span style={{ fontSize: 10, color: "#444" }}>
                  {myEndpoints.length} endpoint{myEndpoints.length !== 1 ? "s" : ""}
                </span>
              )}
              <button
                onClick={() => wallet.state.address && fetchMyEndpoints(wallet.state.address)}
                disabled={myEndpointsLoading}
                style={{
                  background: "none", border: "1px solid #222", color: "#444",
                  cursor: myEndpointsLoading ? "default" : "pointer",
                  fontSize: 12, padding: "3px 8px", borderRadius: 4,
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              >
                {myEndpointsLoading ? "…" : "↺"}
              </button>
              <button
                onClick={wallet.disconnect}
                style={{
                  background: "none", border: "none", color: "#333",
                  cursor: "pointer", fontSize: 10, padding: "2px 6px",
                }}
              >
                disconnect
              </button>
            </div>
          </div>

          {myEndpointsLoading && myEndpoints.length === 0 ? (
            <div style={{ fontSize: 11, color: "#444", padding: "14px 0", textAlign: "center" }}>
              fetching your endpoints…
            </div>
          ) : myEndpoints.length === 0 ? (
            <div style={{
              padding: "16px", borderRadius: 6, background: "#080808",
              border: "1px solid #151515", fontSize: 11, color: "#444", textAlign: "center",
            }}>
              No endpoints published yet — use the ➕ Publish tab to register one
            </div>
          ) : (
            <>
              {/* Summary row */}
              <div style={{
                display: "flex", gap: 0,
                background: "#080808", border: "1px solid #1a1a1a", borderRadius: 8, overflow: "hidden",
              }}>
                {[
                  ["Total Calls",    totalCalls.toString()],
                  ["Total Revenue",  `$${totalRevenue.toFixed(4)}`],
                  ["Endpoints",      myEndpoints.length.toString()],
                ].map(([label, value], i) => (
                  <div key={label} style={{
                    flex: 1, padding: "12px 14px",
                    borderRight: i < 2 ? "1px solid #1a1a1a" : "none",
                    display: "flex", flexDirection: "column", gap: 4,
                  }}>
                    <span style={{ fontSize: 9, color: "#444", textTransform: "uppercase", letterSpacing: "0.1em" }}>{label}</span>
                    <span style={{ fontSize: 15, fontWeight: 700, color: "#e5e7eb", fontFamily: "'JetBrains Mono', monospace" }}>{value}</span>
                  </div>
                ))}
              </div>

              {/* Endpoint cards */}
              {myEndpoints.map((ep) => (
                <div key={ep.id} style={{
                  background: "#0a0a0a", border: "1px solid #1a1a1a", borderRadius: 8,
                  padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10,
                }}>
                  {/* Top row: URL + status */}
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                    <span style={{
                      width: 6, height: 6, borderRadius: "50%", marginTop: 5, flexShrink: 0,
                      background: ep.active ? "#4ade80" : "#444",
                    }} />
                    <span style={{
                      fontSize: 12, color: "#ccc", flex: 1,
                      wordBreak: "break-all", lineHeight: 1.5,
                    }}>
                      {ep.url}
                    </span>
                    <button
                      onClick={() => { setUrl(ep.url); setSelectedEndpointId(ep.id); setTimeout(() => handleLookup(), 50); }}
                      style={{
                        flexShrink: 0, padding: "3px 10px",
                        fontFamily: "'JetBrains Mono', monospace", fontSize: 10,
                        borderRadius: 4, cursor: "pointer",
                        border: `1px solid ${selectedNetData.color}44`,
                        background: `${selectedNetData.color}11`,
                        color: selectedNetData.color,
                      }}
                    >
                      manage →
                    </button>
                  </div>

                  {/* Stats row */}
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 20px" }}>
                    {[
                      ["price",    `$${ep.pricePerCall}/call`],
                      ["calls",    ep.totalCalls.toString()],
                      ["revenue",  `$${ep.totalRevenue}`],
                      ["gas budget", ep.gasBudget > 0n ? `${formatNative(ep.gasBudget, 4)} HBAR` : "—"],
                      ["gas share", ep.gasSharePct > 0 ? `${ep.gasSharePct}%` : "—"],
                      ["since",    ep.registeredAt.toLocaleDateString()],
                    ].map(([k, v]) => (
                      <div key={k} style={{ display: "flex", gap: 5, alignItems: "baseline" }}>
                        <span style={{ fontSize: 10, color: "#444" }}>{k}</span>
                        <span style={{ fontSize: 11, color: "#777", fontFamily: "'JetBrains Mono', monospace" }}>{v}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      <div style={{ borderTop: "1px solid #111", margin: "0 -4px" }} />

      {/* ── Network ─────────────────────────────────────────────────────────── */}
      <Field label="Network">
        <div style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "9px 14px", borderRadius: 6,
          background: `${selectedNetData.color}15`, border: `1px solid ${selectedNetData.color}`,
        }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: selectedNetData.color, display: "inline-block", flexShrink: 0 }} />
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: selectedNetData.color, fontWeight: 700 }}>
            {selectedNetData.label}
          </span>
          <span style={{ fontSize: 10, color: selectedNetData.color, opacity: 0.6, marginLeft: "auto" }}>
            chain {selectedNetData.chainId}
          </span>
        </div>
      </Field>

      {/* ── Endpoint URL + lookup ────────────────────────────────────────────── */}
      <Field label="Endpoint URL" hint="— your registered URL">
        <div style={{ display: "flex", gap: 8 }}>
          <input
            type="url"
            placeholder="https://api.yourservice.com/endpoint"
            value={url}
            onChange={(e) => { setUrl(e.target.value); setInfo(null); setLookError(null); }}
            onKeyDown={(e) => e.key === "Enter" && handleLookup()}
            style={{ ...inputStyle, flex: 1 }}
          />
          <button
            onClick={handleLookup}
            disabled={looking || !url.trim()}
            style={{
              padding: "9px 16px", fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
              borderRadius: 6, cursor: (looking || !url.trim()) ? "default" : "pointer",
              background: looking ? "#111" : `${selectedNetData.color}22`,
              border: `1px solid ${(looking || !url.trim()) ? "#333" : selectedNetData.color}`,
              color: (looking || !url.trim()) ? "#555" : selectedNetData.color,
              whiteSpace: "nowrap", transition: "all 0.2s", flexShrink: 0,
            }}
          >
            {looking ? "fetching…" : "look up"}
          </button>
        </div>
      </Field>

      {/* ── Lookup error ─────────────────────────────────────────────────────── */}
      {lookError && (
        <div style={{
          padding: "10px 12px", borderRadius: 6,
          background: "#1a0a0a", border: "1px solid #3a1a1a",
          fontSize: 11, color: "#f87171",
        }}>
          ❌ {lookError}
        </div>
      )}

      {/* ── On-chain status ──────────────────────────────────────────────────── */}
      {info && (
        <div style={{
          background: "#0a0a0a", border: `1px solid ${selectedNetData.color}33`,
          borderRadius: 8, padding: "16px 18px",
          display: "flex", flexDirection: "column", gap: 14,
        }}>
          {/* Header */}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: "#e5e7eb" }}>
              {info.owner === "0x0000000000000000000000000000000000000000"
                ? "⚠ Endpoint not registered in paymaster"
                : "⚙ Endpoint found"}
            </span>
          </div>

          {/* Stats row */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: "12px 28px" }}>
            {[
              ["Gas Budget", info.balance === 0n ? "—" : `${formatNative(info.balance, 6)} ${selectedNetData.currency}`],
              ["Gas Share",  `${Math.round(info.bps / 100)}%`],
              ["Owner",      info.owner === "0x0000000000000000000000000000000000000000" ? "none" : `${info.owner.slice(0, 8)}…${info.owner.slice(-4)}`],
              ["Yours",      isOwner ? "✅ yes" : wallet.state.connected ? "✗ no" : "connect wallet"],
            ].map(([k, v]) => (
              <div key={k} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={{ fontSize: 10, color: "#444", textTransform: "uppercase", letterSpacing: "0.08em" }}>{k}</span>
                <span style={{
                  fontSize: 12, color: k === "Yours" && isOwner ? "#4ade80" : "#888",
                  fontFamily: "'JetBrains Mono', monospace",
                }}>{v}</span>
              </div>
            ))}
          </div>

          {/* Budget bar */}
          {info.balance > 0n && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#555" }}>
                <span>Gas Budget</span>
                <span>{formatNative(info.balance, 6)} {selectedNetData.currency}</span>
              </div>
              <div style={{ height: 4, background: "#1a1a1a", borderRadius: 2 }}>
                <div style={{
                  height: "100%", borderRadius: 2,
                  width: `${Math.min(100, Number(info.balance / (10n ** 15n)) / 10)}%`,
                  background: selectedNetData.color, transition: "width 0.6s ease",
                }} />
              </div>
            </div>
          )}

          {/* ── Management controls (owner only) ───────────────────────────── */}
          {info.owner !== "0x0000000000000000000000000000000000000000" && (
            <div style={{ borderTop: "1px solid #1a1a1a", paddingTop: 16, display: "flex", flexDirection: "column", gap: 18 }}>

                  {wallet.state.connected && !isOwner && (
                <div style={{
                  padding: "10px 14px", borderRadius: 6,
                  background: "#1a0a0a", border: "1px solid #3a1a1a",
                  fontSize: 11, color: "#f87171",
                }}>
                  ✗ Connected as <code style={{ fontSize: 11 }}>{wallet.state.address?.slice(0, 10)}…</code> — not the endpoint owner. Only <code style={{ fontSize: 11 }}>{info.owner.slice(0, 10)}…</code> can manage this endpoint.
                </div>
              )}

              {(isOwner || !wallet.state.connected) && (
                <>
                  {/* Gas share slider */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: "0.08em", minWidth: 90 }}>
                        Gas Share
                      </span>
                      <input
                        type="range" min={0} max={100} step={5} value={gasSharePct}
                        onChange={(e) => setNewBps(Number(e.target.value) * 100)}
                        style={{ flex: 1, accentColor: selectedNetData.color, cursor: "pointer" }}
                      />
                      <div style={{
                        minWidth: 48, textAlign: "center",
                        fontFamily: "'JetBrains Mono', monospace", fontSize: 15, fontWeight: 700,
                        color: gasSharePct >= 75 ? "#4ade80" : gasSharePct >= 40 ? selectedNetData.color : "#f87171",
                      }}>
                        {gasSharePct}%
                      </div>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "#333" }}>
                      <span>agent pays all gas</span>
                      <span>you pay all gas</span>
                    </div>
                    {newBps !== info.bps && (
                      <div style={{ fontSize: 10, color: "#f59e0b" }}>
                        ↳ Change from {Math.round(info.bps / 100)}% → {gasSharePct}% (not saved yet)
                      </div>
                    )}
                  </div>

                  {/* Share-only save */}
                  {isOwner && newBps !== info.bps && (
                    <button
                      onClick={() => handleSave("shareOnly")}
                      disabled={saving}
                      style={{
                        padding: "9px 0",
                        fontFamily: "'JetBrains Mono', monospace", fontSize: 12, fontWeight: 700,
                        borderRadius: 6, cursor: saving ? "default" : "pointer",
                        border: `1px solid ${selectedNetData.color}`,
                        background: `${selectedNetData.color}15`,
                        color: selectedNetData.color, transition: "all 0.2s",
                      }}
                    >
                      {saving && saveStep
                        ? saveStep
                        : wrongNetwork
                        ? `switch to ${selectedNetData.label}`
                        : `update share to ${gasSharePct}% (no top-up) →`}
                    </button>
                  )}

                  {/* Top-up section */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 11, color: "#888", textTransform: "uppercase", letterSpacing: "0.08em", minWidth: 90 }}>
                        Top Up
                      </span>
                      <input
                        type="number" min="0" step="0.001" value={topUpAmt}
                        onChange={(e) => setTopUpAmt(e.target.value)}
                        style={{ ...inputStyle, width: 140 }}
                      />
                      <span style={{ fontSize: 12, color: "#555" }}>{selectedNetData.currency}</span>
                    </div>
                    <div style={{ fontSize: 10, color: "#333", lineHeight: 1.5 }}>
                      Adds {topUpAmt || "0"} {selectedNetData.currency} to your gas budget and saves the {gasSharePct}% gas share in one transaction.
                    </div>

                    {isOwner && (
                      <button
                        onClick={() => handleSave("topup")}
                        disabled={saving || topUpFloat <= 0}
                        style={{
                          padding: "10px 0",
                          fontFamily: "'JetBrains Mono', monospace", fontSize: 12, fontWeight: 700,
                          borderRadius: 6,
                          cursor: (saving || topUpFloat <= 0) ? "default" : "pointer",
                          border: `1px solid ${(topUpFloat > 0 || wrongNetwork) ? "#4ade80" : "#222"}`,
                          background: (topUpFloat > 0 || wrongNetwork) ? "#081a08" : "#080808",
                          color: (topUpFloat > 0 || wrongNetwork) ? "#4ade80" : "#333",
                          transition: "all 0.2s",
                        }}
                      >
                        {saving && saveStep
                          ? saveStep
                          : wrongNetwork
                          ? `switch to ${selectedNetData.label}`
                          : topUpFloat <= 0
                          ? "enter an amount"
                          : `⬆ deposit ${topUpAmt} ${selectedNetData.currency} + set ${gasSharePct}% share →`}
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Save result */}
          {saveDone && (
            <div style={{
              padding: "10px 14px", borderRadius: 6,
              background: "#081a08", border: "1px solid #1a3a1a",
              display: "flex", flexDirection: "column", gap: 6,
            }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "#4ade80" }}>✅ Saved on-chain</div>
              <a
                href={selectedNetData.explorerTx(saveDone)}
                target="_blank" rel="noreferrer"
                style={{ fontSize: 11, color: selectedNetData.color }}
              >
                view tx ↗
              </a>
            </div>
          )}

          {/* Save error */}
          {saveError && (
            <div style={{
              padding: "10px 12px", borderRadius: 6,
              background: "#1a0a0a", border: "1px solid #3a1a1a",
              fontSize: 11, color: "#f87171", wordBreak: "break-all",
            }}>
              ❌ {saveError}
            </div>
          )}

          {/* ── Proxy Config ─────────────────────────────────────────────── */}
          {isOwner && selectedEndpointId !== null && (
            <div style={{
              borderTop: "1px solid #1a1a1a", paddingTop: 16, marginTop: 4,
              display: "flex", flexDirection: "column", gap: 10,
            }}>
              <button
                onClick={() => { setProxyEnabled((v) => !v); setProxyDone(false); setProxyError(null); }}
                style={{
                  padding: "8px 14px", borderRadius: 6, cursor: "pointer",
                  fontFamily: "'JetBrains Mono', monospace", fontSize: 11, fontWeight: 600,
                  border: `1px solid ${proxyEnabled ? selectedNetData.color : "#252525"}`,
                  background: proxyEnabled ? `${selectedNetData.color}18` : "#0a0a0a",
                  color: proxyEnabled ? selectedNetData.color : "#555",
                  transition: "all 0.2s",
                }}
              >
                {proxyEnabled ? "▲ hide proxy setup" : "🔀 configure as proxy → forward to any API"}
              </button>

              {proxyEnabled && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {/* Active proxy status */}
                  {activeProxy && (
                    <div style={{
                      padding: "10px 14px", borderRadius: 6,
                      background: "#081a08", border: "1px solid #1a3a1a",
                      display: "flex", flexDirection: "column", gap: 6,
                    }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: "#4ade80" }}>🔀 Proxy currently active</div>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 10, color: "#555" }}>→</span>
                        <span style={{ fontSize: 10, color: "#888", wordBreak: "break-all" }}>{activeProxy.backendUrl}</span>
                      </div>
                      {activeProxy.headerKeys.length > 0 && (
                        <div style={{ fontSize: 10, color: "#555" }}>
                          injecting: {activeProxy.headerKeys.join(", ")}
                        </div>
                      )}
                      <code style={{ fontSize: 10, color: selectedNetData.color, background: "#0d1a0d", padding: "3px 7px", borderRadius: 4, wordBreak: "break-all" }}>
                        {(import.meta as any).env?.VITE_SERVER_URL || "http://localhost:4021"}{activeProxy.proxyUrl}
                      </code>
                      <button
                        disabled={deactivating}
                        onClick={handleDeactivateProxy}
                        style={{
                          marginTop: 4, padding: "7px 14px", borderRadius: 5, cursor: deactivating ? "not-allowed" : "pointer",
                          fontFamily: "'JetBrains Mono', monospace", fontSize: 11, fontWeight: 600,
                          background: "#1a0a0a", border: "1px solid #3a1a1a", color: deactivating ? "#555" : "#f87171",
                          transition: "all 0.2s", alignSelf: "flex-start",
                        }}
                      >
                        {deactivating ? "signing…" : "🗑 deactivate proxy"}
                      </button>
                      {deactivateError && (
                        <div style={{ fontSize: 10, color: "#f87171" }}>❌ {deactivateError}</div>
                      )}
                    </div>
                  )}

                  {!activeProxy && (
                  <div style={{ fontSize: 11, color: "#666" }}>
                    Proxy mode forwards incoming paid requests to your backend URL, injecting your private auth headers.
                    Agents call <code style={{ color: selectedNetData.color }}>/api/proxy/{selectedEndpointId}</code>.
                  </div>)}

                  {/* Config form — only shown when proxy is not yet active */}
                  {!activeProxy && (<>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <label style={{ fontSize: 10, color: "#888", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                      Backend URL
                    </label>
                    <input
                      value={backendUrl}
                      onChange={(e) => setBackendUrl(e.target.value)}
                      placeholder="https://api.anthropic.com/v1/messages"
                      style={{
                        background: "#111", border: "1px solid #252525", borderRadius: 5,
                        padding: "8px 10px", color: "#ccc", fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 11, outline: "none", width: "100%", boxSizing: "border-box",
                      }}
                    />
                  </div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <label style={{ fontSize: 10, color: "#888", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                      Auth headers (private — stored server-side only)
                    </label>
                    {headerRows.map((row, i) => (
                      <div key={i} style={{ display: "flex", gap: 6 }}>
                        <input
                          value={row.key}
                          onChange={(e) => {
                            const r = [...headerRows]; r[i] = { ...r[i], key: e.target.value }; setHeaderRows(r);
                          }}
                          placeholder="x-api-key"
                          style={{
                            flex: 1, background: "#111", border: "1px solid #252525", borderRadius: 5,
                            padding: "6px 8px", color: "#ccc", fontFamily: "'JetBrains Mono', monospace",
                            fontSize: 11, outline: "none",
                          }}
                        />
                        <input
                          value={row.value}
                          onChange={(e) => {
                            const r = [...headerRows]; r[i] = { ...r[i], value: e.target.value }; setHeaderRows(r);
                          }}
                          placeholder="sk-••••"
                          style={{
                            flex: 2, background: "#111", border: "1px solid #252525", borderRadius: 5,
                            padding: "6px 8px", color: "#ccc", fontFamily: "'JetBrains Mono', monospace",
                            fontSize: 11, outline: "none",
                          }}
                        />
                        {headerRows.length > 1 && (
                          <button
                            onClick={() => setHeaderRows(headerRows.filter((_, j) => j !== i))}
                            style={{
                              background: "none", border: "1px solid #2a2a2a", borderRadius: 4,
                              color: "#555", cursor: "pointer", padding: "0 8px", fontSize: 12,
                            }}
                          >×</button>
                        )}
                      </div>
                    ))}
                    <button
                      onClick={() => setHeaderRows([...headerRows, { key: "", value: "" }])}
                      style={{
                        alignSelf: "flex-start", background: "none", border: "1px solid #2a2a2a",
                        borderRadius: 4, color: "#555", cursor: "pointer", padding: "4px 10px", fontSize: 11,
                      }}
                    >+ add header</button>
                  </div>

                  <button
                    disabled={proxySaving || !backendUrl.trim()}
                    onClick={handleProxyConfig}
                    style={{
                      padding: "9px 16px", borderRadius: 6, cursor: proxySaving || !backendUrl.trim() ? "not-allowed" : "pointer",
                      fontFamily: "'JetBrains Mono', monospace", fontSize: 11, fontWeight: 700,
                      background: proxySaving || !backendUrl.trim() ? "#111" : selectedNetData.color,
                      color: proxySaving || !backendUrl.trim() ? "#444" : "#000",
                      border: "none", transition: "all 0.2s",
                    }}
                  >
                    {proxySaving ? "signing + saving…" : "🔏 sign + activate proxy"}
                  </button>
                  </>)}

                  {proxyDone && (
                    <div style={{
                      padding: "10px 14px", borderRadius: 6,
                      background: "#081a08", border: "1px solid #1a3a1a",
                      display: "flex", flexDirection: "column", gap: 4,
                    }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: "#4ade80" }}>✅ Proxy activated</div>
                      <div style={{ fontSize: 11, color: "#888" }}>
                        Agents can now call:
                      </div>
                      <code style={{
                        fontSize: 10, color: selectedNetData.color, background: "#0d1a0d",
                        padding: "4px 8px", borderRadius: 4, wordBreak: "break-all",
                      }}>
                        {window.location.origin}/api/proxy/{selectedEndpointId}
                      </code>
                    </div>
                  )}

                  {proxyError && (
                    <div style={{
                      padding: "8px 12px", borderRadius: 6,
                      background: "#1a0a0a", border: "1px solid #3a1a1a",
                      fontSize: 11, color: "#f87171", wordBreak: "break-all",
                    }}>
                      ❌ {proxyError}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
