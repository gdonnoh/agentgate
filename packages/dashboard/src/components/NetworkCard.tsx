import { NetworkId, NETWORKS, DEPLOYMENTS } from "../lib/chains";
import { OnChainData } from "../hooks/useOnChainData";

interface Props {
  networkId: NetworkId;
  data: OnChainData;
}

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function StatRow({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat-row">
      <span className="stat-label">{label}</span>
      <span className="stat-value">
        {value}
        {sub && <span className="stat-sub"> {sub}</span>}
      </span>
    </div>
  );
}

function AddrRow({
  label,
  addr,
  txHash,
  explorerAddr,
  explorerTx,
  net,
}: {
  label: string;
  addr: string;
  txHash?: string;
  explorerAddr: (a: string) => string;
  explorerTx: (h: string) => string;
  net: typeof NETWORKS[NetworkId];
}) {
  const copy = (text: string) => navigator.clipboard?.writeText(text);
  return (
    <div className="addr-row">
      <span className="addr-label">{label}</span>
      <div className="addr-right">
        <a
          href={explorerAddr(addr)}
          target="_blank"
          rel="noreferrer"
          className="addr-link"
          style={{ color: net.color }}
        >
          {shortAddr(addr)}
        </a>
        <button onClick={() => copy(addr)} className="copy-btn" title="Copy address">
          ⧉
        </button>
        {txHash && (
          <a
            href={explorerTx(txHash)}
            target="_blank"
            rel="noreferrer"
            className="tx-link"
            title="Deploy tx"
          >
            tx↗
          </a>
        )}
      </div>
    </div>
  );
}

export function NetworkCard({ networkId, data }: Props) {
  const net = NETWORKS[networkId];
  const dep = DEPLOYMENTS[networkId];

  const budgetPct =
    data.dailyBudget !== "—" && data.dailySpent !== "—"
      ? Math.min(100, (parseFloat(data.dailySpent) / parseFloat(data.dailyBudget)) * 100)
      : 0;

  const nextReset = data.lastReset
    ? new Date(data.lastReset.getTime() + 24 * 3600 * 1000)
    : null;

  return (
    <div className="net-card">
      {/* Header */}
      <div className="net-card-header">
        <div className="net-badge" style={{ background: `${net.color}22`, border: `1px solid ${net.color}55` }}>
          <span className="net-dot" style={{ background: data.loading ? "#555" : net.color }} />
          <span style={{ color: net.color, fontSize: 11, fontWeight: 700 }}>{net.tag}</span>
        </div>
        <span className="net-label">{net.label}</span>
        {data.lastUpdated && (
          <span className="net-updated">
            updated {data.lastUpdated.toLocaleTimeString()}
          </span>
        )}
      </div>

      {data.error && (
        <div className="net-error">⚠ {data.error.slice(0, 80)}</div>
      )}

      {/* Contracts */}
      <div className="section-title">Contracts</div>
      <div className="addr-block">
        <AddrRow
          label="PublisherRegistry"
          addr={dep.publisherRegistry}
          txHash={dep.txHashes.registry}
          explorerAddr={net.explorerAddr}
          explorerTx={net.explorerTx}
          net={net}
        />
        <AddrRow
          label="AgentGatePaymaster"
          addr={dep.paymaster}
          txHash={dep.txHashes.paymaster}
          explorerAddr={net.explorerAddr}
          explorerTx={net.explorerTx}
          net={net}
        />
        <AddrRow
          label="EntryPoint v0.7"
          addr={dep.entryPoint}
          explorerAddr={net.explorerAddr}
          explorerTx={net.explorerTx}
          net={net}
        />
      </div>

      {/* Live stats */}
      <div className="section-title">Live Chain Data</div>
      <div className="stats-block">
        <StatRow
          label="Deployer Balance"
          value={data.deployerBalance}
          sub={net.currency}
        />
        <StatRow
          label="Paymaster Deposit"
          value={data.paymasterDeposit}
          sub={net.currency}
        />
        <StatRow
          label="Total Calls Sponsored"
          value={data.totalCalls.toString()}
        />
        <StatRow
          label="Total Gas Sponsored"
          value={data.totalSponsored}
          sub={net.currency}
        />
      </div>

      {/* Daily budget bar */}
      <div className="section-title">Daily Budget</div>
      <div className="budget-block">
        <div className="budget-bar-bg">
          <div
            className="budget-bar-fill"
            style={{ width: `${budgetPct}%`, background: net.color }}
          />
        </div>
        <div className="budget-row">
          <span className="budget-spent" style={{ color: net.color }}>
            {data.dailySpent} spent
          </span>
          <span className="budget-total">
            / {data.dailyBudget} {net.currency} limit
          </span>
          {nextReset && (
            <span className="budget-reset">
              resets {nextReset.toLocaleTimeString()}
            </span>
          )}
        </div>
        <StatRow
          label="Remaining Today"
          value={data.remainingBudget}
          sub={net.currency}
        />
      </div>

      <style>{`
        .net-card {
          display: flex;
          flex-direction: column;
          gap: 14px;
        }
        .net-card-header {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .net-badge {
          display: flex;
          align-items: center;
          gap: 5px;
          padding: 3px 8px;
          border-radius: 4px;
        }
        .net-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          transition: background 0.5s;
        }
        .net-label {
          font-size: 13px;
          font-weight: 600;
          color: #ccc;
        }
        .net-updated {
          margin-left: auto;
          font-size: 10px;
          color: #444;
        }
        .net-error {
          font-size: 11px;
          color: #ff4444;
          padding: 6px 8px;
          border: 1px solid #ff444433;
          border-radius: 4px;
          background: #ff44440a;
        }
        .section-title {
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.12em;
          color: #444;
          border-bottom: 1px solid #1a1a1a;
          padding-bottom: 4px;
        }
        .addr-block, .stats-block {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .addr-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        }
        .addr-label {
          font-size: 11px;
          color: #555;
          flex: 1;
        }
        .addr-right {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .addr-link {
          font-size: 11px;
          font-family: 'JetBrains Mono', monospace;
          text-decoration: none;
          transition: opacity 0.2s;
        }
        .addr-link:hover { opacity: 0.75; }
        .copy-btn {
          background: none;
          border: none;
          color: #444;
          cursor: pointer;
          font-size: 12px;
          padding: 0;
          transition: color 0.2s;
        }
        .copy-btn:hover { color: #aaa; }
        .tx-link {
          font-size: 10px;
          color: #444;
          text-decoration: none;
          transition: color 0.2s;
        }
        .tx-link:hover { color: #aaa; }
        .stat-row {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
          gap: 8px;
        }
        .stat-label {
          font-size: 11px;
          color: #555;
        }
        .stat-value {
          font-size: 12px;
          color: #ccc;
          font-weight: 500;
          text-align: right;
        }
        .stat-sub {
          font-size: 10px;
          color: #444;
        }
        .budget-block {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .budget-bar-bg {
          height: 3px;
          background: #1a1a1a;
          border-radius: 2px;
          overflow: hidden;
        }
        .budget-bar-fill {
          height: 100%;
          border-radius: 2px;
          transition: width 0.6s ease;
        }
        .budget-row {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 10px;
        }
        .budget-spent { font-weight: 600; }
        .budget-total { color: #444; }
        .budget-reset { margin-left: auto; color: #333; }
      `}</style>
    </div>
  );
}
