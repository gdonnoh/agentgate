import { useEffect, useRef, useState } from "react";
import { createPublicClient, http, parseAbiItem, type Address } from "viem";
import { baseSepolia } from "viem/chains";
import { DEPLOYMENTS, NETWORKS } from "../lib/chains";
import type { NetworkId } from "../lib/chains";

export interface GasSponsoredEvent {
  agent: Address;
  endpointHash: `0x${string}`;
  gasUsed: bigint;
  sponsorshipBps: number;
  txHash: `0x${string}`;
  blockNumber: bigint;
  timestamp: number;
}

const PAYMASTER_ABI_EVENT = parseAbiItem(
  "event GasSponsored(address indexed agent, bytes32 indexed endpointHash, uint256 gasUsed, uint16 sponsorshipBps)"
);

// Only Base Sepolia has a real Paymaster; Hedera paymaster is unverified
const CLIENTS: Record<NetworkId, ReturnType<typeof createPublicClient> | null> = {
  baseSepolia: createPublicClient({
    chain: baseSepolia,
    transport: http("https://sepolia.base.org"),
  }),
  hedera: null, // Hedera doesn't have ERC-4337 event polling support
};

export function useGasSponsoredEvents(networkId: NetworkId, limit = 10) {
  const [events, setEvents] = useState<GasSponsoredEvent[]>([]);
  const [latestBlock, setLatestBlock] = useState<bigint>(0n);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastScannedBlock = useRef<bigint>(0n);

  useEffect(() => {
    setEvents([]);
    lastScannedBlock.current = 0n;

    const client = CLIENTS[networkId];
    if (!client) return;

    const paymasterAddress = DEPLOYMENTS[networkId].paymaster;

    async function poll() {
      if (!client) return;
      try {
        const currentBlock = await client.getBlockNumber();
        setLatestBlock(currentBlock);

        if (lastScannedBlock.current === 0n) {
          // First poll: scan last 5000 blocks for history
          lastScannedBlock.current = currentBlock - 5000n > 0n ? currentBlock - 5000n : 0n;
        }

        if (currentBlock <= lastScannedBlock.current) return;

        const fromBlock = lastScannedBlock.current + 1n;
        const toBlock   = currentBlock;

        const logs = await client.getLogs({
          address: paymasterAddress,
          event: PAYMASTER_ABI_EVENT,
          fromBlock,
          toBlock,
        });

        if (logs.length > 0) {
          const newEvents: GasSponsoredEvent[] = await Promise.all(
            logs.map(async (log) => {
              let timestamp = Date.now() / 1000;
              try {
                const block = await client.getBlock({ blockNumber: log.blockNumber! });
                timestamp = Number(block.timestamp);
              } catch {}
              return {
                agent:          log.args.agent as Address,
                endpointHash:   log.args.endpointHash as `0x${string}`,
                gasUsed:        log.args.gasUsed as bigint,
                sponsorshipBps: Number(log.args.sponsorshipBps ?? 10000),
                txHash:         log.transactionHash as `0x${string}`,
                blockNumber:    log.blockNumber!,
                timestamp,
              };
            })
          );

          setEvents((prev) => {
            const combined = [...newEvents, ...prev];
            const deduped  = combined.filter(
              (e, i, arr) => arr.findIndex((x) => x.txHash === e.txHash) === i
            );
            return deduped.slice(0, limit);
          });
        }

        lastScannedBlock.current = toBlock;
      } catch {
        // Ignore polling errors (rate limits, network issues)
      }
    }

    poll();
    intervalRef.current = setInterval(poll, 12_000); // poll every ~1 block

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [networkId, limit]);

  return { events, latestBlock };
}
