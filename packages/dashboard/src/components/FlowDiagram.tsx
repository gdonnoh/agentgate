import { useEffect, useRef, useState } from "react";
import { NetworkId, NETWORKS, DEPLOYMENTS } from "../lib/chains";
import { useGasSponsoredEvents, type GasSponsoredEvent } from "../hooks/useGasSponsoredEvents";

interface Props {
  networkId: NetworkId;
  totalCalls: number;
}

interface Field {
  key: string;
  value: string;
  highlight?: boolean;
  live?: boolean; // marks fields pulled from a real on-chain event
}

interface Step {
  id: number;
  from: string;
  fromIcon: string;
  to: string;
  toIcon: string;
  label: string;
  request: { title: string; fields: Field[] };
  response: { title: string; fields: Field[] };
  note: string;
  hasLiveData?: boolean;
}

function fmt(addr: string) { return addr.slice(0, 10) + "…" + addr.slice(-4); }

function buildSteps(
  networkId: NetworkId,
  ev: GasSponsoredEvent | null
): Step[] {
  const dep    = DEPLOYMENTS[networkId];
  const isLive = ev !== null;

  const agentAddr  = isLive ? fmt(ev!.agent)   : "0x05a7Ae…69b0";
  const serverAddr = fmt(dep.deployer);
  const reg        = fmt(dep.publisherRegistry);
  const txHash     = isLive ? fmt(ev!.txHash)  : "0xb1747a…de5f";
  const txId       = isLive ? fmt(ev!.txHash)  : "0.0.578921@1743811432.000";
  const tinybars   = isLive ? ev!.gasUsed.toLocaleString() : "107";
  const hbarAmt    = isLive ? (Number(ev!.gasUsed) / 1e8).toFixed(7) : "0.0000107";

  return [
    // ── 1. Initial request (no payment) ──────────────────────────────────────
    {
      id: 0,
      from: "AI Agent", fromIcon: "🤖",
      to: "AgentGate Server", toIcon: "🌐",
      label: "GET /api/weather/milan",
      hasLiveData: false,
      request: {
        title: "→ HTTP GET (no payment yet)",
        fields: [
          { key: "method",  value: "GET",                  highlight: true },
          { key: "path",    value: "/api/weather/milan",   highlight: true },
          { key: "headers", value: "(none)" },
          { key: "agent",   value: agentAddr,              live: isLive },
        ],
      },
      response: {
        title: "← 402 Payment Required",
        fields: [
          { key: "status",    value: "402 Payment Required", highlight: true },
          { key: "payTo",     value: serverAddr },
          { key: "amount",    value: `${tinybars} tinybars (~$0.01)`, highlight: true },
          { key: "paymentId", value: `x402-${txId.slice(0, 14)}` },
          { key: "network",   value: "eip155:296 (Hedera Testnet)" },
        ],
      },
      note: "x402 protocol: server responds with 402 and payment terms — recipient address, amount in tinybars, and a unique paymentId.",
    },

    // ── 2. Agent sends HBAR ──────────────────────────────────────────────────
    {
      id: 1,
      from: "AI Agent", fromIcon: "🤖",
      to: "Hedera Network", toIcon: "🌿",
      label: "CryptoTransfer — pay HBAR",
      hasLiveData: isLive,
      request: {
        title: "→ sendTransaction() on Hedera",
        fields: [
          { key: "to",       value: serverAddr,            highlight: true },
          { key: "value",    value: `${tinybars} tinybars (${hbarAmt} HBAR)`, highlight: true, live: isLive },
          { key: "chain",    value: "Hedera Testnet (296)" },
          { key: "gasPrice", value: "1200 Gwei" },
        ],
      },
      response: {
        title: "← consensus reached",
        fields: [
          { key: "txHash",    value: txHash,   highlight: true, live: isLive },
          { key: "txId",      value: txId,                      live: isLive },
          { key: "status",    value: "SUCCESS ✓",               highlight: true },
          { key: "finality",  value: isLive ? "confirmed" : "~3s" },
        ],
      },
      note: "Agent signs and broadcasts a native HBAR transfer using viem. Hedera reaches finality in ~3 seconds.",
    },

    // ── 3. Retry with payment proof ──────────────────────────────────────────
    {
      id: 2,
      from: "AI Agent", fromIcon: "🤖",
      to: "AgentGate Server", toIcon: "🌐",
      label: "Retry + PAYMENT-SIGNATURE header",
      hasLiveData: isLive,
      request: {
        title: "→ GET /api/weather/milan (retry)",
        fields: [
          { key: "method",            value: "GET" },
          { key: "path",              value: "/api/weather/milan" },
          { key: "PAYMENT-SIGNATURE", value: `${txId}:${tinybars}:timestamp`, highlight: true, live: isLive },
          { key: "agentkit",          value: "base64(SIWE WorldID proof)" },
        ],
      },
      response: {
        title: "← server verifying…",
        fields: [
          { key: "step 1", value: "parse tx ID from PAYMENT-SIGNATURE" },
          { key: "step 2", value: "query Hedera Mirror Node" },
          { key: "step 3", value: "check amount ≥ required" },
          { key: "status", value: "verifying ⏳" },
        ],
      },
      note: "Agent retries the same request with a PAYMENT-SIGNATURE header containing the Hedera tx ID, amount, and timestamp. Server begins verification.",
    },

    // ── 4. Mirror Node verification ──────────────────────────────────────────
    {
      id: 3,
      from: "AgentGate Server", fromIcon: "🌐",
      to: "Hedera Mirror Node", toIcon: "🔍",
      label: "Verify tx on Mirror Node",
      hasLiveData: isLive,
      request: {
        title: "→ GET /api/v1/transactions/{txId}",
        fields: [
          { key: "txId",     value: txId,      highlight: true, live: isLive },
          { key: "expected", value: `to=${serverAddr}, amount≥${tinybars}` },
        ],
      },
      response: {
        title: "← payment confirmed ✓",
        fields: [
          { key: "result",    value: "SUCCESS",         highlight: true },
          { key: "amount",    value: `${tinybars} tinybars`, highlight: true, live: isLive },
          { key: "to",        value: serverAddr },
          { key: "from",      value: agentAddr,          live: isLive },
          { key: "timestamp", value: isLive ? "confirmed" : "2026-04-03T18:22:45Z" },
        ],
      },
      note: "Server queries Hedera Mirror Node REST API to confirm the transaction is final, the amount is correct, and the recipient address matches.",
    },

    // ── 5. Proxy forwarding (if configured) ──────────────────────────────────
    {
      id: 4,
      from: "AgentGate Server", fromIcon: "🌐",
      to: "Upstream API", toIcon: "☁️",
      label: "(proxy mode) forward to real API",
      hasLiveData: false,
      request: {
        title: "→ forwarded request",
        fields: [
          { key: "to",        value: "api.open-meteo.com",      highlight: true },
          { key: "path",      value: "/v1/forecast?lat=45.46&lon=9.19" },
          { key: "x-api-key", value: "sk-•••••••••  (injected)", highlight: true },
          { key: "note",      value: "key never exposed to agent" },
        ],
      },
      response: {
        title: "← upstream 200 OK",
        fields: [
          { key: "status",      value: "200 OK ✓", highlight: true },
          { key: "temperature", value: "18°C",      highlight: true },
          { key: "condition",   value: "Partly Cloudy" },
          { key: "humidity",    value: "62%" },
        ],
      },
      note: "Proxy mode: server forwards the request to the real backend, injecting the publisher's private API key server-side. Skipped for direct endpoints.",
    },

    // ── 6. Record call on-chain ──────────────────────────────────────────────
    {
      id: 5,
      from: "AgentGate Server", fromIcon: "🌐",
      to: "PublisherRegistry", toIcon: "📋",
      label: "recordCall() on Hedera",
      hasLiveData: isLive,
      request: {
        title: "→ recordCall(endpointId, caller, revenue)",
        fields: [
          { key: "endpointId", value: "5" },
          { key: "caller",     value: agentAddr,       live: isLive },
          { key: "revenue",    value: "10000 (=$0.01 USDC)" },
          { key: "registry",   value: reg },
        ],
      },
      response: {
        title: "← stats updated on-chain",
        fields: [
          { key: "totalCalls",   value: "+1",    highlight: true },
          { key: "totalRevenue", value: "+$0.01", highlight: true },
          { key: "event",        value: "CallRecorded ✓" },
          { key: "txHash",       value: txHash, live: isLive },
        ],
      },
      note: "Server records the call in the PublisherRegistry on Hedera. Publisher's revenue accumulates immutably on-chain.",
    },

    // ── 7. Final 200 response to agent ──────────────────────────────────────
    {
      id: 6,
      from: "AgentGate Server", fromIcon: "🌐",
      to: "AI Agent", toIcon: "🤖",
      label: "200 OK — data delivered",
      hasLiveData: isLive,
      request: {
        title: "← 200 OK",
        fields: [
          { key: "status",  value: "200 OK ✓",    highlight: true },
          { key: "body",    value: `{"city":"Milan","temp":18,"condition":"Partly Cloudy"}`, highlight: true },
          { key: "X-Paid",  value: `${hbarAmt} HBAR (tx: ${txHash})`, live: isLive },
        ],
      },
      response: {
        title: "← agent receives",
        fields: [
          { key: "cost",    value: `$0.01 = ${tinybars} tinybars HBAR`, highlight: true, live: isLive },
          { key: "gas",     value: "sponsored by publisher 🎉",          highlight: true },
          { key: "latency", value: isLive ? "on-chain ✓" : "~3.2s total" },
          { key: "proof",   value: "Hedera Mirror Node verified ✓" },
        ],
      },
      note: isLive
        ? `Verified on Hedera. TX: ${txHash}. Agent paid ${hbarAmt} HBAR — zero gas.`
        : "Agent gets real data. Paid $0.01 in HBAR, zero gas thanks to publisher sponsorship.",
    },
  ];
}

