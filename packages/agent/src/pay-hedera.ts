/**
 * pay-hedera.ts
 *
 * Demonstrates HBAR payment on Hedera Testnet via the x402 protocol.
 *
 * Two modes:
 *   - With AgentKit (USE_AGENTKIT=true, default): builds WorldID proof, gets
 *     free-trial or pays HBAR, retries with both headers.
 *   - Wallet-only (USE_AGENTKIT=false): skips WorldID, requests endpoint
 *     directly, pays HBAR, retries with payment header only.
 *
 * Usage: tsx src/pay-hedera.ts
 *        USE_AGENTKIT=false tsx src/pay-hedera.ts
 */

import * as dotenv from "dotenv";
import * as path from "path";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Hex,
  type Address,
} from "viem";
import { defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { formatSIWEMessage } from "@worldcoin/agentkit";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

// ─── Config ──────────────────────────────────────────────────────────────────
const AGENT_PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY as Hex;
const SERVER_URL        = process.env.SERVER_URL || "http://localhost:4021";
const HEDERA_RPC        = process.env.HEDERA_TESTNET_RPC || "https://testnet.hashio.io/api";
const MIRROR_NODE       = "https://testnet.mirrornode.hedera.com";

const USE_AGENTKIT     = process.env.USE_AGENTKIT !== "false";

if (!AGENT_PRIVATE_KEY) throw new Error("AGENT_PRIVATE_KEY not set in .env");

// Hedera Testnet EVM chain definition
const hederaTestnet = defineChain({
  id: 296,
  name: "Hedera Testnet",
  nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
  rpcUrls: { default: { http: [HEDERA_RPC] } },
  blockExplorers: {
    default: { name: "HashScan", url: "https://hashscan.io/testnet" },
  },
});

// Hedera EVM unit conversion:
// 1 HBAR = 10^8 tinybars
// 1 ETH (EVM) = 100 HBAR → 10^18 wei = 10^10 tinybars
// → 1 tinybar = 10^18 / 10^10 = 10^8 wei
// → value_wei = tinybars * 10^8
const WEI_PER_TINYBAR  = 100_000_000n; // 10^8
const HEDERA_GAS_PRICE = 1_200_000_000_000n; // 1200 Gwei — Hedera testnet minimum

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("\n" + "═".repeat(62));
  console.log("🤖 AgentGate — x402 Payment on Hedera Testnet (HBAR)");
  console.log("═".repeat(62));

  const account = privateKeyToAccount(AGENT_PRIVATE_KEY);
  console.log(`\n👤 Agent wallet:  ${account.address}`);
  console.log(`🌐 Server:        ${SERVER_URL}`);
  console.log(`⛓  Network:       Hedera Testnet (eip155:296)`);

  // Viem clients for Hedera
  const publicClient = createPublicClient({ chain: hederaTestnet, transport: http(HEDERA_RPC) });
  const walletClient = createWalletClient({ account, chain: hederaTestnet, transport: http(HEDERA_RPC) });

  // Check balance
  const balanceWei = await publicClient.getBalance({ address: account.address });
  const balanceHbar = Number(balanceWei) / 1e18;
  console.log(`💰 Balance:       ${balanceHbar.toFixed(4)} HBAR`);

  const endpoint  = `${SERVER_URL}/api/weather/rome`;
  let agentKitHeader: string | null = null;

  if (USE_AGENTKIT) {
    // ── Step 1: Build WorldID AgentKit proof ──────────────────────────────────
    console.log(`\n🆔 Step 1: Constructing WorldID AgentKit proof…`);

    const serverUrl = new URL(SERVER_URL);
    const nonce     = Math.random().toString(36).slice(2, 18);
    const issuedAt  = new Date().toISOString();

    const siweInfo = {
      domain:    serverUrl.hostname,
      uri:       endpoint,
      version:   "1",
      chainId:   "eip155:296",
      type:      "eip191" as const,
      nonce,
      issuedAt,
      statement: "Verify your agent is backed by a real human",
    };

    const siweMessage   = formatSIWEMessage(siweInfo, account.address);
    const siweSignature = await walletClient.signMessage({ message: siweMessage });

    const agentKitPayload = {
      domain:    siweInfo.domain,
      address:   account.address,
      statement: siweInfo.statement,
      uri:       siweInfo.uri,
      version:   siweInfo.version,
      chainId:   siweInfo.chainId,
      type:      "eip191",
      nonce,
      issuedAt,
      signature: siweSignature,
    };

    agentKitHeader = Buffer.from(JSON.stringify(agentKitPayload)).toString("base64");
    console.log(`   ✅ AgentKit proof built (address: ${account.address})`);
  } else {
    console.log(`\n🔑 Wallet-only mode (USE_AGENTKIT=false) — skipping AgentKit proof`);
  }

  // ── Step 2: Initial request → 402 (or 200 free trial with AgentKit) ──────
  const initialHeaders: Record<string, string> = {};
  if (agentKitHeader) initialHeaders["agentkit"] = agentKitHeader;

  console.log(`\n📡 Step 2: GET ${endpoint}${agentKitHeader ? " (with agentkit header)" : " (no agentkit)"}`);

  const res1 = await fetch(endpoint, {
    headers: initialHeaders,
  });
  console.log(`   → Status: ${res1.status} ${res1.statusText}`);

  if (res1.status === 403) {
    const body = await res1.text();
    console.error(`\n🚫 Request rejected (403):`);
    console.error(`   ${body}`);
    console.log("\n" + "═".repeat(62) + "\n");
    return;
  }

  if (res1.status === 200) {
    const data = await res1.json();
    console.log(`\n🎉 Free trial access granted! API response:`);
    console.log(`   ${JSON.stringify(data, null, 2).split("\n").join("\n   ")}`);
    console.log("\n" + "═".repeat(62) + "\n");
    return;
  }

  if (res1.status !== 402) {
    const body = await res1.text();
    throw new Error(`Expected 402 but got ${res1.status}: ${body}`);
  }

  // ── Step 3: Parse payment requirements ────────────────────────────────────
  const paymentRequiredHeader = res1.headers.get("PAYMENT-REQUIRED") || res1.headers.get("X-PAYMENT-REQUIRED");
  if (!paymentRequiredHeader) throw new Error("No PAYMENT-REQUIRED header in 402 response");

  const paymentRequired = JSON.parse(Buffer.from(paymentRequiredHeader, "base64").toString("utf-8"));
  console.log(`\n📋 Step 3: Payment Required`);
  console.log(`   Accepts ${paymentRequired.accepts?.length ?? paymentRequired.length ?? "?"} payment options`);

  // Find Hedera option
  const accepts = paymentRequired.accepts || paymentRequired;
  const hederaOption = (Array.isArray(accepts) ? accepts : [accepts]).find(
    (a: any) => a.network === "eip155:296"
  );

  if (!hederaOption) {
    console.log("   Available networks:", accepts.map((a: any) => a.network));
    throw new Error("Server did not offer a Hedera (eip155:296) payment option");
  }

  // x402 v2 field is `amount`, not `maxAmountRequired`
  const tinybarsRequired = BigInt(hederaOption.amount || hederaOption.maxAmountRequired);
  const hbarRequired     = Number(tinybarsRequired) / 1e8;
  const weiRequired      = tinybarsRequired * WEI_PER_TINYBAR;

  console.log(`   Network:         ${hederaOption.network}`);
  console.log(`   Asset:           HBAR (native)`);
  console.log(`   Required:        ${tinybarsRequired} tinybars (≈ ${hbarRequired.toFixed(6)} HBAR)`);
  console.log(`   Pay to:          ${hederaOption.payTo}`);

  // ── Step 4: Send HBAR ──────────────────────────────────────────────────────
  console.log(`\n💸 Step 4: Sending ${hbarRequired.toFixed(6)} HBAR to ${hederaOption.payTo}…`);

  const txHash = await walletClient.sendTransaction({
    to: hederaOption.payTo as Address,
    value: weiRequired,
    gas: 3_000_000n,
    gasPrice: HEDERA_GAS_PRICE,
  });

  console.log(`   ✅ Tx submitted:  ${txHash}`);
  console.log(`   🔗 https://hashscan.io/testnet/tx/${txHash}`);

  // ── Step 5: Wait for confirmation (Hedera ~3s finality) ───────────────────
  console.log(`\n⏳ Step 5: Waiting for Hedera confirmation (~3s)…`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log(`   ✅ Confirmed in block ${receipt.blockNumber} (status: ${receipt.status})`);

  if (receipt.status !== "success") {
    throw new Error(`Transaction failed on-chain: ${txHash}`);
  }

  // ── Step 6: Build x402 payment payload and retry ─────────────────────────
  // x402 v1 format: matching checks only scheme + network (avoids rate-drift issues)
  const paymentPayload = {
    x402Version: 1,
    scheme:      "exact",
    network:     "eip155:296",
    accepted: {
      scheme:  "exact",
      network: "eip155:296",
    },
    payload: {
      transaction: txHash,
      from:        account.address,
      to:          hederaOption.payTo,
      amount:      tinybarsRequired.toString(),
      asset:       "hbar",
    },
  };

  const encodedPayment = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");

  const retryHeaders: Record<string, string> = { "PAYMENT-SIGNATURE": encodedPayment };
  if (agentKitHeader) retryHeaders["agentkit"] = agentKitHeader;

  console.log(`\n🔁 Step 6: Retrying with PAYMENT-SIGNATURE${agentKitHeader ? " + agentkit" : ""} headers…`);
  const res2 = await fetch(endpoint, {
    headers: retryHeaders,
  });

  console.log(`   → Status: ${res2.status} ${res2.statusText}`);

  // ── Step 6: Result ─────────────────────────────────────────────────────────
  if (res2.status === 200) {
    const data = await res2.json();
    console.log(`\n🎉 SUCCESS! API response received:`);
    console.log(`   ${JSON.stringify(data, null, 2).split("\n").join("\n   ")}`);

    console.log(`\n📊 Summary:`);
    console.log(`   Agent paid:        ${hbarRequired.toFixed(6)} HBAR (≈ $${(hbarRequired * 0.087).toFixed(4)})`);
    console.log(`   Publisher:         ${hederaOption.payTo}`);
    console.log(`   Tx on-chain:       https://hashscan.io/testnet/tx/${txHash}`);
    console.log(`   Payment standard:  x402 on Hedera Testnet`);
    console.log(`   Identity proof:    ${agentKitHeader ? "WorldID AgentKit (World Chain AgentBook)" : "None (wallet-only)"}`);
    console.log(`   Agent address:     ${account.address}`);
  } else {
    const errBody = await res2.text();
    console.error(`\n❌ Payment rejected (${res2.status}): ${errBody}`);
  }

  console.log("\n" + "═".repeat(62) + "\n");
}

main().catch((err) => {
  console.error("\n❌ Error:", err.message);
  if (err.details) console.error("   Details:", err.details);
  process.exit(1);
});
