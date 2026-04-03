import { EndpointData } from "../hooks/useOnChainData";
import { NetworkId, NETWORKS } from "../lib/chains";

interface Props {
  networkId: NetworkId;
  endpoints: EndpointData[];
  loading: boolean;
}

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function EndpointTable({ networkId, endpoints, loading }: Props) {
  const net = NETWORKS[networkId];

  return (
    <div className="ep-table">
      <div className="ep-header">
        <span className="ep-title">Registered Endpoints</span>
        <span className="ep-count" style={{ color: net.color }}>
          {loading ? "…" : endpoints.length} endpoint{endpoints.length !== 1 ? "s" : ""}
        </span>
      </div>

      {loading ? (
        <div className="ep-loading">fetching on-chain data…</div>
      ) : endpoints.length === 0 ? (
        <div className="ep-empty">No endpoints registered</div>
      ) : (
        <div className="ep-rows">
          {endpoints.map((ep) => (
            <div key={ep.id} className="ep-row">
              <div className="ep-row-main">
                <div className="ep-row-left">
                  <span
                    className="ep-active-dot"
                    style={{ background: ep.active ? net.color : "#333" }}
                    title={ep.active ? "Active" : "Inactive"}
                  />
                  <span className="ep-url">{ep.url}</span>
                </div>
                <div className="ep-row-right">
                  <span className="ep-pill">${ep.pricePerCall} USDC/call</span>
                </div>
              </div>
              <div className="ep-row-meta">
                <span className="ep-meta-item">
                  <span className="ep-meta-label">publisher</span>
                  <span className="ep-meta-val">{shortAddr(ep.publisher)}</span>
                </span>
                <span className="ep-meta-item">
                  <span className="ep-meta-label">calls</span>
                  <span className="ep-meta-val">{ep.totalCalls}</span>
                </span>
                <span className="ep-meta-item">
                  <span className="ep-meta-label">revenue</span>
                  <span className="ep-meta-val">${ep.totalRevenue}</span>
                </span>
                <span className="ep-meta-item">
                  <span className="ep-meta-label">paymaster</span>
                  <a
                    href={net.explorerAddr(ep.paymaster)}
                    target="_blank"
                    rel="noreferrer"
                    className="ep-meta-link"
                    style={{ color: net.color }}
                  >
                    {shortAddr(ep.paymaster)} ↗
                  </a>
                </span>
                <span className="ep-meta-item">
                  <span className="ep-meta-label">registered</span>
                  <span className="ep-meta-val">{ep.registeredAt.toLocaleDateString()}</span>
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      <style>{`
        .ep-table {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .ep-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .ep-title {
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.12em;
          color: #444;
        }
        .ep-count {
          font-size: 11px;
          font-weight: 700;
        }
        .ep-loading, .ep-empty {
          font-size: 11px;
          color: #444;
          padding: 12px 0;
          text-align: center;
        }
        .ep-rows {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .ep-row {
          background: #0d0d0d;
          border: 1px solid #1a1a1a;
          border-radius: 6px;
          padding: 10px 14px;
          display: flex;
          flex-direction: column;
          gap: 8px;
          transition: border-color 0.2s;
        }
        .ep-row:hover {
          border-color: #2a2a2a;
        }
        .ep-row-main {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        }
        .ep-row-left {
          display: flex;
          align-items: center;
          gap: 8px;
          flex: 1;
          min-width: 0;
        }
        .ep-active-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .ep-url {
          font-size: 12px;
          color: #ccc;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .ep-row-right {
          flex-shrink: 0;
        }
        .ep-pill {
          font-size: 10px;
          color: #aaa;
          background: #1a1a1a;
          padding: 2px 8px;
          border-radius: 10px;
          border: 1px solid #2a2a2a;
        }
        .ep-row-meta {
          display: flex;
          align-items: center;
          flex-wrap: wrap;
          gap: 12px;
        }
        .ep-meta-item {
          display: flex;
          align-items: center;
          gap: 4px;
        }
        .ep-meta-label {
          font-size: 10px;
          color: #444;
        }
        .ep-meta-val {
          font-size: 10px;
          color: #666;
          font-family: 'JetBrains Mono', monospace;
        }
        .ep-meta-link {
          font-size: 10px;
          font-family: 'JetBrains Mono', monospace;
          text-decoration: none;
        }
        .ep-meta-link:hover { opacity: 0.75; }
      `}</style>
    </div>
  );
}
