import { useEffect, useState } from "react";
import { NetworkId, NETWORKS, DEPLOYMENTS } from "../lib/chains";

interface Props {
  networkId: NetworkId;
  totalCalls: number;
}

interface Field { key: string; value: string; highlight?: boolean }

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
}

function buildSteps(networkId: NetworkId): Step[] {
  const dep = DEPLOYMENTS[networkId];
  const net = NETWORKS[networkId];
  const pm  = dep.paymaster.slice(0, 8) + "…" + dep.paymaster.slice(-4);
  const reg = dep.publisherRegistry.slice(0, 8) + "…" + dep.publisherRegistry.slice(-4);
  const _ep  = dep.entryPoint.slice(0, 8) + "…" + dep.entryPoint.slice(-4);
  void _ep;

  return [
    {
      id: 0,
      from: "AI Agent", fromIcon: "🤖",
      to: "Bundler",    toIcon: "📦",
      label: "UserOperation submitted",
      request: {
        title: "→ UserOperation",
        fields: [
          { key: "sender",          value: dep.deployer.slice(0, 10) + "…" },
          { key: "callData",        value: "callWeather('cannes')", highlight: true },
          { key: "paymasterAndData",value: pm, highlight: true },
          { key: "maxFeePerGas",    value: net.chainId === 296 ? "1020 Gwei" : "0.05 Gwei" },
          { key: "nonce",           value: "0x04" },
        ],
      },
      response: {
        title: "← Acknowledgement",
        fields: [
          { key: "status",         value: "queued" },
          { key: "bundled",        value: "true" },
          { key: "estimatedExec",  value: "~2s" },
        ],
      },
      note: "Agent declares intent. Gas fee will be paid by Paymaster, not agent.",
    },
    {
      id: 1,
      from: "Bundler",        fromIcon: "📦",
      to: "EntryPoint v0.7", toIcon: "⚡",
      label: "handleOps() called",
      request: {
        title: "→ handleOps(userOps[], beneficiary)",
        fields: [
          { key: "ops.length",    value: "1" },
          { key: "beneficiary",   value: dep.deployer.slice(0, 10) + "…" },
          { key: "gasLimit",      value: "3,000,000" },
        ],
      },
      response: {
        title: "← Execution triggered",
        fields: [
          { key: "validates", value: "paymasterAndData ✓" },
          { key: "calls",     value: "validatePaymasterUserOp()" },
        ],
      },
      note: "Bundler submits the batch. EntryPoint orchestrates validation + execution.",
    },
    {
      id: 2,
      from: "EntryPoint v0.7",        fromIcon: "⚡",
      to: "AgentGate Paymaster", toIcon: "🛡️",
      label: "validatePaymasterUserOp()",
      request: {
        title: "→ validatePaymasterUserOp",
        fields: [
          { key: "userOpHash", value: "0xabcd…1234" },
          { key: "maxCost",    value: "0.0003 " + net.currency, highlight: true },
          { key: "sender",     value: dep.deployer.slice(0, 10) + "…" },
        ],
      },
      response: {
        title: "← Validation result",
        fields: [
          { key: "validationData", value: "0 (valid)", highlight: true },
          { key: "context",        value: "abi.encode(sender, hash, maxCost)" },
          { key: "dailyRemaining", value: "0.0097 " + net.currency },
        ],
      },
      note: "Paymaster checks daily budget. Signs off on gas sponsorship.",
    },
    {
      id: 3,
      from: "AgentGate Paymaster", fromIcon: "🛡️",
      to: "PublisherRegistry",   toIcon: "📋",
      label: "endpoint lookup",
      request: {
        title: "→ registeredEndpoints[hash]",
        fields: [
          { key: "key",  value: "keccak256('https://…/weather')", highlight: true },
          { key: "addr", value: reg },
        ],
      },
      response: {
        title: "← Endpoint status",
        fields: [
          { key: "registered", value: "true", highlight: true },
          { key: "active",     value: "true" },
          { key: "paymaster",  value: pm },
        ],
      },
      note: "Paymaster verifies the target endpoint is registered and active.",
    },
    {
      id: 4,
      from: "EntryPoint v0.7", fromIcon: "⚡",
      to: "API Endpoint",    toIcon: "🌐",
      label: "HTTP call executed",
      request: {
        title: "→ GET /api/weather/cannes",
        fields: [
          { key: "X-Payment-Response", value: "eip3009:…signed…", highlight: true },
          { key: "agentkit",           value: "base64:SIWE…proof…" },
          { key: "network",            value: net.label },
        ],
      },
      response: {
        title: "← HTTP 200 OK",
        fields: [
          { key: "city",    value: "Cannes", highlight: true },
          { key: "temp",    value: "22°C" },
          { key: "payment", value: "verified ✓" },
          { key: "gasBy",   value: "Publisher Paymaster", highlight: true },
        ],
      },
      note: "API verifies the x402 payment header and AgentKit proof, returns data.",
    },
    {
      id: 5,
      from: "EntryPoint v0.7",  fromIcon: "⚡",
      to: "AgentGate Paymaster", toIcon: "🛡️",
      label: "postOp() — finalize gas",
      request: {
        title: "→ postOp(mode, context, actualGasCost)",
        fields: [
          { key: "mode",          value: "opSucceeded" },
          { key: "actualGasCost", value: "0.00018 " + net.currency, highlight: true },
          { key: "overpaid",      value: "0.00012 " + net.currency },
        ],
      },
      response: {
        title: "← Stats updated",
        fields: [
          { key: "dailySpent",     value: "+0.00018 " + net.currency },
          { key: "totalCalls",     value: "+1" },
          { key: "overpaidRefund", value: "0.00012 " + net.currency + " → budget", highlight: true },
        ],
      },
      note: "EntryPoint calls postOp with actual cost. Paymaster refunds unused gas to budget.",
    },
    {
      id: 6,
      from: "Bundler",   fromIcon: "📦",
      to: "AI Agent",   toIcon: "🤖",
      label: "Response delivered",
      request: {
        title: "→ ExecutionResult",
        fields: [
          { key: "success",    value: "true", highlight: true },
          { key: "returnData", value: `{ city: "Cannes", temp: 22 }` },
          { key: "gasUsed",    value: "180,000" },
          { key: "gasPaidBy",  value: "AgentGate Paymaster", highlight: true },
          { key: "agentPaid",  value: "0 " + net.currency + " 🎉" },
        ],
      },
      response: {
        title: "← Agent receives data",
        fields: [
          { key: "status",  value: "200 OK" },
          { key: "latency", value: "~2.1s" },
          { key: "cost",    value: "$0.00 gas + $0.01 USDC", highlight: true },
        ],
      },
      note: "Agent gets the API response. Paid $0.01 USDC, zero gas management.",
    },
  ];
}

