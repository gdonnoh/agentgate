import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { HTTPFacilitatorClient } from "@x402/core/http";
import { LocalFacilitatorClient } from "./services/localFacilitator";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import {
  paymentMiddlewareFromHTTPServer,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@x402/hono";
import {
  agentkitResourceServerExtension,
  createAgentBookVerifier,
  createAgentkitHooks,
  declareAgentkitExtension,
  InMemoryAgentKitStorage,
} from "@worldcoin/agentkit";

import { config, WORLD_CHAIN, BASE, HEDERA, WORLD_USDC, HEDERA_MIRROR } from "./config";

// Base Sepolia USDC address
const BASE_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
import weatherRouter from "./routes/weather";
import pricesRouter from "./routes/prices";
import publisherRouter from "./routes/publisher";

const payTo = config.publisherAddress as `0x${string}`;

// ── AgentKit setup ────────────────────────────────────────────────────────────
const agentBook = createAgentBookVerifier({ network: "world" });
const storage = new InMemoryAgentKitStorage();
const hooks = createAgentkitHooks({
  agentBook,
  storage,
  mode: { type: "free-trial", uses: 3 },
});

// ── x402 resource server ──────────────────────────────────────────────────────
// LocalFacilitatorClient: supports World Chain + Base without needing a live facilitator
// (demo mode — simulates settlement for non-Base-Sepolia chains)
const facilitatorClient = new LocalFacilitatorClient() as any;

// Scheme for World Chain
const worldEvmScheme = new ExactEvmScheme().registerMoneyParser(
  async (amount: number, network: string) => {
    if (network !== WORLD_CHAIN) return null;
    return {
      amount: String(Math.round(amount * 1e6)),
      asset: WORLD_USDC,
      extra: { name: "USD Coin", version: "2" },
    };
  }
);

// Scheme for Base
const baseEvmScheme = new ExactEvmScheme().registerMoneyParser(
  async (amount: number, network: string) => {
    if (network !== BASE) return null;
    return {
      amount: String(Math.round(amount * 1e6)),
      asset: BASE_USDC,
      extra: { name: "USD Coin", version: "2" },
    };
  }
);

// Scheme for Hedera Testnet — native HBAR payments
// Amount expressed in tinybars (1 HBAR = 10^8 tinybars)
// Price fetched live from Mirror Node exchange rate API
const hederaEvmScheme = new ExactEvmScheme().registerMoneyParser(
  async (amount: number, network: string) => {
    if (network !== HEDERA) return null;
    let hbarPerUsd = 11.43; // fallback: ~$0.0875/HBAR → ~11.43 HBAR/$1
    try {
      const rateRes = await fetch(`${HEDERA_MIRROR}/api/v1/network/exchangerate`);
      const rateData = await rateRes.json();
      const { cent_equivalent, hbar_equivalent } = rateData.current_rate;
      const usdPerHbar = cent_equivalent / 100 / hbar_equivalent;
      hbarPerUsd = 1 / usdPerHbar;
    } catch {
      // use fallback
    }
    const tinybars = Math.ceil(amount * hbarPerUsd * 1e8); // USD → HBAR → tinybars
    return {
      amount: String(tinybars),
      asset: "hbar",
      extra: { name: "HBAR", decimals: 8, assetTransferMethod: "hedera-native" },
    };
  }
);

const resourceServer = new x402ResourceServer(facilitatorClient)
  .register(WORLD_CHAIN, worldEvmScheme)
  .register(BASE, baseEvmScheme)
  .register(HEDERA, hederaEvmScheme)
  .registerExtension(agentkitResourceServerExtension);

// ── Protected route definitions ───────────────────────────────────────────────
const agentkitExt = declareAgentkitExtension({
  statement: "Verify your agent is backed by a real human",
  mode: { type: "free-trial", uses: 3 },
});

const routes = {
  "GET /api/weather/:city": {
    accepts: [
      { scheme: "exact" as const, price: "$0.01",  network: WORLD_CHAIN, payTo },
      { scheme: "exact" as const, price: "$0.01",  network: BASE,        payTo },
      { scheme: "exact" as const, price: "$0.01",  network: HEDERA,      payTo },
    ],
    extensions: agentkitExt,
  },
  "GET /api/prices/:token": {
    accepts: [
      { scheme: "exact" as const, price: "$0.005", network: WORLD_CHAIN, payTo },
      { scheme: "exact" as const, price: "$0.005", network: BASE,        payTo },
      { scheme: "exact" as const, price: "$0.005", network: HEDERA,      payTo },
    ],
    extensions: agentkitExt,
  },
};

// ── Hono app ──────────────────────────────────────────────────────────────────
const app = new Hono();

// Payment middleware (handles 402 challenge/response)
const httpServer = new x402HTTPResourceServer(resourceServer, routes).onProtectedRequest(
  hooks.requestHook
);
app.use(paymentMiddlewareFromHTTPServer(httpServer));

// Health check (unprotected)
app.get("/health", (c) => {
  return c.json({
    status: "ok",
    endpoints: 2,
    agentkit: true,
    version: "1.0.0",
    protectedRoutes: Object.keys(routes),
  });
});

// Mount protected routes
app.route("/api/weather", weatherRouter);
app.route("/api/prices", pricesRouter);

// Publisher management (unprotected)
app.route("/api/publisher", publisherRouter);

// Request logger
app.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  const payment = c.req.header("X-PAYMENT-RESPONSE") ? " [PAID]" : "";
  console.log(`${c.req.method} ${c.req.path} → ${c.res.status} ${ms}ms${payment}`);
});

// ── Start server ──────────────────────────────────────────────────────────────
serve(
  {
    fetch: app.fetch,
    port: config.port,
  },
  (info) => {
    console.log(`\n🚀 AgentGate Server running on port ${info.port}`);
    console.log(`\n📡 Protected endpoints:`);
    console.log(`   GET /api/weather/:city  — $0.01  USDC (World Chain / Base) | HBAR (Hedera)`);
    console.log(`   GET /api/prices/:token  — $0.005 USDC (World Chain / Base) | HBAR (Hedera)`);
    console.log(`\n🔓 Public endpoints:`);
    console.log(`   GET /health`);
    console.log(`   POST /api/publisher/register`);
    console.log(`   GET  /api/publisher/stats/:address`);
    console.log(`\n🆔 AgentKit: free-trial mode (3 uses), World Chain AgentBook`);
    console.log(`💳 Payments to: ${payTo}\n`);
  }
);

export default app;
