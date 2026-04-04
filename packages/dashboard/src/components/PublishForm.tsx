import { useState, useRef } from "react";
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
    name: "fundAndSetGasShare",
    type: "function",
    inputs: [
      { name: "url", type: "string" },
      { name: "bps", type: "uint16" },
    ],
    outputs: [],
    stateMutability: "payable",
  },
] as const;

interface TestResult {
  ok: boolean;
  status: number;
  statusText: string;
  latencyMs: number;
  isX402: boolean;
  contentType: string | null;
  bodyPreview: string;
  paymentRequired?: { price?: string; network?: string; asset?: string };
  errorMsg?: string;
}

interface PublishResult {
  txHash: string;
  networkId: NetworkId;
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
  background: "#0d0d0d", border: "1px solid #252525", borderRadius: 6,
  color: "#e5e7eb", fontFamily: "'JetBrains Mono', monospace", fontSize: 12,
  padding: "9px 12px", outline: "none", width: "100%",
  boxSizing: "border-box", transition: "border-color 0.2s",
};

export function PublishForm({ networkId }: { networkId: NetworkId }) {
  const net    = NETWORKS[networkId];
  const wallet = useWallet();

  const [url,           setUrl]           = useState("");
  const [price,         setPrice]         = useState("0.01");
  const [gasSharePct,   setGasSharePct]   = useState(100);    // 0–100%
  const [gasDeposit,    setGasDeposit]    = useState("0.005"); // ETH to deposit
  const [selectedNet] = useState<NetworkId>("hedera");

  const [testing,       setTesting]       = useState(false);
  const [testResult,    setTestResult]    = useState<TestResult | null>(null);
  const [publishing,    setPublishing]    = useState(false);
  const [publishStep,   setPublishStep]   = useState("");
  const [publishResult, setPublishResult] = useState<PublishResult | null>(null);
  const [publishError,  setPublishError]  = useState<string | null>(null);
  const [depositError,  setDepositError]  = useState<string | null>(null);
  const [depositDone,   setDepositDone]   = useState(false);

  const urlRef = useRef<HTMLInputElement>(null);

  const paymasterAddress = DEPLOYMENTS[selectedNet].paymaster;

  // ── Test endpoint ─────────────────────────────────────────────────────────
  async function handleTest() {
    if (!url.trim()) { urlRef.current?.focus(); return; }
    setTesting(true);
    setTestResult(null);
    setPublishResult(null);
    setPublishError(null);
    const t0 = Date.now();
    try {
      const res = await fetch(url.trim(), { method: "GET", signal: AbortSignal.timeout(8000) });
      const latencyMs    = Date.now() - t0;
      const contentType  = res.headers.get("content-type");
      const paymentHeader = res.headers.get("payment-required");
      const isX402       = res.status === 402;
      let bodyPreview    = "";
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
              network: acc?.network, asset: acc?.asset,
            };
          } catch { /* ignore */ }
        }
      } catch { bodyPreview = "(binary or empty)"; }
      const ok = res.status === 200 || res.status === 402;
      setTestResult({ ok, status: res.status, statusText: res.statusText, latencyMs,
        isX402, contentType, bodyPreview, paymentRequired,
        errorMsg: ok ? undefined : `HTTP ${res.status} — endpoint returned an error` });
    } catch (e: any) {
      setTestResult({ ok: false, status: 0, statusText: "Network error",
        latencyMs: Date.now() - t0, isX402: false, contentType: null, bodyPreview: "",
        errorMsg: e.name === "TimeoutError" ? "Timeout after 8s" : `Connection failed: ${e.message}` });
    } finally {
      setTesting(false);
    }
  }

  // ── Publish on-chain ──────────────────────────────────────────────────────
  async function handlePublish() {
    if (!testResult?.ok) return;
    if (!wallet.state.connected) { await wallet.connect(); return; }
    if (wallet.state.chainId !== NETWORKS[selectedNet].chainId) {
      await wallet.switchNetwork(selectedNet); return;
    }
    setPublishing(true);
    setPublishError(null);
    setPublishResult(null);
    setDepositError(null);
    setDepositDone(false);
    setPublishStep("");

    try {
      // Step 1: Register on PublisherRegistry
      setPublishStep("1/2 Registering endpoint…");
      const priceUnits = BigInt(Math.round(parseFloat(price) * 1_000_000));
      const regHash = await wallet.writeContract(
        selectedNet,
        DEPLOYMENTS[selectedNet].publisherRegistry,
        REGISTRY_ABI as any,
        "registerEndpoint",
        [url.trim(), priceUnits, paymasterAddress]
      );

      setPublishResult({ txHash: regHash, networkId: selectedNet });

      // Step 2: Fund your gas budget on the Paymaster
      if (parseFloat(gasDeposit) > 0) {
        setPublishStep("2/2 Depositing gas budget…");
        const depositWei = BigInt(Math.round(parseFloat(gasDeposit) * 1e18));
        const bps        = Math.round(gasSharePct * 100);
        try {
          await wallet.writeContract(
            selectedNet,
            paymasterAddress,
            PAYMASTER_ABI as any,
            "fundAndSetGasShare",
            [url.trim(), bps],
            depositWei
          );
          setDepositDone(true);
        } catch (fundErr: any) {
          setDepositError(fundErr.shortMessage || fundErr.message || String(fundErr));
        }
      }

      setPublishStep("");
    } catch (e: any) {
      const msg = e.shortMessage || e.message || String(e);
      setPublishError(msg);
    } finally {
      setPublishing(false);
      setPublishStep("");
    }
  }

  async function handleRetryDeposit() {
    if (!wallet.state.connected) { await wallet.connect(); return; }
    if (wallet.state.chainId !== NETWORKS[selectedNet].chainId) {
      await wallet.switchNetwork(selectedNet); return;
    }
    setPublishing(true);
    setDepositError(null);
    setPublishStep("Depositing gas budget…");
    try {
      const depositWei = BigInt(Math.round(parseFloat(gasDeposit) * 1e18));
      const bps        = Math.round(gasSharePct * 100);
      await wallet.writeContract(
        selectedNet,
        paymasterAddress,
        PAYMASTER_ABI as any,
        "fundAndSetGasShare",
        [url.trim(), bps],
        depositWei
      );
      setDepositDone(true);
    } catch (e: any) {
      setDepositError(e.shortMessage || e.message || String(e));
    } finally {
      setPublishing(false);
      setPublishStep("");
    }
  }

  const wrongNetwork = wallet.state.connected && wallet.state.chainId !== NETWORKS[selectedNet].chainId;
  const canPublish   = testResult?.ok && !publishing && !publishResult;
  const hasDeposit   = parseFloat(gasDeposit) > 0;
  const depositPending = publishResult && hasDeposit && !depositDone && !depositError;
  const estCalls     = parseFloat(gasDeposit) > 0 ? Math.floor(parseFloat(gasDeposit) / 0.000054) : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>

      {/* ── Network ─────────────────────────────────────────────────────────── */}
      <Field label="Target Network">
        <div style={{
          display: "flex", alignItems: "center", gap: 10,
          padding: "9px 14px", borderRadius: 6,
          background: `${net.color}15`, border: `1px solid ${net.color}`,
        }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: net.color, display: "inline-block", flexShrink: 0 }} />
          <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, color: net.color, fontWeight: 700 }}>
            {net.label}
          </span>
          <span style={{ fontSize: 10, color: net.color, opacity: 0.6, marginLeft: "auto" }}>
            chain {net.chainId}
          </span>
        </div>
      </Field>

      {/* ── Endpoint URL ────────────────────────────────────────────────────── */}
      <Field label="Endpoint URL" hint="— must return 200 or 402">
        <div style={{ display: "flex", gap: 8 }}>
          <input ref={urlRef} type="url" placeholder="https://api.yourservice.com/endpoint"
            value={url} onChange={(e) => { setUrl(e.target.value); setTestResult(null); }}
            onKeyDown={(e) => e.key === "Enter" && handleTest()}
            style={{ ...inputStyle, flex: 1 }} />
          <button onClick={handleTest} disabled={testing || !url.trim()}
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

      {/* ── Test Result ─────────────────────────────────────────────────────── */}
      {testResult && (
        <div style={{
          background: testResult.ok ? "#0a1a0a" : "#1a0a0a",
          border: `1px solid ${testResult.ok ? "#1a3a1a" : "#3a1a1a"}`,
          borderRadius: 8, padding: "14px 16px",
          display: "flex", flexDirection: "column", gap: 10,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 16 }}>{testResult.ok ? "✅" : "❌"}</span>
            <div style={{ flex: 1 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: testResult.ok ? "#4ade80" : "#f87171" }}>
                {testResult.ok
                  ? testResult.isX402 ? "x402 Payment Protected Endpoint" : "Endpoint Reachable"
                  : "Test Failed"}
              </span>
              {testResult.errorMsg && (
                <div style={{ fontSize: 11, color: "#f87171", marginTop: 2 }}>{testResult.errorMsg}</div>
              )}
            </div>
            <span style={{ fontSize: 11, color: "#555" }}>{testResult.latencyMs}ms</span>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 20px" }}>
            {[
              ["HTTP Status", `${testResult.status} ${testResult.statusText}`],
              ["Content-Type", testResult.contentType || "—"],
              testResult.isX402 && testResult.paymentRequired?.price ? ["Price", testResult.paymentRequired.price] : null,
              testResult.isX402 && testResult.paymentRequired?.network ? ["Network", testResult.paymentRequired.network] : null,
            ].filter(Boolean).map((item) => { const [k, v] = item as string[]; return (
              <div key={k} style={{ display: "flex", gap: 6 }}>
                <span style={{ fontSize: 10, color: "#555" }}>{k}</span>
                <span style={{ fontSize: 10, color: "#888" }}>{v}</span>
              </div>
            ); })}
          </div>
          {testResult.bodyPreview && (
            <pre style={{
              margin: 0, fontSize: 10, color: "#555",
              background: "#050505", border: "1px solid #111", borderRadius: 4,
              padding: "8px 10px", maxHeight: 80, overflow: "auto",
              whiteSpace: "pre-wrap", wordBreak: "break-all",
            }}>
              {testResult.bodyPreview}
            </pre>
          )}
        </div>
      )}

      {/* ── Price ───────────────────────────────────────────────────────────── */}
      <Field label="Price per Call" hint="— in USDC">
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 14, color: "#555", paddingLeft: 4 }}>$</span>
          <input type="number" min="0" step="0.001" value={price}
            onChange={(e) => setPrice(e.target.value)}
            style={{ ...inputStyle, width: 120 }} />
          <span style={{ fontSize: 12, color: "#555" }}>USDC</span>
          <span style={{ fontSize: 10, color: "#333", marginLeft: 4 }}>
            = {Math.round(parseFloat(price || "0") * 1_000_000).toLocaleString()} units
          </span>
        </div>
      </Field>

      {/* ── Gas Budget ──────────────────────────────────────────────────────── */}
      <Field label="Your Gas Budget" hint="— ETH you deposit to sponsor agent gas calls">
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>

          {/* Deposit amount */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input type="number" min="0" step="0.001" value={gasDeposit}
              onChange={(e) => setGasDeposit(e.target.value)}
              style={{ ...inputStyle, width: 140 }} />
            <span style={{ fontSize: 12, color: "#555" }}>{net.currency}</span>
            {estCalls > 0 && (
              <span style={{ fontSize: 10, color: "#333" }}>≈ {estCalls.toLocaleString()} sponsored calls</span>
            )}
          </div>

          {/* Gas share slider */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontSize: 10, color: "#444", minWidth: 80 }}>Gas share:</span>
              <input type="range" min={0} max={100} step={5} value={gasSharePct}
                onChange={(e) => setGasSharePct(Number(e.target.value))}
                style={{ flex: 1, accentColor: net.color, cursor: "pointer" }} />
              <div style={{
                minWidth: 48, textAlign: "center",
                fontFamily: "'JetBrains Mono', monospace", fontSize: 15, fontWeight: 700,
                color: gasSharePct >= 75 ? "#4ade80" : gasSharePct >= 40 ? net.color : "#f87171",
              }}>
                {gasSharePct}%
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "#333" }}>
              <span>agent pays all gas</span>
              <span>you pay all gas</span>
            </div>
          </div>

          {/* Callout */}
          <div style={{
            padding: "10px 14px", borderRadius: 6, fontSize: 11, lineHeight: 1.5,
            background: gasSharePct >= 75 ? "#0a1a0a" : gasSharePct >= 40 ? "#0a0f1a" : "#1a0a0a",
            border: `1px solid ${gasSharePct >= 75 ? "#1a3a1a" : gasSharePct >= 40 ? "#1a2a3a" : "#3a1a1a"}`,
          }}>
            {gasSharePct === 100 && <span style={{ color: "#4ade80" }}>🏆 <strong>Maximum appeal</strong> — agents pay zero gas. Most competitive. Your {gasDeposit || "0"} {net.currency} funds ~{estCalls.toLocaleString()} calls.</span>}
            {gasSharePct >= 50 && gasSharePct < 100 && <span style={{ color: net.color }}>⚡ <strong>{gasSharePct}% sponsored</strong> — you cover {gasSharePct}% of gas per call. Budget lasts {(100 / gasSharePct).toFixed(1)}× longer. Agents may prefer 100% endpoints.</span>}
            {gasSharePct > 0 && gasSharePct < 50 && <span style={{ color: "#f59e0b" }}>⚠ <strong>Low sponsorship ({gasSharePct}%)</strong> — agents must cover {100 - gasSharePct}% of gas themselves. Consider increasing to be competitive.</span>}
            {gasSharePct === 0 && <span style={{ color: "#f87171" }}>✗ <strong>No gas sponsorship</strong> — agents need their own {net.currency} wallet. Endpoint will be ignored by most AI agents.</span>}
          </div>

          {/* How it works note */}
          <div style={{ fontSize: 10, color: "#333", lineHeight: 1.6 }}>
            Your {gasDeposit || "0"} {net.currency} deposit goes directly into the paymaster's EntryPoint pool,
            earmarked for this endpoint. Only calls to your endpoint can spend it.
            Set gas share = 100% to maximize agent adoption.
          </div>
        </div>
      </Field>

      {/* ── Paymaster address ───────────────────────────────────────────────── */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "8px 12px", background: "#0a0a0a",
        border: "1px solid #1a1a1a", borderRadius: 6,
      }}>
        <span style={{ fontSize: 10, color: "#444" }}>paymaster</span>
        <span style={{ fontSize: 10, color: "#555", fontFamily: "'JetBrains Mono', monospace", flex: 1 }}>
          {paymasterAddress}
        </span>
        <span style={{ fontSize: 9, color: "#4ade80" }}>staked ✓</span>
      </div>

      {/* ── Wallet + Publish ─────────────────────────────────────────────────── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 4 }}>

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
            <button onClick={wallet.disconnect}
              style={{ marginLeft: "auto", background: "none", border: "none", color: "#444", cursor: "pointer", fontSize: 10, padding: "2px 6px" }}>
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

        <button onClick={handlePublish} disabled={!canPublish}
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
            ? "test endpoint first"
            : !wallet.state.connected
            ? "🔗 connect wallet + publish"
            : wrongNetwork
            ? `switch to ${NETWORKS[selectedNet].label}`
            : parseFloat(gasDeposit) > 0
            ? `publish + fund ${gasDeposit} ${net.currency} gas budget →`
            : "publish on-chain (no gas budget) →"
          }
        </button>

        {publishError && (
          <div style={{
            padding: "10px 12px", borderRadius: 6,
            background: "#1a0a0a", border: "1px solid #3a1a1a",
            fontSize: 11, color: "#f87171",
          }}>
            ❌ {publishError}
          </div>
        )}

        {publishResult && (
          <div style={{
            padding: "14px 16px", borderRadius: 8,
            background: "#0a1a0a", border: "1px solid #1a3a1a",
            display: "flex", flexDirection: "column", gap: 10,
          }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#4ade80" }}>
              ✅ Endpoint registered on-chain
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {[
                ["Network",   NETWORKS[publishResult.networkId].label],
                ["URL",       url],
                ["Price",     "$" + price + " USDC"],
                ["Paymaster", paymasterAddress.slice(0, 14) + "…"],
                ["Reg tx",    publishResult.txHash],
              ].map(([k, v]) => (
                <div key={k} style={{ display: "flex", gap: 8 }}>
                  <span style={{ fontSize: 10, color: "#555", width: 70, flexShrink: 0 }}>{k}</span>
                  <span style={{ fontSize: 10, color: "#888", wordBreak: "break-all" }}>{v}</span>
                </div>
              ))}
            </div>
            <a href={NETWORKS[publishResult.networkId].explorerTx(publishResult.txHash)}
              target="_blank" rel="noreferrer"
              style={{ fontSize: 11, color: net.color }}>
              view registration on HashScan ↗
            </a>

            {/* Deposit status */}
            {hasDeposit && (
              <div style={{
                marginTop: 4, padding: "10px 12px", borderRadius: 6,
                background: depositDone ? "#081a08" : depositError ? "#1a0808" : "#0d0d0d",
                border: `1px solid ${depositDone ? "#1a3a1a" : depositError ? "#3a1a1a" : "#1e1e1e"}`,
                display: "flex", flexDirection: "column", gap: 6,
              }}>
                {depositDone ? (
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#4ade80" }}>
                    ✅ Gas budget deposited — {gasDeposit} {net.currency} ({gasSharePct}% share per call, ~{Math.floor(parseFloat(gasDeposit) / 0.000054).toLocaleString()} sponsored calls)
                  </div>
                ) : depositError ? (
                  <>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#f87171" }}>
                      ❌ Deposit failed
                    </div>
                    <div style={{ fontSize: 11, color: "#f87171", wordBreak: "break-all" }}>
                      {depositError}
                    </div>
                    <div style={{ fontSize: 10, color: "#666", marginTop: 2 }}>
                      Your endpoint is registered but has no gas budget yet. Make sure your wallet has enough {net.currency} (need {gasDeposit} {net.currency} + gas).
                    </div>
                    <button
                      onClick={handleRetryDeposit}
                      disabled={publishing}
                      style={{
                        marginTop: 4, padding: "8px 0",
                        fontFamily: "'JetBrains Mono', monospace", fontSize: 11, fontWeight: 700,
                        borderRadius: 6, cursor: publishing ? "default" : "pointer",
                        border: `1px solid ${net.color}`, background: `${net.color}22`, color: net.color,
                      }}
                    >
                      {publishing ? publishStep || "sending…" : `retry deposit ${gasDeposit} ${net.currency} →`}
                    </button>
                  </>
                ) : (
                  <div style={{ fontSize: 11, color: "#666" }}>
                    ⏳ Depositing {gasDeposit} {net.currency} gas budget…
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