function PayloadBox({
  title,
  fields,
  color,
  visible,
  delay,
}: {
  title: string;
  fields: Field[];
  color: string;
  visible: boolean;
  delay: number;
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
    <div
      style={{
        flex: 1,
        opacity: show ? 1 : 0,
        transform: show ? "translateY(0)" : "translateY(6px)",
        transition: "opacity 0.3s ease, transform 0.3s ease",
        background: "#090909",
        border: `1px solid ${show ? color + "44" : "#111"}`,
        borderRadius: 6,
        padding: "8px 10px",
        minWidth: 0,
      }}
    >
      <div style={{ fontSize: 10, color, marginBottom: 6, fontWeight: 700, letterSpacing: "0.05em" }}>
        {title}
      </div>
      {fields.map((f) => (
        <div key={f.key} style={{ display: "flex", gap: 6, marginBottom: 3, alignItems: "baseline" }}>
          <span style={{ fontSize: 10, color: "#444", flexShrink: 0, minWidth: 90 }}>{f.key}</span>
          <span
            style={{
              fontSize: 10,
              color: f.highlight ? "#e5e7eb" : "#666",
              fontWeight: f.highlight ? 600 : 400,
              wordBreak: "break-all",
            }}
          >
            {f.value}
          </span>
        </div>
      ))}
    </div>
  );
}

