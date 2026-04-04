export const PAYMASTER_ABI = [
  { name: "dailyBudget",        type: "function", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { name: "dailySpent",         type: "function", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { name: "totalCalls",         type: "function", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { name: "getTotalSponsored",  type: "function", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { name: "getRemainingBudget", type: "function", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { name: "lastResetTimestamp", type: "function", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  {
    name: "endpointSponsorshipBps",
    type: "function",
    inputs: [{ name: "endpointHash", type: "bytes32" }],
    outputs: [{ type: "uint16" }],
    stateMutability: "view",
  },
] as const;

export const REGISTRY_ABI = [
  { name: "getTotalEndpoints",     type: "function", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { name: "nextEndpointId",        type: "function", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  {
    name: "getPublisherEndpoints",
    type: "function",
    inputs:  [{ name: "publisher", type: "address" }],
    outputs: [{ name: "", type: "uint256[]" }],
    stateMutability: "view",
  },
  {
    name: "endpoints",
    type: "function",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      { name: "id",         type: "uint256" },
      { name: "publisher",  type: "address" },
      { name: "url",        type: "string"  },
      { name: "pricePerCall", type: "uint256" },
      { name: "paymaster",  type: "address" },
      { name: "active",     type: "bool"    },
      { name: "totalCalls", type: "uint256" },
      { name: "totalRevenue", type: "uint256" },
      { name: "registeredAt", type: "uint256" },
    ],
    stateMutability: "view",
  },
] as const;

export const ENTRYPOINT_ABI = [
  { name: "balanceOf", type: "function", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
] as const;
