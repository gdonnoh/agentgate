/**
 * HederaFacilitatorClient
 *
 * A real x402 facilitator for Hedera Testnet (eip155:296).
 * Payments are native HBAR transfers (simple ETH sends via Hedera JSON-RPC relay).
 *
 * Verification strategy:
 *   - Agent pre-pays (broadcasts HBAR transfer), includes tx hash in payment payload
 *   - We verify via Hedera Mirror Node REST API (3s finality, no separate settle needed)
 *   - Mirror Node `contracts/results/{hash}` returns amount (tinybars), to, result
 *
 * Amount units: tinybars (1 HBAR = 10^8 tinybars)
 * Wire conversion: value_wei = tinybars * 10^8  (Hedera EVM uses 1 ETH = 100 HBAR)
 */

const HEDERA_TESTNET = "eip155:296";
const MIRROR_NODE = "https://testnet.mirrornode.hedera.com";

export class HederaFacilitatorClient {
  async getSupported() {
    return {
      kinds: [{ x402Version: 2, scheme: "exact", network: HEDERA_TESTNET }],
    };
  }

  async verify(paymentPayload: any, paymentRequirements: any): Promise<any> {
    const txHash = paymentPayload?.payload?.transaction;

    if (!txHash) {
      return { isValid: false, invalidReason: "missing transaction hash in payload" };
    }

    // Give Mirror Node a moment to index (Hedera ~3s finality)
    await new Promise((r) => setTimeout(r, 1500));

    try {
      const url = `${MIRROR_NODE}/api/v1/contracts/results/${txHash}`;
      console.log(`[HederaFacilitator] Verifying tx: ${url}`);
      interface MirrorResult {
        result?: string;
        to?: string;
        amount?: number;
        _status?: { messages?: unknown[] };
      }

      const res = await fetch(url);
      const data = await res.json() as MirrorResult;

      if (data._status?.messages) {
        // Not found — wait a bit more and retry once
        await new Promise((r) => setTimeout(r, 3000));
        const res2 = await fetch(url);
        const data2 = await res2.json() as MirrorResult;
        if (data2._status?.messages) {
          return { isValid: false, invalidReason: `transaction not found on Mirror Node: ${txHash}` };
        }
        return this._checkResult(data2, paymentRequirements);
      }

      return this._checkResult(data, paymentRequirements);
    } catch (err: any) {
      console.error("[HederaFacilitator] Mirror Node error:", err.message);
      return { isValid: false, invalidReason: `Mirror Node error: ${err.message}` };
    }
  }

  private _checkResult(data: any, paymentRequirements: any): any {
    // Must be successful
    if (data.result !== "SUCCESS") {
      return { isValid: false, invalidReason: `transaction failed on-chain: ${data.result}` };
    }

    // Must be sent to the publisher's address (case-insensitive)
    const payTo = (paymentRequirements.payTo || "").toLowerCase();
    const to = (data.to || "").toLowerCase();
    if (payTo && to && to !== payTo) {
      return {
        isValid: false,
        invalidReason: `wrong recipient: sent to ${data.to}, expected ${paymentRequirements.payTo}`,
      };
    }

    // Amount must be sufficient (in tinybars)
    // x402 v2 uses `amount`, v1 uses `maxAmountRequired`
    const requiredStr = paymentRequirements.amount || paymentRequirements.maxAmountRequired || "0";
    const required = BigInt(requiredStr);
    const sent = BigInt(data.amount || "0");
    if (sent < required) {
      return {
        isValid: false,
        invalidReason: `insufficient amount: sent ${sent} tinybars, required ${required} tinybars`,
      };
    }

    console.log(
      `[HederaFacilitator] ✅ Payment verified: ${sent} tinybars to ${data.to} (tx: ${data.hash})`
    );
    return { isValid: true, invalidReason: null };
  }

  async settle(paymentPayload: any, _paymentRequirements: any): Promise<any> {
    // Hedera has ~3s absolute finality — if verify() passed, it's already settled
    const txHash = paymentPayload?.payload?.transaction;
    console.log(`[HederaFacilitator] ✅ Settle (instant finality): ${txHash}`);
    return {
      success: true,
      transaction: txHash,
      network: HEDERA_TESTNET,
    };
  }
}
