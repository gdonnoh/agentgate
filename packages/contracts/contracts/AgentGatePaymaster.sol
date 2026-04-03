// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@account-abstraction/contracts/core/BasePaymaster.sol";
import "@account-abstraction/contracts/interfaces/IEntryPoint.sol";

/**
 * @title AgentGatePaymaster
 * @notice ERC-4337 Paymaster that sponsors gas for AI agents calling registered endpoints.
 *
 *  Publisher gas-share model
 *  ─────────────────────────
 *  Each endpoint has a `gasShareBps` (0–10 000 = 0–100%).
 *  When an agent includes the endpoint hash in `paymasterData`, the paymaster:
 *    – covers 100% of the gas cost from its EntryPoint deposit (ERC-4337 requirement)
 *    – but charges only `(maxCost * gasShareBps / 10 000)` against the daily budget
 *
 *  A publisher at 100% is most attractive (all gas sponsored, full daily budget used).
 *  A publisher at 50% uses only half the daily budget per call → twice as many calls/day.
 *
 *  paymasterData layout (bytes passed after the standard 52-byte header):
 *    bytes[0:32]  = bytes32 endpointHash  (keccak256 of endpoint URL)
 */
contract AgentGatePaymaster is BasePaymaster {
    // ── Daily budget tracking ───────────────────────────────────────────────
    uint256 public dailyBudget;
    uint256 public dailySpent;
    uint256 public lastResetTimestamp;

    // ── Global stats ────────────────────────────────────────────────────────
    uint256 public totalSponsored;
    uint256 public totalCalls;

    // ── Per-endpoint config ─────────────────────────────────────────────────
    /// @notice Gas share in basis points (0–10 000). Default = 10 000 (100%).
    mapping(bytes32 => uint16) public endpointSponsorshipBps;

    // ── Events ──────────────────────────────────────────────────────────────
    event GasSponsored(
        address indexed agent,
        bytes32 indexed endpointHash,
        uint256 gasUsed,
        uint16  sponsorshipBps
    );
    event DailyBudgetSet(uint256 newBudget);
    event EndpointSponsorshipSet(bytes32 indexed endpointHash, uint16 bps);
    event BudgetReset(uint256 timestamp);

    constructor(
        IEntryPoint _entryPoint,
        uint256 _dailyBudget
    ) BasePaymaster(_entryPoint) {
        dailyBudget        = _dailyBudget;
        lastResetTimestamp = block.timestamp;
    }

    // ── Publisher interface ─────────────────────────────────────────────────

    /**
     * @notice Set gas sponsorship % for an endpoint by URL.
     *         Any address can call — publisher sets this for their own endpoints.
     * @param  url URL of the endpoint (keccak256 used as key)
     * @param  bps Sponsorship in basis points (0 = no sponsorship, 10000 = 100%)
     */
    function setEndpointSponsorshipByUrl(string calldata url, uint16 bps) external {
        require(bps <= 10000, "bps > 10000");
        bytes32 hash = keccak256(abi.encodePacked(url));
        endpointSponsorshipBps[hash] = bps;
        emit EndpointSponsorshipSet(hash, bps);
    }

    /**
     * @notice Set gas sponsorship % for an endpoint by pre-computed hash.
     */
    function setEndpointSponsorship(bytes32 endpointHash, uint16 bps) external {
        require(bps <= 10000, "bps > 10000");
        endpointSponsorshipBps[endpointHash] = bps;
        emit EndpointSponsorshipSet(endpointHash, bps);
    }

    // ── Owner-only config ───────────────────────────────────────────────────

    function setDailyBudget(uint256 _dailyBudget) external onlyOwner {
        dailyBudget = _dailyBudget;
        emit DailyBudgetSet(_dailyBudget);
    }

    function getRemainingBudget() external view returns (uint256) {
        if (block.timestamp >= lastResetTimestamp + 1 days) return dailyBudget;
        return dailyBudget > dailySpent ? dailyBudget - dailySpent : 0;
    }

    function getTotalSponsored() external view returns (uint256) {
        return totalSponsored;
    }

    function resetDailyBudget() external {
        require(block.timestamp >= lastResetTimestamp + 1 days, "Too early");
        dailySpent         = 0;
        lastResetTimestamp = block.timestamp;
        emit BudgetReset(block.timestamp);
    }

    function withdrawFunds(address payable recipient, uint256 amount) external onlyOwner {
        entryPoint.withdrawTo(recipient, amount);
    }

    // ── ERC-4337 validation ─────────────────────────────────────────────────

    /**
     * @dev paymasterAndData layout (ERC-4337 v0.7):
     *   [0:20]  paymaster address
     *   [20:36] paymasterVerificationGasLimit (uint128)
     *   [36:52] paymasterPostOpGasLimit (uint128)
     *   [52:84] endpointHash (bytes32)  ← our custom data
     */
    function _validatePaymasterUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 maxCost
    ) internal override returns (bytes memory context, uint256 validationData) {
        // ── Decode endpoint hash from paymasterData ──────────────────────────
        bytes32 endpointHash;
        if (userOp.paymasterAndData.length >= 84) {
            endpointHash = bytes32(userOp.paymasterAndData[52:84]);
        }

        // ── Resolve sponsorship bps (default 100% if not set) ───────────────
        uint16 bps = endpointHash != bytes32(0) ? endpointSponsorshipBps[endpointHash] : 0;
        if (bps == 0) bps = 10000; // default: full sponsorship

        // ── Reset daily budget if 24h passed ────────────────────────────────
        if (block.timestamp >= lastResetTimestamp + 1 days) {
            dailySpent         = 0;
            lastResetTimestamp = block.timestamp;
            emit BudgetReset(block.timestamp);
        }

        // ── Budget check: only count the sponsored portion ──────────────────
        uint256 coveredCost = (maxCost * bps) / 10000;
        require(dailySpent + coveredCost <= dailyBudget, "Daily gas budget exceeded");
        dailySpent += coveredCost;

        context        = abi.encode(userOp.sender, userOpHash, maxCost, bps, endpointHash);
        validationData = 0;
    }

    /**
     * @dev Post-op: refine budget with actual gas, emit event.
     */
    function _postOp(
        PostOpMode /*mode*/,
        bytes calldata context,
        uint256 actualGasCost,
        uint256 /*actualUserOpFeePerGas*/
    ) internal override {
        (
            address agent,
            bytes32 userOpHash,
            uint256 maxCost,
            uint16  bps,
            bytes32 endpointHash
        ) = abi.decode(context, (address, bytes32, uint256, uint16, bytes32));

        // Covered costs at max vs actual
        uint256 coveredMax    = (maxCost      * bps) / 10000;
        uint256 coveredActual = (actualGasCost * bps) / 10000;

        // Refund over-reserved budget
        if (coveredMax > coveredActual && dailySpent >= coveredMax - coveredActual) {
            dailySpent -= (coveredMax - coveredActual);
        }

        totalSponsored += coveredActual;
        totalCalls     += 1;

        emit GasSponsored(agent, endpointHash != bytes32(0) ? endpointHash : userOpHash, coveredActual, bps);
    }
}
