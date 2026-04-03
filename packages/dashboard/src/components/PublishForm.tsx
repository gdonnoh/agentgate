import { useState, useRef } from "react";
import { keccak256, toBytes, type Hex } from "viem";
import { NetworkId, NETWORKS, DEPLOYMENTS } from "../lib/chains";
import { useWallet } from "../hooks/useWallet";

const REGISTRY_ABI = [
  {
    name: "registerEndpoint",
    type: "function",
    inputs: [
      { name: "url",              type: "string"  },
      { name: "pricePerCall",     type: "uint256" },
      { name: "paymasterAddress", type: "address" },
    ],
    outputs: [{ name: "id", type: "uint256" }],
    stateMutability: "nonpayable",
  },
] as const;

const PAYMASTER_ABI = [
  {
    name: "setEndpointSponsorshipByUrl",
    type: "function",
    inputs: [
      { name: "url", type: "string"  },
      { name: "bps", type: "uint16" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

type PaymasterMode = "deployed" | "custom" | "none";

interface TestResult {
  ok: boolean;
  status: number;
  statusText: string;
  latencyMs: number;
  isX402: boolean;
  contentType: string | null;
  bodyPreview: string;
  paymentRequired?: {
    price?: string;
    network?: string;
    asset?: string;
  };
  errorMsg?: string;
}

interface PublishResult {
  txHash: string;
  networkId: NetworkId;
  endpointId?: string;
}

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

const inputStyle: React.CSSProperties = {
  background: "#0d0d0d",
  border: "1px solid #252525",
  borderRadius: 6,
  color: "#e5e7eb",
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 12,
  padding: "9px 12px",
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
  transition: "border-color 0.2s",
};

export function PublishForm({ networkId }: { networkId: NetworkId }) {
  const net    = NETWORKS[networkId];
  const wallet = useWallet();

  // Form fields
  const [url,           setUrl]           = useState("");
  const [price,         setPrice]         = useState("0.01");
  const [gasSharePct,   setGasSharePct]   = useState(100); // 0-100 %
  const [pmMode,        setPmMode]        = useState<PaymasterMode>("deployed");
  const [customPm,      setCustomPm]      = useState("");
  const [selectedNet,   setSelectedNet]   = useState<NetworkId>(networkId);

  // Test state
  const [testing,       setTesting]       = useState(false);
  const [testResult,    setTestResult]    = useState<TestResult | null>(null);

  // Publish state
  const [publishing,    setPublishing]    = useState(false);
  const [publishStep,   setPublishStep]   = useState<string>("");
  const [publishResult, setPublishResult] = useState<PublishResult | null>(null);
  const [publishError,  setPublishError]  = useState<string | null>(null);

  const urlRef = useRef<HTMLInputElement>(null);

  const paymasterAddress: `0x${string}` =
    pmMode === "deployed" ? DEPLOYMENTS[selectedNet].paymaster :
    pmMode === "custom"   ? (customPm as `0x${string}`) :
    "0x0000000000000000000000000000000000000000";

  // ── Test endpoint ──────────────────────────────────────────────────────────
  async function handleTest() {
    if (!url.trim()) { urlRef.current?.focus(); return; }
    setTesting(true);
    setTestResult(null);
    setPublishResult(null);
    setPublishError(null);

    const t0 = Date.now();
    try {
      const res = await fetch(url.trim(), {
        method: "GET",
        signal: AbortSignal.timeout(8000),
      });
      const latencyMs = Date.now() - t0;
      const contentType = res.headers.get("content-type");
      const paymentHeader = res.headers.get("payment-required");
      const isX402 = res.status === 402;

      let bodyPreview = "";
      let paymentRequired: TestResult["paymentRequired"] = undefined;

      try {
        const text = await res.text();
        bodyPreview = text.slice(0, 300);

        if (isX402 && paymentHeader) {
          try {
            const parsed = JSON.parse(atob(paymentHeader.split(".")[0])) as any;
            const acc = parsed?.accepts?.[0];
            paymentRequired = {
              price:   acc?.amount ? `$${(Number(acc.amount) / 1e6).toFixed(4)} USDC` : undefined,
              network: acc?.network,
              asset:   acc?.asset,
            };
          } catch {
            // header parse failed — that's fine
          }
        }
      } catch {
        bodyPreview = "(binary or empty)";
      }

      const ok = res.status === 200 || res.status === 402;
      setTestResult({
        ok,
        status: res.status,
        statusText: res.statusText,
        latencyMs,
        isX402,
        contentType,
        bodyPreview,
        paymentRequired,
        errorMsg: ok ? undefined : `HTTP ${res.status} — endpoint returned an error`,
      });
    } catch (e: any) {
      setTestResult({
        ok: false,
        status: 0,
        statusText: "Network error",
        latencyMs: Date.now() - t0,
        isX402: false,
        contentType: null,
        bodyPreview: "",
        errorMsg: e.name === "TimeoutError"
          ? "Request timed out after 8s — endpoint unreachable"
          : `Connection failed: ${e.message}`,
      });
    } finally {
      setTesting(false);
    }
  }

  // ── Publish on-chain ───────────────────────────────────────────────────────
  async function handlePublish() {
    if (!testResult?.ok) return;
    if (!wallet.state.connected) {
      await wallet.connect();
      return;
    }
    if (wallet.state.chainId !== NETWORKS[selectedNet].chainId) {
      await wallet.switchNetwork(selectedNet);
      return;
    }

    setPublishing(true);
    setPublishError(null);
    setPublishResult(null);
    setPublishStep("");

    try {
      const priceUnits = BigInt(Math.round(parseFloat(price) * 1_000_000));

      // Step 1: Register endpoint on PublisherRegistry
      setPublishStep("1/2 Registering endpoint on-chain…");
      const regHash = await wallet.writeContract(
        selectedNet,
        DEPLOYMENTS[selectedNet].publisherRegistry,
        REGISTRY_ABI as any,
        "registerEndpoint",
        [url.trim(), priceUnits, paymasterAddress]
      );

      // Step 2: Set gas sponsorship on Paymaster (only for our deployed paymaster)
      let sponsorHash: string | null = null;
      if (pmMode === "deployed" && gasSharePct >= 0) {
        setPublishStep("2/2 Setting gas sponsorship on Paymaster…");
        try {
          const bps = Math.round(gasSharePct * 100); // 100% → 10000 bps
          sponsorHash = await wallet.writeContract(
            selectedNet,
            DEPLOYMENTS[selectedNet].paymaster,
            PAYMASTER_ABI as any,
            "setEndpointSponsorshipByUrl",
            [url.trim(), bps]
          );
        } catch (sponsorErr: any) {
          // Non-blocking — registry registration is the main step
          console.warn("Sponsorship set failed:", sponsorErr.message);
        }
      }

      setPublishStep("");
      setPublishResult({ txHash: regHash, networkId: selectedNet });
    } catch (e: any) {
      setPublishError(e.shortMessage || e.message);
    } finally {
      setPublishing(false);
      setPublishStep("");
    }
  }

  const wrongNetwork = wallet.state.connected && wallet.state.chainId !== NETWORKS[selectedNet].chainId;
  const canPublish   = testResult?.ok && !publishing && !publishResult;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>

      {/* ── Network selector ───────────────────────────────────────────────── */}
      <Field label="Target Network">
        <div style={{ display: "flex", gap: 8 }}>
          {(["baseSepolia", "hedera"] as NetworkId[]).map((id) => {
            const n = NETWORKS[id];
            const active = selectedNet === id;
            return (
              <button
                key={id}
                onClick={() => { setSelectedNet(id); setTestResult(null); }}
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

      {/* ── Endpoint URL ───────────────────────────────────────────────────── */}
      <Field label="Endpoint URL" hint="— must return 200 or 402">
        <div style={{ display: "flex", gap: 8 }}>
          <input
            ref={urlRef}
            type="url"
            placeholder="https://api.yourservice.com/endpoint"
            value={url}
            onChange={(e) => { setUrl(e.target.value); setTestResult(null); }}
            onKeyDown={(e) => e.key === "Enter" && handleTest()}
            style={{ ...inputStyle, flex: 1 }}
          />
          <button
            onClick={handleTest}
            disabled={testing || !url.trim()}
            style={{
              padding: "9px 16px", fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
              borderRadius: 6, cursor: testing || !url.trim() ? "default" : "pointer",
              background: testing ? "#111" : `${net.color}22`,
              border: `1px solid ${testing ? "#333" : net.color}`,
              color: testing ? "#555" : net.color,
              whiteSpace: "nowrap", transition: "all 0.2s", flexShrink: 0,
            }}
          >
            {testing ? "testing…" : "▶ test"}
          </button>
        </div>
      </Field>

      {/* ── Test result ────────────────────────────────────────────────────── */}
      {testResult && (
        <div style={{
          background: testResult.ok ? "#0a1a0a" : "#1a0a0a",
          border: `1px solid ${testResult.ok ? "#1a3a1a" : "#3a1a1a"}`,
          borderRadius: 8, padding: "14px 16px",
          display: "flex", flexDirection: "column", gap: 10,
        }}>
          {/* Status line */}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 16 }}>{testResult.ok ? "✅" : "❌"}</span>
            <div style={{ flex: 1 }}>
              <span style={{
                fontSize: 13, fontWeight: 700,
                color: testResult.ok ? "#4ade80" : "#f87171",
              }}>
                {testResult.ok
                  ? testResult.isX402
                    ? "x402 Payment Protected Endpoint"
                    : "Endpoint Reachable"
                  : "Test Failed"}
              </span>
              {testResult.errorMsg && (
                <div style={{ fontSize: 11, color: "#f87171", marginTop: 2 }}>{testResult.errorMsg}</div>
              )}
            </div>
            <span style={{ fontSize: 11, color: "#555" }}>{testResult.latencyMs}ms</span>
          </div>

          {/* Response details */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 20px" }}>
            {[
              ["HTTP Status", `${testResult.status} ${testResult.statusText}`],
              ["Content-Type", testResult.contentType || "—"],
              testResult.isX402 && testResult.paymentRequired?.price
                ? ["Price", testResult.paymentRequired.price]
                : null,
              testResult.isX402 && testResult.paymentRequired?.network
                ? ["Network", testResult.paymentRequired.network]
                : null,
            ].filter(Boolean).map((item) => { const [k, v] = item as string[]; return (
              <div key={k} style={{ display: "flex", gap: 6 }}>
                <span style={{ fontSize: 10, color: "#555" }}>{k}</span>
                <span style={{ fontSize: 10, color: "#888" }}>{v}</span>
              </div>
            ); })}
          </div>

          {/* Body preview */}
          {testResult.bodyPreview && (
            <pre style={{
              margin: 0, fontSize: 10, color: "#555",
              background: "#050505", border: "1px solid #111",
              borderRadius: 4, padding: "8px 10px",
              maxHeight: 80, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all",
            }}>
              {testResult.bodyPreview}
            </pre>
          )}

          {!testResult.ok && (
            <div style={{ fontSize: 11, color: "#666" }}>
              Only HTTP 200 and 402 responses are accepted. Fix the endpoint and re-test.
            </div>
          )}
        </div>
      )}

      {/* ── Price ──────────────────────────────────────────────────────────── */}
      <Field label="Price per Call" hint="— in USDC">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 14, color: "#555", paddingLeft: 4 }}>$</span>
          <input
            type="number" min="0" step="0.001"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            style={{ ...inputStyle, width: 120 }}
          />
          <span style={{ fontSize: 12, color: "#555" }}>USDC</span>
          <span style={{ fontSize: 10, color: "#333", marginLeft: 4 }}>
            = {Math.round(parseFloat(price || "0") * 1_000_000).toLocaleString()} units (6 dec)
          </span>
        </div>
      </Field>

      {/* ── Paymaster ──────────────────────────────────────────────────────── */}
      <Field label="Gas Paymaster" hint="— who sponsors transaction gas">
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {([
            ["deployed",  `AgentGate Paymaster (${DEPLOYMENTS[selectedNet].paymaster.slice(0, 10)}…)`,
              "Uses the already-deployed paymaster with 0.5 HBAR / 0.005 ETH deposit"],
            ["custom",    "Custom paymaster address",
              "Deploy your own ERC-4337 paymaster"],
            ["none",      "No paymaster — agent pays own gas",
              "Agent must hold native currency for gas"],
          ] as [PaymasterMode, string, string][]).map(([mode, label, desc]) => {
            const active = pmMode === mode;
            return (
              <div
                key={mode}
                onClick={() => setPmMode(mode)}
                style={{
                  padding: "10px 12px", borderRadius: 6, cursor: "pointer",
                  border: `1px solid ${active ? net.color + "88" : "#1e1e1e"}`,
                  background: active ? `${net.color}0a` : "#0a0a0a",
                  transition: "all 0.15s",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{
                    width: 12, height: 12, borderRadius: "50%", flexShrink: 0,
                    border: `2px solid ${active ? net.color : "#333"}`,
                    background: active ? net.color : "transparent",
                    transition: "all 0.15s",
                  }} />
                  <span style={{ fontSize: 12, color: active ? "#e5e7eb" : "#555" }}>{label}</span>
                </div>
                <div style={{ fontSize: 10, color: "#444", marginLeft: 20, marginTop: 3 }}>{desc}</div>
              </div>
            );
          })}

          {pmMode === "custom" && (
            <input
              type="text"
              placeholder="0x000..."
              value={customPm}
              onChange={(e) => setCustomPm(e.target.value)}
              style={{ ...inputStyle, marginTop: 4 }}
            />
          )}
        </div>
      </Field>

      {/* ── Gas Sponsorship Slider ─────────────────────────────────────────── */}
      {pmMode === "deployed" && (
        <Field
          label="Gas Sponsorship"
          hint="— % of gas you cover for agents calling this endpoint"
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {/* Slider */}
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <input
                type="range"
                min={0} max={100} step={5}
                value={gasSharePct}
                onChange={(e) => setGasSharePct(Number(e.target.value))}
                style={{ flex: 1, accentColor: net.color, cursor: "pointer" }}
              />
              <div style={{
                minWidth: 52, textAlign: "center",
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: 16, fontWeight: 700,
                color: gasSharePct >= 75 ? "#4ade80" : gasSharePct >= 40 ? net.color : "#f87171",
              }}>
                {gasSharePct}%
              </div>
            </div>

            {/* Labels */}
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "#444" }}>
              <span>agent pays gas</span>
              <span>you pay gas</span>
            </div>

            {/* Context callout */}
            <div style={{
              padding: "10px 14px", borderRadius: 6,
              background: gasSharePct >= 75 ? "#0a1a0a" : gasSharePct >= 40 ? "#0a0f1a" : "#1a0a0a",
              border: `1px solid ${gasSharePct >= 75 ? "#1a3a1a" : gasSharePct >= 40 ? "#1a2a3a" : "#3a1a1a"}`,
              fontSize: 11, lineHeight: 1.5,
            }}>
              {gasSharePct === 100 && (
                <span style={{ color: "#4ade80" }}>
                  🏆 <strong>Maximum appeal</strong> — you sponsor 100% of gas. Agents pay nothing. 
                  Recommended to attract all AI agents.
                </span>
              )}
              {gasSharePct >= 50 && gasSharePct < 100 && (
                <span style={{ color: net.color }}>
                  ⚡ <strong>Balanced</strong> — you sponsor {gasSharePct}% of gas.
                  Effective daily budget: {(gasSharePct / 100).toFixed(2)}× per call.
                  More calls per day vs 100%.
                </span>
              )}
              {gasSharePct > 0 && gasSharePct < 50 && (
                <span style={{ color: "#f59e0b" }}>
                  ⚠ <strong>Low appeal</strong> — only {gasSharePct}% sponsored.
                  Agents prefer fully-sponsored endpoints. Consider increasing.
                </span>
              )}
              {gasSharePct === 0 && (
                <span style={{ color: "#f87171" }}>
                  ✗ <strong>No sponsorship</strong> — agents must hold {net.currency} for gas.
                  This endpoint will not attract AI agents without wallets.
                </span>
              )}
            </div>

            {/* Competitive breakdown */}
            <div style={{
              display: "flex", gap: 6,
              fontSize: 10, color: "#555",
              fontFamily: "'JetBrains Mono', monospace",
            }}>
              <span>daily budget: 0.01 {net.currency}</span>
              <span style={{ color: "#333" }}>·</span>
              <span>effective/call: ≤{(0.01 * gasSharePct / 100).toFixed(5)} {net.currency}</span>
              <span style={{ color: "#333" }}>·</span>
              <span>est. calls/day: ~{gasSharePct > 0 ? Math.floor(0.01 / (0.0003 * gasSharePct / 100)) : "∞"}</span>
            </div>
          </div>
        </Field>
      )}

      {/* ── Paymaster address preview ───────────────────────────────────────── */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "8px 12px", background: "#0a0a0a",
        border: "1px solid #1a1a1a", borderRadius: 6,
      }}>
        <span style={{ fontSize: 10, color: "#444" }}>paymasterAddress</span>
        <span style={{ fontSize: 10, color: "#666", fontFamily: "'JetBrains Mono', monospace", flex: 1 }}>
          {paymasterAddress}
        </span>
        {pmMode === "deployed" && (
          <span style={{ fontSize: 9, color: "#4ade80" }}>
            staked ✓
          </span>
        )}
      </div>

      {/* ── Wallet + Publish ───────────────────────────────────────────────── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 4 }}>

        {/* Wallet status */}
        {wallet.state.connected ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 7, height: 7, borderRadius: "50%", background: "#4ade80" }} />
            <span style={{ fontSize: 11, color: "#666" }}>
              {wallet.state.address!.slice(0, 10)}…{wallet.state.address!.slice(-4)}
            </span>
            {wrongNetwork && (
              <span style={{ fontSize: 10, color: "#f87171" }}>
                wrong network — click Publish to switch
              </span>
            )}
            <button
              onClick={wallet.disconnect}
              style={{
                marginLeft: "auto", background: "none", border: "none",
                color: "#444", cursor: "pointer", fontSize: 10, padding: "2px 6px",
              }}
            >
              disconnect
            </button>
          </div>
        ) : (
          <div style={{ fontSize: 11, color: "#444" }}>
            {wallet.state.error
              ? <span style={{ color: "#f87171" }}>⚠ {wallet.state.error}</span>
              : "Connect wallet to publish on-chain"}
          </div>
        )}

        {/* Publish button */}
        <button
          onClick={handlePublish}
          disabled={!canPublish}
          style={{
            padding: "12px 0",
            fontFamily: "'JetBrains Mono', monospace", fontSize: 13, fontWeight: 700,
            borderRadius: 8, cursor: canPublish ? "pointer" : "default",
            border: `1px solid ${canPublish ? net.color : "#1e1e1e"}`,
            background: canPublish ? `${net.color}22` : "#080808",
            color: canPublish ? net.color : "#2a2a2a",
            transition: "all 0.2s",
          }}
        >
          {publishing
            ? (publishStep || "publishing…")
            : !testResult?.ok
            ? "run test first"
            : !wallet.state.connected
            ? "🔗 connect wallet + publish"
            : wrongNetwork
            ? `switch to ${NETWORKS[selectedNet].label}`
            : pmMode === "deployed"
            ? `publish on-chain (${gasSharePct}% gas sponsored) →`
            : "publish on-chain →"
          }
        </button>

        {/* Publish error */}
        {publishError && (
          <div style={{
            padding: "10px 12px", borderRadius: 6,
            background: "#1a0a0a", border: "1px solid #3a1a1a",
            fontSize: 11, color: "#f87171",
          }}>
            ❌ {publishError}
          </div>
        )}

        {/* Publish success */}
        {publishResult && (
          <div style={{
            padding: "14px 16px", borderRadius: 8,
            background: "#0a1a0a", border: "1px solid #1a3a1a",
            display: "flex", flexDirection: "column", gap: 8,
          }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#4ade80" }}>
              ✅ Endpoint published on-chain
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {[
                ["Network",  NETWORKS[publishResult.networkId].label],
                ["URL",      url],
                ["Price",    "$" + price + " USDC"],
                ["Paymaster", paymasterAddress.slice(0, 12) + "…"],
                ["Gas share", pmMode === "deployed" ? `${gasSharePct}% (on-chain)` : "—"],
                ["Tx hash",  publishResult.txHash],
              ].map(([k, v]) => (
                <div key={k} style={{ display: "flex", gap: 8 }}>
                  <span style={{ fontSize: 10, color: "#555", width: 70, flexShrink: 0 }}>{k}</span>
                  <span style={{ fontSize: 10, color: "#888", wordBreak: "break-all" }}>{v}</span>
                </div>
              ))}
            </div>
            <a
              href={NETWORKS[publishResult.networkId].explorerTx(publishResult.txHash)}
              target="_blank" rel="noreferrer"
              style={{ fontSize: 11, color: net.color, marginTop: 2 }}
            >
              view on {networkId === "hedera" ? "HashScan" : "Basescan"} ↗
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
