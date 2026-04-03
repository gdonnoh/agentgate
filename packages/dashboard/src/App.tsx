import { useState } from "react";
import { NetworkId, NETWORKS } from "./lib/chains";
import { useOnChainData } from "./hooks/useOnChainData";
import { NetworkCard } from "./components/NetworkCard";
import { FlowDiagram } from "./components/FlowDiagram";
import { EndpointTable } from "./components/EndpointTable";
import { PublishForm } from "./components/PublishForm";

type View = "dashboard" | "flow" | "publish";

const NETWORK_IDS: NetworkId[] = ["baseSepolia", "hedera"];

export default function App() {
  const [activeNet, setActiveNet] = useState<NetworkId>("baseSepolia");
  const [view, setView]           = useState<View>("dashboard");
  const { data, refetch }         = useOnChainData(activeNet);
  const net = NETWORKS[activeNet];

  return (
    <div className="app">
      {/* ── Header ───────────────────────────────────────────────────────── */}
      <header className="header">
        <div className="header-left">
          <span className="logo">AgentGate</span>
          <span className="logo-sub">Publisher Dashboard</span>
        </div>
        <div className="header-right">
          <span className="live-indicator">
            <span className="live-dot" style={{ background: data.loading ? "#555" : net.color }} />
            live
          </span>
          <button className="refresh-btn" onClick={refetch} title="Refresh">↺</button>
        </div>
      </header>

      {/* ── Network tabs ─────────────────────────────────────────────────── */}
      <div className="tabs">
        {NETWORK_IDS.map((id) => {
          const n = NETWORKS[id];
          const isActive = id === activeNet;
          return (
            <button
              key={id}
              onClick={() => setActiveNet(id)}
              className={`tab ${isActive ? "tab-active" : ""}`}
              style={isActive ? { borderColor: n.color, color: n.color, background: `${n.color}0f` } : {}}
            >
              <span className="tab-dot" style={{ background: isActive ? n.color : "#333" }} />
              {n.label}
              <span className="tab-chain-id" style={{ color: isActive ? n.color : "#333" }}>/{n.chainId}</span>
            </button>
          );
        })}

        {/* View switcher */}
        <div className="view-tabs">
          {(["dashboard", "flow", "publish"] as View[]).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`view-tab ${view === v ? "view-tab-active" : ""}`}
              style={view === v ? { color: net.color, borderColor: net.color + "66" } : {}}
            >
              {v === "dashboard" ? "📊 dashboard" :
               v === "flow"      ? "⚡ flow" :
                                   "➕ publish"}
            </button>
          ))}
        </div>
      </div>

      {/* ── Views ────────────────────────────────────────────────────────── */}

      {view === "dashboard" && (
        <>
          <main className="main-grid">
            <section className="panel">
              <NetworkCard networkId={activeNet} data={data} />
            </section>
            <section className="panel">
              <EndpointTable
                networkId={activeNet}
                endpoints={data.endpoints}
                loading={data.loading}
              />
            </section>
          </main>
        </>
      )}

      {view === "flow" && (
        <section className="panel panel-full">
          <FlowDiagram networkId={activeNet} totalCalls={data.totalCalls} />
        </section>
      )}

      {view === "publish" && (
        <section className="panel panel-narrow">
          <div className="section-header">
            <span className="section-title">Publish New Endpoint</span>
            <span className="section-sub">
              Test your endpoint before registering it on {net.label}
            </span>
          </div>
          <PublishForm networkId={activeNet} />
        </section>
      )}

      {/* ── Footer ───────────────────────────────────────────────────────── */}
      <footer className="footer">
        <span>AgentGate · ERC-4337 Paymaster Infrastructure</span>
        <span>polls every 12s · {net.label} · chainId {net.chainId}</span>
      </footer>

      <style>{`
        .app {
          min-height: 100vh;
          display: flex;
          flex-direction: column;
          max-width: 1100px;
          margin: 0 auto;
          padding: 24px 20px;
          gap: 20px;
        }
        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          border-bottom: 1px solid #1a1a1a;
          padding-bottom: 16px;
        }
        .header-left { display: flex; align-items: baseline; gap: 10px; }
        .logo { font-size: 20px; font-weight: 700; color: #e5e7eb; letter-spacing: -0.5px; }
        .logo-sub { font-size: 11px; color: #444; text-transform: uppercase; letter-spacing: 0.1em; }
        .header-right { display: flex; align-items: center; gap: 12px; }
        .live-indicator {
          display: flex; align-items: center; gap: 6px;
          font-size: 11px; color: #555; text-transform: uppercase; letter-spacing: 0.08em;
        }
        .live-dot {
          width: 7px; height: 7px; border-radius: 50%;
          animation: pulse-live 2s ease-in-out infinite; transition: background 0.5s;
        }
        @keyframes pulse-live { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        .refresh-btn {
          background: none; border: 1px solid #222; color: #555; cursor: pointer;
          font-size: 14px; padding: 4px 8px; border-radius: 4px;
          font-family: 'JetBrains Mono', monospace; transition: all 0.2s;
        }
        .refresh-btn:hover { color: #aaa; border-color: #444; }

        .tabs {
          display: flex;
          align-items: center;
          gap: 8px;
          flex-wrap: wrap;
        }
        .tab {
          display: flex; align-items: center; gap: 7px;
          padding: 7px 14px; background: transparent;
          border: 1px solid #1a1a1a; border-radius: 6px;
          cursor: pointer; font-family: 'JetBrains Mono', monospace;
          font-size: 12px; color: #444; transition: all 0.2s;
        }
        .tab:hover:not(.tab-active) { border-color: #333; color: #888; }
        .tab-dot { width: 6px; height: 6px; border-radius: 50%; transition: background 0.2s; }
        .tab-chain-id { font-size: 10px; transition: color 0.2s; }

        .view-tabs {
          margin-left: auto;
          display: flex;
          gap: 4px;
        }
        .view-tab {
          padding: 6px 12px; background: transparent;
          border: 1px solid #111; border-radius: 5px;
          cursor: pointer; font-family: 'JetBrains Mono', monospace;
          font-size: 11px; color: #333; transition: all 0.2s;
        }
        .view-tab:hover:not(.view-tab-active) { color: #666; border-color: #222; }
        .view-tab-active { background: #111; }

        .main-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 16px;
        }
        @media (max-width: 720px) { .main-grid { grid-template-columns: 1fr; } }

        .panel {
          background: #0d0d0d;
          border: 1px solid #1a1a1a;
          border-radius: 8px;
          padding: 20px;
        }
        .panel-full {
          width: 100%;
        }
        .panel-narrow {
          max-width: 620px;
        }

        .section-header {
          margin-bottom: 20px;
          padding-bottom: 14px;
          border-bottom: 1px solid #1a1a1a;
        }
        .section-title {
          display: block;
          font-size: 15px;
          font-weight: 700;
          color: #e5e7eb;
          margin-bottom: 4px;
        }
        .section-sub {
          font-size: 11px;
          color: #555;
        }

        .footer {
          display: flex;
          justify-content: space-between;
          font-size: 10px;
          color: #2a2a2a;
          padding-top: 8px;
          border-top: 1px solid #111;
        }
      `}</style>
    </div>
  );
}
