import { useState, useRef, useEffect, useCallback } from "react";
import { createPublicClient, http } from "viem";
import { NetworkId, NETWORKS, DEPLOYMENTS, hederaTestnet } from "../lib/chains";
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
  txHash:     string;
  networkId:  NetworkId;
  endpointId: number;
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

/** Accepts `0.03` or locale `0,03` — plain parseFloat would yield 0 for the latter. */
function parseDecimalInput(raw: string): number {
  const s = String(raw).trim().replace(/\s/g, "").replace(/,/g, ".");
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : NaN;
}

const inputStyle: React.CSSProperties = {
  background: "#0d0d0d", border: "1px solid #252525", borderRadius: 6,
  color: "#e5e7eb", fontFamily: "'JetBrains Mono', monospace", fontSize: 12,
  padding: "9px 12px", outline: "none", width: "100%",
  boxSizing: "border-box", transition: "border-color 0.2s",
};

const NEXT_ENDPOINT_ID_ABI = [
  { name: "nextEndpointId", type: "function", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
] as const;

/** Base URL agents use (on-chain URL / paymaster). */
function publicAgentGateBase(): string {
  return (import.meta.env.VITE_SERVER_URL || "http://localhost:4021").replace(/\/$/, "");
}

/** Health check URL: in dev without VITE_SERVER_URL, use same-origin + Vite proxy (avoids CORS). */
function healthCheckUrl(): string {
  if (import.meta.env.DEV && !import.meta.env.VITE_SERVER_URL) {
    return "/health";
  }
  return `${publicAgentGateBase()}/health`;
}

type DemoTemplate = "vacation" | "article";

export function PublishForm({
  networkId,
  demoTemplate,
  onDemoTemplateConsumed,
}: {
  networkId: NetworkId;
  demoTemplate?: DemoTemplate | null;
  onDemoTemplateConsumed?: () => void;
}) {
  const net    = NETWORKS[networkId];
  const wallet = useWallet();

  const [url,           setUrl]           = useState("");
  const [price,         setPrice]         = useState("0.01");
  const [gasSharePct,   setGasSharePct]   = useState(100);    // 0–100%
  const [gasDeposit,    setGasDeposit]    = useState("0.005"); // ETH to deposit
  const [selectedNet] = useState<NetworkId>("hedera");

  // Live gas price from Hedera RPC (wei). Used to estimate sponsored calls.
  // A typical Hedera EVM call uses ~50,000–80,000 gas; we use 65,000 as the midpoint.
  const [gasPrice,      setGasPrice]      = useState<bigint>(1_200_000_000_000n); // 1200 Gwei fallback

  // Proxy Mode — always on (all endpoints go through AgentGate, guaranteeing x402 + WorldID)
  const proxyEnabled = true;
  const [backendUrl,    setBackendUrl]    = useState("");
  const [headerRows,    setHeaderRows]    = useState<{key: string; val: string}[]>([{ key: "", val: "" }]);
  const [proxyDone,     setProxyDone]     = useState<string | null>(null); // proxyUrl
  const [proxyError,    setProxyError]    = useState<string | null>(null);

  const [testing,       setTesting]       = useState(false);
  const [testResult,    setTestResult]    = useState<TestResult | null>(null);
  const [publishing,    setPublishing]    = useState(false);
  const [publishStep,   setPublishStep]   = useState("");
  const [publishResult, setPublishResult] = useState<PublishResult | null>(null);
  const [publishError,  setPublishError]  = useState<string | null>(null);
  const [depositError,  setDepositError]  = useState<string | null>(null);
  const [depositDone,   setDepositDone]   = useState(false);

  const urlRef = useRef<HTMLInputElement>(null);

  const applyDemoPreset = useCallback((t: DemoTemplate) => {
    setTestResult(null);
    setPublishResult(null);
    setPublishError(null);
    setDepositError(null);
    setProxyDone(null);
    setProxyError(null);
    if (t === "vacation") {
      setBackendUrl("https://api.anthropic.com/v1/messages");
      setPrice("0.02");
      setUrl(""); // filled by useEffect: …/api/proxy/<nextId>
      setHeaderRows([
        { key: "x-api-key", val: "" },
        { key: "anthropic-version", val: "2023-06-01" },
      ]);
    } else {
      setBackendUrl("https://jsonplaceholder.typicode.com/todos/1");
      setPrice("0.03");
      setUrl("");
      setHeaderRows([{ key: "", val: "" }]);
    }
  }, []);

  useEffect(() => {
    if (!demoTemplate) return;
    applyDemoPreset(demoTemplate);
    onDemoTemplateConsumed?.();
  }, [demoTemplate, applyDemoPreset, onDemoTemplateConsumed]);

  // Proxy mode: on-chain URL must match paymaster funding — use next registry id (no fake third-party URL).
  useEffect(() => {
    if (!proxyEnabled) return;
    let cancelled = false;
    (async () => {
      try {
        const registryClient = createPublicClient({
          chain: hederaTestnet,
          transport: http(NETWORKS[selectedNet].rpc),
        });
        const nextId = await registryClient.readContract({
          address:   DEPLOYMENTS[selectedNet].publisherRegistry,
          abi:       NEXT_ENDPOINT_ID_ABI,
          functionName: "nextEndpointId",
        });
        if (cancelled) return;
        const n = Number(nextId as bigint);
        setUrl(`${publicAgentGateBase()}/api/proxy/${n}`);
      } catch {
        /* keep manual url */
      }
    })();
    return () => { cancelled = true; };
  }, [proxyEnabled, selectedNet]);

  // Fetch live gas price from Hedera JSON-RPC relay on mount
  useEffect(() => {
    const client = createPublicClient({ chain: hederaTestnet, transport: http(NETWORKS["hedera"].rpc) });
    client.getGasPrice().then((gp) => setGasPrice(gp)).catch(() => { /* keep fallback */ });
  }, []);

  const paymasterAddress = DEPLOYMENTS[selectedNet].paymaster;

  // ── Test endpoint ─────────────────────────────────────────────────────────
  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    setPublishResult(null);
    setPublishError(null);
    const t0 = Date.now();

    // Proxy: we only verify AgentGate is reachable + backend URL is set — not a random public 200 URL.
    if (proxyEnabled) {
      if (!backendUrl.trim()) {
        setTesting(false);
        setTestResult({
          ok: false, status: 0, statusText: "—", latencyMs: 0, isX402: false, contentType: null, bodyPreview: "",
          errorMsg: "Set Backend URL first (e.g. https://api.openai.com).",
        });
        return;
      }
      try {
        const res = await fetch(healthCheckUrl(), { signal: AbortSignal.timeout(8000) });
        const latencyMs   = Date.now() - t0;
        const contentType = res.headers.get("content-type");
        const ok          = res.status === 200;
        let bodyPreview   = "";
        try {
          bodyPreview = ok
            ? `✓ AgentGate server OK (${publicAgentGateBase()}).\n\nOn-chain URL (paymaster/registry): ${url.trim() || "(loading…)"}\nBackend (OpenAI, Anthropic, …): ${backendUrl.trim()}\n\nAfter publish, agents pay x402 → AgentGate forwards to your backend with injected headers.`
            : await res.text();
        } catch { bodyPreview = ""; }
        setTestResult({
          ok,
          status: res.status,
          statusText: res.statusText,
          latencyMs,
          isX402: false,
          contentType,
          bodyPreview,
          errorMsg: ok ? undefined : `Health check failed — is the server running? (${res.status})`,
        });
      } catch (e: any) {
        setTestResult({
          ok: false, status: 0, statusText: "Error", latencyMs: Date.now() - t0,
          isX402: false, contentType: null, bodyPreview: "",
          errorMsg: e.name === "TimeoutError"
            ? "Timeout — start AgentGate server (pnpm --filter @agentgate/server dev)"
            : e.message || String(e),
        });
      } finally {
        setTesting(false);
      }
      return;
    }

    if (!url.trim()) { urlRef.current?.focus(); setTesting(false); return; }
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
            let priceStr: string | undefined;
            if (acc?.amount != null) {
              if (acc.network === "eip155:296" || acc.asset === "hbar") {
                const tb = BigInt(String(acc.amount));
                const hbar = Number(tb) / 1e8;
                priceStr = `≈ ${hbar.toFixed(6)} HBAR (USD quote, live rate)`;
              } else {
                priceStr = `$${(Number(acc.amount) / 1e6).toFixed(4)} USD`;
              }
            }
            paymentRequired = {
              price:   priceStr,
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
      // Read nextEndpointId before registering — that will be this endpoint's id
      const registryClient = createPublicClient({ chain: hederaTestnet, transport: http(NETWORKS["hedera"].rpc) });
      const nextId = await registryClient.readContract({
        address: DEPLOYMENTS[selectedNet].publisherRegistry,
        abi: NEXT_ENDPOINT_ID_ABI,
        functionName: "nextEndpointId",
      });
      const endpointId = Number(nextId as bigint);

      // Step 1: Register on PublisherRegistry
      setPublishStep("1/2 Registering endpoint…");
      const priceNum = parseDecimalInput(price);
      if (!Number.isFinite(priceNum) || priceNum < 0) {
        throw new Error("Invalid price — use a decimal number (e.g. 0.03)");
      }
      const priceUnits = BigInt(Math.round(priceNum * 1_000_000));
      const regHash = await wallet.writeContract(
        selectedNet,
        DEPLOYMENTS[selectedNet].publisherRegistry,
        REGISTRY_ABI as any,
        "registerEndpoint",
        [url.trim(), priceUnits, paymasterAddress]
      );

      setPublishResult({ txHash: regHash, networkId: selectedNet, endpointId });

      const gasNum = parseDecimalInput(gasDeposit);
      const totalSteps = (Number.isFinite(gasNum) && gasNum > 0 ? 1 : 0) + (proxyEnabled && backendUrl.trim() ? 1 : 0) + 1;
      let step = 1;

      // Step 2 (optional): Fund gas budget on the Paymaster
      if (Number.isFinite(gasNum) && gasNum > 0) {
        step++;
        setPublishStep(`${step}/${totalSteps} Depositing gas budget…`);
        const depositWei = BigInt(Math.round(gasNum * 1e18));
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

      // Step 3 (optional): Activate proxy config
      if (proxyEnabled && backendUrl.trim()) {
        step++;
        setPublishStep(`${step}/${totalSteps} Activating proxy…`);
        try {
          const SERVER = import.meta.env.VITE_SERVER_URL || "http://localhost:4021";
          const injectHeaders: Record<string, string> = {};
          for (const row of headerRows) {
            if (row.key.trim()) injectHeaders[row.key.trim()] = row.val.trim();
          }
          const timestamp = Date.now();
          const message   = `AgentGate proxy config\nendpointId: ${endpointId}\nbackendUrl: ${backendUrl.trim()}\ntimestamp: ${timestamp}`;
          const signature = await (window as any).ethereum.request({
            method: "personal_sign",
            params: [message, wallet.state.address],
          });
          const res = await fetch(`${SERVER}/api/publisher/proxy-config`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              endpointId, backendUrl: backendUrl.trim(),
              injectHeaders, walletAddress: wallet.state.address,
              signature, timestamp,
            }),
          });
          const data = await res.json() as any;
          if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
          setProxyDone(data.proxyUrl);
        } catch (proxyErr: any) {
          setProxyError(proxyErr.message || String(proxyErr));
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
      const depositWei = BigInt(Math.round(parseDecimalInput(gasDeposit) * 1e18));
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
  const gasDepositNum = parseDecimalInput(gasDeposit);
  const priceInputNum = parseDecimalInput(price || "0");
  const registryUnits = Number.isFinite(priceInputNum) ? Math.round(priceInputNum * 1_000_000) : 0;
  const hasDeposit    = Number.isFinite(gasDepositNum) && gasDepositNum > 0;

  // Real estimate: deposit (wei) / cost-per-call (wei)
  // cost-per-call = gasPrice × ~65,000 gas (typical EVM contract call on Hedera)
  const GAS_PER_CALL  = 65_000n;
  const costPerCallWei = gasPrice * GAS_PER_CALL;
  const depositWei     = hasDeposit
    ? BigInt(Math.round(gasDepositNum * 1e18))
    : 0n;
  const estCalls       = costPerCallWei > 0n && depositWei > 0n
    ? Number(depositWei / costPerCallWei)
    : 0;

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

      {/* ── Demo presets (sponsor stories) ──────────────────────────────────── */}
      <div style={{
        display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8,
        padding: "10px 12px", borderRadius: 6, background: "#080808", border: "1px solid #1a1a1a",
      }}>
        <span style={{ fontSize: 10, color: "#444", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          Demo preset
        </span>
        <button
          type="button"
          onClick={() => applyDemoPreset("vacation")}
          style={{
            padding: "6px 10px", borderRadius: 5, border: `1px solid ${net.color}44`,
            background: `${net.color}12`, color: net.color, cursor: "pointer",
            fontFamily: "'JetBrains Mono', monospace", fontSize: 10, fontWeight: 600,
          }}
        >
          🏖 idle API resale
        </button>
        <button
          type="button"
          onClick={() => applyDemoPreset("article")}
          style={{
            padding: "6px 10px", borderRadius: 5, border: "1px solid #2a2a2a",
            background: "#111", color: "#888", cursor: "pointer",
            fontFamily: "'JetBrains Mono', monospace", fontSize: 10, fontWeight: 600,
          }}
        >
          📰 pay per article
        </button>
        <span style={{ fontSize: 9, color: "#333", flex: "1 1 180px", minWidth: 0, lineHeight: 1.4 }}>
          Proxy mode: AgentGate assigns you a <code style={{ color: "#555" }}>/api/proxy/&lt;id&gt;</code> URL and forwards paid requests to your backend with injected auth headers.
        </span>
      </div>

      {/* ── Backend URL + headers ───────────────────────────────────────────── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12,
        padding: "14px 16px", borderRadius: 8, background: "#080808", border: "1px solid #1e1e1e" }}>

          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <span style={{ fontSize: 10, color: "#888", textTransform: "uppercase", letterSpacing: "0.08em" }}>
              Backend URL <span style={{ color: "#444", textTransform: "none", letterSpacing: 0 }}>(OpenAI, Anthropic, your API…)</span>
            </span>
            <input
              type="url"
              placeholder="https://api.openai.com/v1/chat/completions"
              value={backendUrl}
              onChange={(e) => setBackendUrl(e.target.value)}
              style={inputStyle}
            />
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 10, color: "#888", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                Auth Headers <span style={{ color: "#444", textTransform: "none", letterSpacing: 0 }}>(injected server-side, never exposed to agents)</span>
              </span>
              <button
                onClick={() => setHeaderRows((r) => [...r, { key: "", val: "" }])}
                style={{ background: "none", border: "1px solid #252525", color: "#555", fontSize: 10, padding: "2px 8px", borderRadius: 4, cursor: "pointer" }}
              >
                + add
              </button>
            </div>
            {headerRows.map((row, i) => (
              <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  placeholder="Authorization"
                  value={row.key}
                  onChange={(e) => setHeaderRows((r) => r.map((x, j) => j === i ? { ...x, key: e.target.value } : x))}
                  style={{ ...inputStyle, width: "35%", fontSize: 11 }}
                />
                <span style={{ color: "#333", fontSize: 12 }}>:</span>
                <input
                  placeholder="Bearer sk-..."
                  value={row.val}
                  onChange={(e) => setHeaderRows((r) => r.map((x, j) => j === i ? { ...x, val: e.target.value } : x))}
                  style={{ ...inputStyle, flex: 1, fontSize: 11 }}
                />
                {headerRows.length > 1 && (
                  <button
                    onClick={() => setHeaderRows((r) => r.filter((_, j) => j !== i))}
                    style={{ background: "none", border: "none", color: "#555", cursor: "pointer", fontSize: 14 }}
                  >×</button>
                )}
              </div>
            ))}
          </div>

          {/* Auto-generated on-chain URL */}
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <span style={{ fontSize: 10, color: "#444", textTransform: "uppercase", letterSpacing: "0.08em" }}>
              Your AgentGate URL <span style={{ color: "#333", textTransform: "none", letterSpacing: 0 }}>(auto-assigned, registered on-chain)</span>
            </span>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input ref={urlRef} type="url" value={url}
                onChange={(e) => { setUrl(e.target.value); setTestResult(null); }}
                placeholder={`${publicAgentGateBase()}/api/proxy/…`}
                style={{ ...inputStyle, flex: 1, color: "#4ade80", fontSize: 11 }} />
              <button
                onClick={handleTest}
                disabled={testing}
                style={{
                  padding: "9px 14px", fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
                  borderRadius: 6, cursor: testing ? "default" : "pointer",
                  background: testing ? "#111" : `${net.color}22`,
                  border: `1px solid ${testing ? "#333" : net.color}`,
                  color: testing ? "#555" : net.color,
                  whiteSpace: "nowrap", transition: "all 0.2s", flexShrink: 0,
                }}
              >
                {testing ? "testing…" : "▶ test server"}
              </button>
            </div>
          </div>
        </div>

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
      <Field label="Price per Call" hint="— quoted in USD; agents pay native HBAR (Mirror rate)">
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 14, color: "#555", paddingLeft: 4 }}>$</span>
          <input type="number" min="0" step="0.001" value={price}
            onChange={(e) => setPrice(e.target.value)}
            style={{ ...inputStyle, width: 120 }} />
          <span style={{ fontSize: 12, color: "#555" }}>USD</span>
          <span style={{ fontSize: 10, color: "#333", marginLeft: 4 }}>
            = {registryUnits.toLocaleString()} registry units (6 decimals)
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
            : proxyEnabled && backendUrl.trim()
            ? hasDeposit
              ? `publish + fund ${gasDeposit} ${net.currency} + activate proxy →`
              : "publish + activate proxy →"
            : hasDeposit
            ? `publish + fund ${gasDeposit} ${net.currency} gas budget →`
            : "publish on-chain →"
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
                ["Price",     "$" + price + " USD (settled in HBAR)"],
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

            {/* Proxy result (shown after auto-activation) */}
            {proxyEnabled && proxyDone && (
              <div style={{
                padding: "12px 14px", borderRadius: 6,
                background: "#081a08", border: "1px solid #1a3a1a",
                display: "flex", flexDirection: "column", gap: 6,
              }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#4ade80" }}>🔀 Proxy active</div>
                <div style={{ fontSize: 11, color: "#666" }}>Agents pay HBAR to call:</div>
                <code style={{
                  fontSize: 11, color: net.color, wordBreak: "break-all",
                  background: "#0a0a0a", padding: "6px 10px", borderRadius: 4,
                }}>
                  {(import.meta.env.VITE_SERVER_URL || "http://localhost:4021")}{proxyDone}
                </code>
                <div style={{ fontSize: 10, color: "#444" }}>
                  Forwards to <strong style={{ color: "#666" }}>{backendUrl}</strong>. Your API key is never exposed.
                </div>
              </div>
            )}
            {proxyEnabled && proxyError && !proxyDone && (
              <div style={{
                padding: "10px 12px", borderRadius: 6,
                background: "#1a0a0a", border: "1px solid #3a1a1a",
                fontSize: 11, color: "#f87171", wordBreak: "break-all",
              }}>
                ⚠ Proxy config failed: {proxyError} — go to the Manage tab to retry.
              </div>
            )}

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
                    ✅ Gas budget deposited — {gasDeposit} {net.currency} ({gasSharePct}% share per call, ~{estCalls.toLocaleString()} sponsored calls)
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
