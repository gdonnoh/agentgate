import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

export const config = {
  port: Number(process.env.PORT) || 4021,
  // Official x402 facilitator — supports eip155:84532 (Base Sepolia)
  // World Chain facilitator (x402-worldchain.vercel.app) has no /supported endpoint
  facilitatorUrl:
    process.env.FACILITATOR_URL ||
    "https://www.x402.org/facilitator",
  publisherAddress:
    process.env.PUBLISHER_ADDRESS ||
    "0x000000000000000000000000000000000000dead",
  rpcUrl: process.env.RPC_URL || "https://testnet.hashio.io/api",
};

export const WORLD_CHAIN  = "eip155:480";
export const BASE         = "eip155:8453";
export const HEDERA       = "eip155:296";
export const WORLD_USDC   = "0x79A02482A880bCE3F13e09Da970dC34db4CD24d1";

// Hedera: 1 HBAR = 10^8 tinybars. On Hedera EVM: 1 ETH = 100 HBAR → 1 wei = 10^-8 tinybars
// So: tinybar_value_sent = wei_sent / 10^8
// Mirror Node `amount` field is in tinybars.
export const TINYBAR_PER_HBAR = 100_000_000n; // 10^8
export const WEI_PER_TINYBAR  = 100_000_000n; // same factor: value_wei = tinybars * 10^8
export const HEDERA_MIRROR    = "https://testnet.mirrornode.hedera.com";
