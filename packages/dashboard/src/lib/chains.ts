import { defineChain } from "viem";

export const hederaTestnet = defineChain({
  id: 296,
  name: "Hedera Testnet",
  nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet.hashio.io/api"] } },
  blockExplorers: {
    default: { name: "HashScan", url: "https://hashscan.io/testnet" },
  },
});

export const NETWORKS = {
  baseSepolia: {
    id: "baseSepolia" as const,
    label: "Base Sepolia",
    chainId: 84532,
    rpc: "https://sepolia.base.org",
    currency: "ETH",
    explorerBase: "https://sepolia.basescan.org",
    explorerTx: (h: string) => `https://sepolia.basescan.org/tx/${h}`,
    explorerAddr: (a: string) => `https://sepolia.basescan.org/address/${a}`,
    color: "#2151f5",
    tag: "BASE",
  },
  hedera: {
    id: "hedera" as const,
    label: "Hedera Testnet",
    chainId: 296,
    rpc: "https://testnet.hashio.io/api",
    currency: "HBAR",
    explorerBase: "https://hashscan.io/testnet",
    explorerTx: (h: string) => `https://hashscan.io/testnet/tx/${h}`,
    explorerAddr: (a: string) => `https://hashscan.io/testnet/contract/${a}`,
    color: "#8259ef",
    tag: "HBAR",
  },
} as const;

export type NetworkId = keyof typeof NETWORKS;

export const DEPLOYMENTS = {
  baseSepolia: {
    publisherRegistry: "0xfbcee3e39a0909549fbc28cac37141d01f946189" as `0x${string}`,
    paymaster: "0x83da591891e83a978deA8640Ddc7F047fdbEf75D" as `0x${string}`,
    entryPoint: "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as `0x${string}`,
    deployer: "0x05a7Ae061c14847e0B70f7851d76FC10289d69b0" as `0x${string}`,
    deployedAt: "2026-04-03T21:46:49.761Z",
    txHashes: {
      registry: "0x9c1653279c010f3b5b4b1dec4438d60d7deea56d00dc0512cb3d8dfc6f3c4dc4",
      paymaster: "0x6d6e17e9a9ad1a8ab781928168737ad8a00aa9d68079c65972312ea710f3269e",
      register: "0x9fa5eb68c10d3448ac73b47313550f8ab9bbc468e1fdb29933537cf4041cd072",
      fund: "0x623b89b9a2fe91228f0b978b288e81e24f7da10c6bb222352a3f90265e659df4",
    },
  },
  hedera: {
    publisherRegistry: "0xFBCee3E39A0909549fbc28cac37141d01f946189" as `0x${string}`,
    paymaster: "0xfb274B563b2c1F9F9B77cf0944b99B00C006E754" as `0x${string}`,
    entryPoint: "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as `0x${string}`,
    deployer: "0x05a7Ae061c14847e0B70f7851d76FC10289d69b0" as `0x${string}`,
    deployedAt: "2026-04-03T21:53:37.290Z",
    txHashes: {
      registry: "0x062c3f7d3e16ce4c37915ca717b5a8381ef00904002d4e9a82d983625390adb0",
      paymaster: "0x9b88f4be15234e6b9f0a26bc19e7e53e0919b7124db8dcbd8947dbf2e9ba1278",
      register: "0x6d1c070b819383678720b79850110a1929c1dc07456e8443bb44232cc99b5dcb",
      fund: "0xce093a0ebc7dbe630ee946d74177582d77a02562b306c976825fd3b247b026f5",
    },
  },
} as const;