function PayloadBox({
  title, fields, color, visible, delay,
}: {
  title: string; fields: Field[]; color: string; visible: boolean; delay: number;
}) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (visible) {
      const t = setTimeout(() => setShow(true), delay);
      return () => clearTimeout(t);
    } else {
      setShow(false);
    }
  }, [visible, delay]);

  return (
    <div style={{
      flex: 1,
      opacity: show ? 1 : 0,
      transform: show ? "translateY(0)" : "translateY(6px)",
      transition: "opacity 0.3s ease, transform 0.3s ease",
      background: "#090909",
      border: `1px solid ${show ? color + "44" : "#111"}`,
      borderRadius: 6,
      padding: "8px 10px",
      minWidth: 0,
    }}>
      <div style={{ fontSize: 10, color, marginBottom: 6, fontWeight: 700, letterSpacing: "0.05em" }}>
        {title}
      </div>
      {fields.map((f) => (
        <div key={f.key} style={{ display: "flex", gap: 6, marginBottom: 3, alignItems: "baseline" }}>
          <span style={{ fontSize: 10, color: "#444", flexShrink: 0, minWidth: 90 }}>{f.key}</span>
          <span style={{
            fontSize: 10,
            color: f.live ? "#4ade80" : f.highlight ? "#e5e7eb" : "#555",
            fontWeight: f.highlight || f.live ? 600 : 400,
            wordBreak: "break-all",
          }}>
            {f.value}
            {f.live && <span style={{ fontSize: 8, color: "#4ade8088", marginLeft: 4 }}>⚡</span>}
          </span>
        </div>
      ))}
    </div>
  );
}

