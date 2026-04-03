// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@account-abstraction/contracts/core/BasePaymaster.sol";
import "@account-abstraction/contracts/interfaces/IEntryPoint.sol";

/**
 * @title AgentGatePaymaster
 * @notice ERC-4337 Paymaster that sponsors gas for AI agents calling registered endpoints.
 *         Deployed by each publisher to attract more agent traffic.
 *         BasePaymaster already inherits Ownable — no need to re-import.
 */
contract AgentGatePaymaster is BasePaymaster {
    // Daily budget tracking
    uint256 public dailyBudget;
    uint256 public dailySpent;
    uint256 public lastResetTimestamp;

    // Total stats
    uint256 public totalSponsored;
    uint256 public totalCalls;

    // Registered endpoints this paymaster covers
    mapping(bytes32 => bool) public registeredEndpoints;

    // Events
    event GasSponsored(address indexed agent, bytes32 indexed endpointHash, uint256 gasUsed);
    event DailyBudgetSet(uint256 newBudget);
    event EndpointRegistered(bytes32 indexed endpointHash);
    event EndpointDeregistered(bytes32 indexed endpointHash);
    event BudgetReset(uint256 timestamp);

    constructor(
        IEntryPoint _entryPoint,
        uint256 _dailyBudget
    ) BasePaymaster(_entryPoint) {
        dailyBudget = _dailyBudget;
        lastResetTimestamp = block.timestamp;
    }

    /**
     * @notice Register an endpoint hash that this paymaster will sponsor
     */
    function registerEndpoint(string calldata url) external onlyOwner {
        bytes32 hash = keccak256(abi.encodePacked(url));
        registeredEndpoints[hash] = true;
        emit EndpointRegistered(hash);
    }

    /**
     * @notice Deregister an endpoint
     */
    function deregisterEndpoint(string calldata url) external onlyOwner {
        bytes32 hash = keccak256(abi.encodePacked(url));
        registeredEndpoints[hash] = false;
        emit EndpointDeregistered(hash);
    }

    /**
     * @notice Set a new daily budget
     */
    function setDailyBudget(uint256 _dailyBudget) external onlyOwner {
        dailyBudget = _dailyBudget;
        emit DailyBudgetSet(_dailyBudget);
    }

    /**
     * @notice Get remaining budget for today
     */
    function getRemainingBudget() external view returns (uint256) {
        if (block.timestamp >= lastResetTimestamp + 1 days) {
            return dailyBudget;
        }
        if (dailyBudget > dailySpent) {
            return dailyBudget - dailySpent;
        }
        return 0;
    }

    /**
     * @notice Get total gas sponsored across all time
     */
    function getTotalSponsored() external view returns (uint256) {
        return totalSponsored;
    }

    /**
     * @notice Reset daily counter (callable by anyone after 24h)
     */
    function resetDailyBudget() external {
        require(block.timestamp >= lastResetTimestamp + 1 days, "Too early to reset");
        dailySpent = 0;
        lastResetTimestamp = block.timestamp;
        emit BudgetReset(block.timestamp);
    }

    /**
     * @notice Withdraw unused funds
     */
    function withdrawFunds(address payable recipient, uint256 amount) external onlyOwner {
        entryPoint.withdrawTo(recipient, amount);
    }

    /**
     * @notice Internal validation — checks daily budget and accepts all ops
     */
    function _validatePaymasterUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 maxCost
    ) internal override returns (bytes memory context, uint256 validationData) {
        // Reset daily budget if 24h has passed
        if (block.timestamp >= lastResetTimestamp + 1 days) {
            dailySpent = 0;
            lastResetTimestamp = block.timestamp;
            emit BudgetReset(block.timestamp);
        }

        // Check daily budget
        require(dailySpent + maxCost <= dailyBudget, "Daily gas budget exceeded");

        // Update spent (will be refined in postOp with actual cost)
        dailySpent += maxCost;

        // Return context with sender for postOp
        context = abi.encode(userOp.sender, userOpHash, maxCost);
        validationData = 0; // valid immediately, no time range
    }

    /**
     * @notice Post-op: update stats with actual gas used
     */
    function _postOp(
        PostOpMode mode,
        bytes calldata context,
        uint256 actualGasCost,
        uint256 actualUserOpFeePerGas
    ) internal override {
        (address agent, bytes32 userOpHash, uint256 maxCost) = abi.decode(
            context,
            (address, bytes32, uint256)
        );

        // Refund over-reserved budget
        if (maxCost > actualGasCost && dailySpent >= maxCost - actualGasCost) {
            dailySpent -= (maxCost - actualGasCost);
        }

        totalSponsored += actualGasCost;
        totalCalls += 1;

        emit GasSponsored(agent, userOpHash, actualGasCost);
    }
}
