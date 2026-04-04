import { useState } from "react";
import { createPublicClient, http, keccak256, toHex, toBytes } from "viem";
import { baseSepolia } from "viem/chains";
import { hederaTestnet, NetworkId, NETWORKS, DEPLOYMENTS } from "../lib/chains";
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
  balance: bigint;      // wei / weibars
  bps: number;          // 0–10000
  owner: `0x${string}`;
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

export function ManageEndpoint({ networkId }: { networkId: NetworkId }) {
  const net    = NETWORKS[networkId];
  const wallet = useWallet();

  const [selectedNet, setSelectedNet] = useState<NetworkId>(networkId);
  const [url,         setUrl]         = useState("");

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

  const selectedNetData = NETWORKS[selectedNet];
  const paymasterAddr   = DEPLOYMENTS[selectedNet].paymaster;

  // ── Look up on-chain data ──────────────────────────────────────────────────

  async function handleLookup() {
    const trimmed = url.trim();
    if (!trimmed) return;
    setLooking(true);
    setLookError(null);
    setInfo(null);
    setSaveDone(null);
    setSaveError(null);

    try {
      const chain        = selectedNet === "hedera" ? hederaTestnet : baseSepolia;
      const publicClient = createPublicClient({ chain, transport: http(NETWORKS[selectedNet].rpc) });
      const hash         = endpointHash(trimmed);

      const [balance, bps, owner] = await Promise.all([
        publicClient.readContract({ address: paymasterAddr, abi: PAYMASTER_READ_ABI, functionName: "endpointBalance", args: [hash] }),
        publicClient.readContract({ address: paymasterAddr, abi: PAYMASTER_READ_ABI, functionName: "endpointGasShareBps", args: [hash] }),
        publicClient.readContract({ address: paymasterAddr, abi: PAYMASTER_READ_ABI, functionName: "endpointOwner", args: [hash] }),
      ]);

      setInfo({ balance: balance as bigint, bps: Number(bps), owner: owner as `0x${string}` });
      setNewBps(Number(bps));
    } catch (e: any) {
      setLookError(e.shortMessage || e.message || String(e));
    } finally {
      setLooking(false);
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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>

      {/* ── Network ─────────────────────────────────────────────────────────── */}
      <Field label="Network">
        <div style={{ display: "flex", gap: 8 }}>
          {(["baseSepolia", "hedera"] as NetworkId[]).map((id) => {
            const n      = NETWORKS[id];
            const active = selectedNet === id;
            return (
              <button key={id} onClick={() => { setSelectedNet(id); setInfo(null); setLookError(null); }}
                style={{
                  flex: 1, padding: "8px 0", fontFamily: "'JetBrains Mono', monospace",
                  fontSize: 11, cursor: "pointer", borderRadius: 6, transition: "all 0.2s",
                  background: active ? `${n.color}15` : "transparent",
                  border: `1px solid ${active ? n.color : "#222"}`,
                  color: active ? n.color : "#444",
                }}
              >
                {n.label}
              </button>
            );
          })}
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

              {!wallet.state.connected && (
                <button
                  onClick={wallet.connect}
                  style={{
                    padding: "10px 0", fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 12, fontWeight: 700, borderRadius: 6, cursor: "pointer",
                    border: `1px solid ${selectedNetData.color}`,
                    background: `${selectedNetData.color}22`,
                    color: selectedNetData.color,
                  }}
                >
                  🔗 connect wallet to manage
                </button>
              )}

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
                      disabled={saving || wrongNetwork}
                      style={{
                        padding: "9px 0",
                        fontFamily: "'JetBrains Mono', monospace", fontSize: 12, fontWeight: 700,
                        borderRadius: 6, cursor: (saving || wrongNetwork) ? "default" : "pointer",
                        border: `1px solid ${selectedNetData.color}`,
                        background: `${selectedNetData.color}15`,
                        color: selectedNetData.color, transition: "all 0.2s",
                      }}
                    >
                      {saving && saveStep ? saveStep : `update share to ${gasSharePct}% (no top-up) →`}
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
                        disabled={saving || wrongNetwork || topUpFloat <= 0}
                        style={{
                          padding: "10px 0",
                          fontFamily: "'JetBrains Mono', monospace", fontSize: 12, fontWeight: 700,
                          borderRadius: 6,
                          cursor: (saving || wrongNetwork || topUpFloat <= 0) ? "default" : "pointer",
                          border: `1px solid ${(topUpFloat > 0 && !wrongNetwork) ? "#4ade80" : "#222"}`,
                          background: (topUpFloat > 0 && !wrongNetwork) ? "#081a08" : "#080808",
                          color: (topUpFloat > 0 && !wrongNetwork) ? "#4ade80" : "#333",
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
        </div>
      )}
    </div>
  );
}