export function FlowDiagram({ networkId, totalCalls }: Props) {
  const [activeStep, setActiveStep] = useState<number>(-1);
  const [pinnedStep, setPinnedStep] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const net = NETWORKS[networkId];
  const steps = buildSteps(networkId);

  const runAnimation = () => {
    if (running) return;
    setPinnedStep(null);
    setRunning(true);
    steps.forEach((_, i) => {
      setTimeout(() => {
        setActiveStep(i);
        if (i === steps.length - 1) {
          setTimeout(() => {
            setActiveStep(-1);
            setRunning(false);
          }, 1200);
        }
      }, i * 900);
    });
  };

  useEffect(() => {
    const t = setTimeout(runAnimation, 600);
    return () => clearTimeout(t);
  }, [networkId]);

  useEffect(() => {
    if (totalCalls > 0) runAnimation();
  }, [totalCalls]);

  const displayStep = pinnedStep !== null ? pinnedStep : activeStep;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", color: "#555" }}>
          ERC-4337 Gas Sponsorship Flow
        </span>
        <div style={{ display: "flex", gap: 6 }}>
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
              border: `1px solid ${running ? "#333" : net.color}`,
              borderRadius: 4, color: running ? "#555" : net.color, cursor: running ? "default" : "pointer",
              transition: "all 0.2s",
            }}
          >
            {running ? "▶ running…" : "▶ simulate"}
          </button>
        </div>
      </div>

      {/* Step list */}
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {steps.map((step, i) => {
          const isActive = displayStep === i;
          const isDone = !running ? false : activeStep > i;
          const isPinned = pinnedStep === i;

          return (
            <div key={step.id}>
              {/* Step row */}
              <div
                onClick={() => setPinnedStep(isPinned ? null : i)}
                style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "8px 12px",
                  border: `1px solid ${isActive ? net.color : isDone ? "#222" : "#181818"}`,
                  borderRadius: 6,
                  background: isActive ? `${net.color}0d` : isDone ? "#0e0e0e" : "#0a0a0a",
                  boxShadow: isActive ? `0 0 12px ${net.color}33` : "none",
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
                  background: isActive ? net.color : isDone ? "#1e1e1e" : "#111",
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
                  <span style={{ fontSize: 10, color: isActive ? net.color : "#333" }}>→</span>
                  <span style={{ fontSize: 13 }}>{step.toIcon}</span>
                  <span style={{ fontSize: 10, color: isActive ? "#aaa" : "#444", whiteSpace: "nowrap" }}>
                    {step.to}
                  </span>
                </div>

                {/* Label */}
                <span style={{
                  fontSize: 11, fontWeight: 600, flexShrink: 0,
                  color: isActive ? net.color : isDone ? "#555" : "#333",
                  transition: "color 0.25s",
                }}>
                  {step.label}
                </span>

                {/* Expand hint */}
                <span style={{ fontSize: 9, color: "#2a2a2a", flexShrink: 0 }}>
                  {isPinned ? "▲" : "▼"}
                </span>

                {/* Pulse dot */}
                {isActive && (
                  <div style={{
                    width: 6, height: 6, borderRadius: "50%",
                    background: net.color, flexShrink: 0,
                    animation: "pulse-dot 0.8s ease-in-out infinite",
                  }} />
                )}
              </div>

              {/* Expanded payload — shown when active or pinned */}
              {isActive && (
                <div style={{
                  margin: "4px 0 4px 30px",
                  display: "flex", flexDirection: "column", gap: 6,
                }}>
                  {/* Note */}
                  <div style={{
                    fontSize: 10, color: "#555", fontStyle: "italic",
                    padding: "4px 10px",
                    borderLeft: `2px solid ${net.color}55`,
                  }}>
                    {step.note}
                  </div>
                  {/* Request + Response */}
                  <div style={{ display: "flex", gap: 8 }}>
                    <PayloadBox
                      title={step.request.title}
                      fields={step.request.fields}
                      color={net.color}
                      visible={isActive}
                      delay={0}
                    />
                    <PayloadBox
                      title={step.response.title}
                      fields={step.response.fields}
                      color="#4ade80"
                      visible={isActive}
                      delay={450}
                    />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <style>{`
        @keyframes pulse-dot {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.4; transform: scale(0.6); }
        }
      `}</style>
    </div>
  );
}
