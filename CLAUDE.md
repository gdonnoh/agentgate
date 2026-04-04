# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is AgentGate

AgentGate is a pay-per-call API gateway for AI agents on Hedera Testnet. Publishers register API endpoints with per-call pricing, and agents pay in HBAR via the x402 payment protocol. Agents backed by a real human (via World ID / WorldCoin AgentKit) get a free trial (3 calls) before payment kicks in.

## Monorepo Structure

pnpm workspace with four packages:

- **packages/server** — Hono HTTP server. x402 payment middleware gates `/api/weather/:city` and `/api/prices/:token`. WorldCoin AgentKit verifies human-backed agents. `LocalFacilitatorClient` handles demo settlement; `HederaFacilitatorClient` verifies real HBAR payments via Mirror Node.
- **packages/dashboard** — React + Vite + Tailwind frontend. Publisher dashboard for registering endpoints, viewing stats, managing gas budgets. Reads on-chain data from PublisherRegistry and AgentGatePaymaster contracts via viem.
- **packages/contracts** — Solidity (0.8.24) + Hardhat. Two contracts: `PublisherRegistry` (endpoint CRUD, call tracking) and `AgentGatePaymaster` (ERC-4337 paymaster with per-endpoint gas budgets and configurable gas-share %).
- **packages/agent** — Demo CLI agent that exercises the full x402 + AgentKit flow (402 challenge → SIWE signing → payment → retry).

## Commands

```bash
# Install dependencies
pnpm install

# Dev (all packages in parallel)
pnpm dev

# Dev individual packages
pnpm --filter @agentgate/server dev     # server on port 4021
pnpm --filter @agentgate/dashboard dev  # vite dev server
pnpm --filter @agentgate/agent demo     # run agent demo

# Build all
pnpm build

# Contracts
cd packages/contracts
npx hardhat compile
npx hardhat test                                          # run contract tests
npx hardhat run scripts/deploy.ts --network hedera        # deploy to Hedera Testnet
npx hardhat run scripts/fund-paymaster.ts --network hedera
```

## Key Architectural Details

- **x402 protocol**: Server returns HTTP 402 with `payment-required` header containing price, network, and AgentKit challenge. Agent signs SIWE + payment, retries with `agentkit` and `payment-signature` headers.
- **Hedera HBAR payments**: Prices are in USD, converted to tinybars at runtime using Mirror Node exchange rate API (`/api/v1/network/exchangerate`). 1 HBAR = 10^8 tinybars.
- **AgentKit free trial**: WorldCoin AgentKit gives WorldID-verified agents 3 free API calls via `InMemoryAgentKitStorage` (resets on server restart).
- **Paymaster gas share**: Publishers deposit ETH and set a `gasShareBps` (0–10000). The paymaster covers that % of agent gas costs per call. `paymasterAndData[52:84]` carries the `endpointHash = keccak256(url)`.
- **Config**: All packages load `.env` from the repo root. Server config is in `packages/server/src/config.ts`. Contract addresses and deployment info are hardcoded in `packages/dashboard/src/lib/chains.ts`.
- **Network**: The project targets Hedera Testnet (chainId 296, RPC `https://testnet.hashio.io/api`). Base Sepolia config exists but is not actively used.
