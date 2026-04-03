import { useEffect, useState, useCallback } from "react";
import { createPublicClient, http, formatEther } from "viem";
import { baseSepolia } from "viem/chains";
import { hederaTestnet, NETWORKS, DEPLOYMENTS, NetworkId } from "../lib/chains";
import { PAYMASTER_ABI, REGISTRY_ABI, ENTRYPOINT_ABI } from "../lib/abi";

export interface OnChainData {
  deployerBalance: string;
  paymasterDeposit: string;
  dailyBudget: string;
  dailySpent: string;
  remainingBudget: string;
  totalCalls: number;
  totalSponsored: string;
  lastReset: Date | null;
  totalEndpoints: number;
  endpoints: EndpointData[];
  lastUpdated: Date | null;
  loading: boolean;
  error: string | null;
}

export interface EndpointData {
  id: number;
  publisher: string;
  url: string;
  pricePerCall: string;
  paymaster: string;
  active: boolean;
  totalCalls: number;
  totalRevenue: string;
  registeredAt: Date;
}

const INITIAL: OnChainData = {
  deployerBalance: "—",
  paymasterDeposit: "—",
  dailyBudget: "—",
  dailySpent: "—",
  remainingBudget: "—",
  totalCalls: 0,
  totalSponsored: "—",
  lastReset: null,
  totalEndpoints: 0,
  endpoints: [],
  lastUpdated: null,
  loading: true,
  error: null,
};

function getClient(networkId: NetworkId) {
  const cfg = NETWORKS[networkId];
  const chain = networkId === "hedera" ? hederaTestnet : baseSepolia;
  return createPublicClient({ chain, transport: http(cfg.rpc) });
}

export function useOnChainData(networkId: NetworkId, pollMs = 12000) {
  const [data, setData] = useState<OnChainData>(INITIAL);

  const fetch = useCallback(async () => {
    const client = getClient(networkId);
    const d = DEPLOYMENTS[networkId];

    try {
      const results = await Promise.allSettled([
        client.getBalance({ address: d.deployer }),                                                                                        // 0
        client.readContract({ address: d.entryPoint, abi: ENTRYPOINT_ABI, functionName: "balanceOf", args: [d.paymaster] }),               // 1
        client.readContract({ address: d.paymaster,  abi: PAYMASTER_ABI,  functionName: "dailyBudget" }),                                  // 2
        client.readContract({ address: d.paymaster,  abi: PAYMASTER_ABI,  functionName: "dailySpent" }),                                   // 3
        client.readContract({ address: d.paymaster,  abi: PAYMASTER_ABI,  functionName: "getRemainingBudget" }),                           // 4
        client.readContract({ address: d.paymaster,  abi: PAYMASTER_ABI,  functionName: "totalCalls" }),                                   // 5
        client.readContract({ address: d.paymaster,  abi: PAYMASTER_ABI,  functionName: "getTotalSponsored" }),                            // 6
        client.readContract({ address: d.paymaster,  abi: PAYMASTER_ABI,  functionName: "lastResetTimestamp" }),                           // 7
        client.readContract({ address: d.publisherRegistry, abi: REGISTRY_ABI, functionName: "nextEndpointId" }),                         // 8
      ]);

      function val<T>(r: PromiseSettledResult<unknown>, fallback: T): T {
        return r.status === "fulfilled" ? (r.value as T) : fallback;
      }

      const deployerBalance  = val<bigint>(results[0], 0n);
      const paymasterDeposit = val<bigint>(results[1], 0n);
      const dailyBudget      = val<bigint>(results[2], 0n);
      const dailySpent       = val<bigint>(results[3], 0n);
      const remainingBudget  = val<bigint>(results[4], 0n);
      const totalCalls       = val<bigint>(results[5], 0n);
      const totalSponsored   = val<bigint>(results[6], 0n);
      const lastReset        = val<bigint>(results[7], 0n);
      const nextId           = val<bigint>(results[8], 0n);

      // Log any individual failures for debugging
      results.forEach((r, i) => {
        if (r.status === "rejected") {
          console.warn(`[useOnChainData] call ${i} failed:`, r.reason?.shortMessage || r.reason?.message || r.reason);
        }
      });

      // Fetch all registered endpoints
      const endpoints: EndpointData[] = [];
      for (let i = 0; i < Number(nextId); i++) {
        try {
          const ep = await client.readContract({
            address: d.publisherRegistry,
            abi: REGISTRY_ABI,
            functionName: "endpoints",
            args: [BigInt(i)],
          }) as readonly [bigint, `0x${string}`, string, bigint, `0x${string}`, boolean, bigint, bigint, bigint];
          if (ep[2]) { // skip empty slots (url would be empty string)
            endpoints.push({
              id: Number(ep[0]),
              publisher: ep[1],
              url: ep[2],
              pricePerCall: (Number(ep[3]) / 1_000_000).toFixed(4),
              paymaster: ep[4],
              active: ep[5],
              totalCalls: Number(ep[6]),
              totalRevenue: (Number(ep[7]) / 1_000_000).toFixed(4),
              registeredAt: new Date(Number(ep[8]) * 1000),
            });
          }
        } catch {
          // endpoint slot may be empty, skip silently
        }
      }

      setData({
        deployerBalance:  parseFloat(formatEther(deployerBalance)).toFixed(4),
        paymasterDeposit: parseFloat(formatEther(paymasterDeposit)).toFixed(6),
        dailyBudget:      parseFloat(formatEther(dailyBudget)).toFixed(4),
        dailySpent:       parseFloat(formatEther(dailySpent)).toFixed(6),
        remainingBudget:  parseFloat(formatEther(remainingBudget)).toFixed(6),
        totalCalls:       Number(totalCalls),
        totalSponsored:   parseFloat(formatEther(totalSponsored)).toFixed(8),
        lastReset:        lastReset > 0n ? new Date(Number(lastReset) * 1000) : null,
        totalEndpoints:   endpoints.length,
        endpoints,
        lastUpdated:      new Date(),
        loading: false,
        error: null,
      });
    } catch (e: any) {
      setData((prev) => ({ ...prev, loading: false, error: e.message }));
    }
  }, [networkId]);

  useEffect(() => {
    setData({ ...INITIAL, loading: true });
    fetch();
    const id = setInterval(fetch, pollMs);
    return () => clearInterval(id);
  }, [fetch, pollMs]);

  return { data, refetch: fetch };
}