export function FlowDiagram({ networkId, totalCalls }: Props) {
  const [activeStep, setActiveStep]     = useState<number>(-1);
  const [pinnedStep, setPinnedStep]     = useState<number | null>(null);
  const [running, setRunning]           = useState(false);
  const [liveEvent, setLiveEvent]       = useState<GasSponsoredEvent | null>(null);
  const prevEventsLen                   = useRef(0);
  const net                             = NETWORKS[networkId];

  const { events: liveEvents, latestBlock } = useGasSponsoredEvents(networkId);

  // Use the most recent live event (or null for demo mode)
  const activeEvent = liveEvent;
  const steps       = buildSteps(networkId, activeEvent);
  const isLiveMode  = activeEvent !== null;

  function runAnimation() {
    if (running) return;
    setPinnedStep(null);
    setRunning(true);
    steps.forEach((_, i) => {
      setTimeout(() => {
        setActiveStep(i);
        if (i === steps.length - 1) {
          setTimeout(() => { setActiveStep(-1); setRunning(false); }, 1400);
        }
      }, i * 1000); // 1s per step — feels more realistic than 0.9s
    });
  }

  // Auto-trigger when new real event arrives
  useEffect(() => {
    if (liveEvents.length > prevEventsLen.current) {
      setLiveEvent(liveEvents[0]);
      setTimeout(runAnimation, 200);
    }
    prevEventsLen.current = liveEvents.length;
  }, [liveEvents.length]);

  // Initial demo run on mount / network change
  useEffect(() => {
    const t = setTimeout(runAnimation, 600);
    return () => clearTimeout(t);
  }, [networkId]);

  // Also re-trigger on new totalCalls if no live event yet
  useEffect(() => {
    if (totalCalls > 0 && !isLiveMode) runAnimation();
  }, [totalCalls]);

  const displayStep = pinnedStep !== null ? pinnedStep : activeStep;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", color: "#555" }}>
            x402 Payment Flow — Hedera Testnet
          </span>

          {/* Mode badge */}
          {isLiveMode ? (
            <div style={{
              display: "flex", alignItems: "center", gap: 5,
              padding: "2px 8px", borderRadius: 4,
              background: "#0a1a0a", border: "1px solid #1a3a1a",
            }}>
              <div style={{
                width: 5, height: 5, borderRadius: "50%", background: "#4ade80",
                boxShadow: "0 0 6px #4ade80",
                animation: "pulse-dot 1.5s ease-in-out infinite",
              }} />
              <span style={{ fontSize: 9, color: "#4ade80", fontWeight: 700, letterSpacing: "0.08em" }}>
                LIVE DATA
              </span>
            </div>
          ) : (
            <div style={{
              padding: "2px 8px", borderRadius: 4,
              background: "#111", border: "1px solid #222",
            }}>
              <span style={{ fontSize: 9, color: "#444", letterSpacing: "0.08em" }}>DEMO</span>
            </div>
          )}

          {/* Block number when watching */}
          {networkId === "baseSepolia" && latestBlock > 0n && (
            <span style={{ fontSize: 9, color: "#2a2a2a" }}>
              block #{latestBlock.toString()}
            </span>
          )}
        </div>

        <div style={{ display: "flex", gap: 6 }}>
          {isLiveMode && (
            <button
              onClick={() => { setLiveEvent(null); setPinnedStep(null); }}
              style={{
                fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
                padding: "4px 10px", background: "transparent",
                border: "1px solid #1a3a1a", borderRadius: 4, color: "#4ade80", cursor: "pointer",
              }}
            >
              ← demo
            </button>
          )}
          {pinnedStep !== null && (
            <button
              onClick={() => setPinnedStep(null)}
              style={{
                fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
                padding: "4px 10px", background: "transparent",
                border: "1px solid #333", borderRadius: 4, color: "#555", cursor: "pointer",
              }}
            >
              ✕ unpin
            </button>
          )}
          <button
            onClick={runAnimation}
            disabled={running}
            style={{
              fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
              padding: "4px 10px", background: "transparent",
              border: `1px solid ${running ? "#333" : isLiveMode ? "#1a3a1a" : net.color}`,
              borderRadius: 4,
              color: running ? "#555" : isLiveMode ? "#4ade80" : net.color,
              cursor: running ? "default" : "pointer",
              transition: "all 0.2s",
            }}
          >
            {running ? "▶ running…" : isLiveMode ? "▶ replay last tx" : "▶ simulate"}
          </button>
        </div>
      </div>

      {/* ── Live event banner ─────────────────────────────────────────────── */}
      {isLiveMode && activeEvent && (
        <div style={{
          padding: "8px 14px", borderRadius: 6,
          background: "#060f06", border: "1px solid #1a3a1a",
          display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
        }}>
          <span style={{ fontSize: 10, color: "#4ade80", fontWeight: 700 }}>⚡ REAL ON-CHAIN EVENT</span>
          <span style={{ fontSize: 10, color: "#555" }}>agent: {fmt(activeEvent.agent)}</span>
          <span style={{ fontSize: 10, color: "#555" }}>gas: {activeEvent.gasUsed.toLocaleString()}</span>
          <span style={{ fontSize: 10, color: "#4ade80" }}>{Math.round(activeEvent.sponsorshipBps / 100)}% sponsored</span>
          <a
            href={`https://sepolia.basescan.org/tx/${activeEvent.txHash}`}
            target="_blank" rel="noopener noreferrer"
            style={{ fontSize: 10, color: net.color, marginLeft: "auto", textDecoration: "none" }}
          >
            {fmt(activeEvent.txHash)} ↗
          </a>
        </div>
      )}

      {/* ── Step list ─────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {steps.map((step, i) => {
          const isActive = displayStep === i;
          const isDone   = running && activeStep > i;
          const isPinned = pinnedStep === i;

          return (
            <div key={step.id}>
              <div
                onClick={() => setPinnedStep(isPinned ? null : i)}
                style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "8px 12px",
                  border: `1px solid ${isActive ? (isLiveMode ? "#4ade80" : net.color) : isDone ? "#222" : "#181818"}`,
                  borderRadius: 6,
                  background: isActive ? (isLiveMode ? "#0a1a0a" : `${net.color}0d`) : isDone ? "#0e0e0e" : "#0a0a0a",
                  boxShadow: isActive ? `0 0 12px ${isLiveMode ? "#4ade8022" : net.color + "33"}` : "none",
                  transition: "all 0.25s ease",
                  cursor: "pointer",
                  userSelect: "none",
                }}
              >
                {/* Step number */}
                <div style={{
                  width: 20, height: 20, borderRadius: "50%", flexShrink: 0,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 9, fontWeight: 700,
                  background: isActive ? (isLiveMode ? "#4ade80" : net.color) : isDone ? "#1e1e1e" : "#111",
                  color: isActive ? "#000" : isDone ? "#444" : "#333",
                  transition: "all 0.25s",
                }}>
                  {isDone ? "✓" : i + 1}
                </div>

                {/* From → To */}
                <div style={{ display: "flex", alignItems: "center", gap: 5, flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 13 }}>{step.fromIcon}</span>
                  <span style={{ fontSize: 10, color: isActive ? "#aaa" : "#444", whiteSpace: "nowrap" }}>
                    {step.from}
                  </span>
                  <span style={{ fontSize: 10, color: isActive ? (isLiveMode ? "#4ade80" : net.color) : "#333" }}>→</span>
                  <span style={{ fontSize: 13 }}>{step.toIcon}</span>
                  <span style={{ fontSize: 10, color: isActive ? "#aaa" : "#444", whiteSpace: "nowrap" }}>
                    {step.to}
                  </span>
                </div>

                {/* Label */}
                <span style={{
                  fontSize: 11, fontWeight: 600, flexShrink: 0,
                  color: isActive ? (isLiveMode ? "#4ade80" : net.color) : isDone ? "#555" : "#333",
                  transition: "color 0.25s",
                }}>
                  {step.label}
                </span>

                {/* Live badge on steps with real data */}
                {step.hasLiveData && isLiveMode && (
                  <span style={{ fontSize: 8, color: "#4ade80", flexShrink: 0, opacity: 0.7 }}>⚡</span>
                )}

                <span style={{ fontSize: 9, color: "#2a2a2a", flexShrink: 0 }}>
                  {isPinned ? "▲" : "▼"}
                </span>

                {isActive && (
                  <div style={{
                    width: 6, height: 6, borderRadius: "50%",
                    background: isLiveMode ? "#4ade80" : net.color, flexShrink: 0,
                    animation: "pulse-dot 0.8s ease-in-out infinite",
                  }} />
                )}
              </div>

              {/* Expanded payload */}
              {isActive && (
                <div style={{
                  margin: "4px 0 4px 30px",
                  display: "flex", flexDirection: "column", gap: 6,
                }}>
                  <div style={{
                    fontSize: 10, color: "#555", fontStyle: "italic",
                    padding: "4px 10px",
                    borderLeft: `2px solid ${isLiveMode ? "#4ade8055" : net.color + "55"}`,
                  }}>
                    {step.note}
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <PayloadBox
                      title={step.request.title}
                      fields={step.request.fields}
                      color={isLiveMode ? "#4ade80" : net.color}
                      visible={isActive}
                      delay={0}
                    />
                    <PayloadBox
                      title={step.response.title}
                      fields={step.response.fields}
                      color={isLiveMode ? "#22c55e" : "#4ade80"}
                      visible={isActive}
                      delay={500}
                    />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── How to test ───────────────────────────────────────────────────── */}
      <div style={{
        fontSize: 10, color: "#2a2a2a",
        background: "#080808", border: "1px solid #111", borderRadius: 6,
        padding: "10px 14px", fontFamily: "'JetBrains Mono', monospace",
        borderTop: "1px solid #111", marginTop: 4,
      }}>
        <span style={{ color: "#333" }}>$ </span>
        <span style={{ color: net.color }}>cd packages/agent && npx tsx src/pay-hedera.ts</span>
        <br />
        <span style={{ color: "#333", fontStyle: "italic" }}>
          # runs the full flow above — x402 + HBAR payment + Mirror Node verification
        </span>
      </div>

      <style>{`
        @keyframes pulse-dot {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.4; transform: scale(0.6); }
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(-4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}
