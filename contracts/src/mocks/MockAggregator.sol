// SPDX-License-Identifier: MIT
// MOCK — testnet only. An owner-set price feed implementing the AggregatorV3 interface.
pragma solidity ^0.8.28;

import {IAggregatorV3} from "../interfaces/IAggregatorV3.sol";

contract MockAggregator is IAggregatorV3 {
    address public owner;
    int256 public answer;
    uint256 public updatedAt;
    uint80 public roundId;
    string public description;

    constructor(string memory description_, int256 initialAnswer) {
        owner = msg.sender;
        description = description_;
        _set(initialAnswer);
    }

    function isMock() external pure returns (bool) {
        return true;
    }

    function decimals() external pure returns (uint8) {
        return 8;
    }

    function setAnswer(int256 newAnswer) external {
        require(msg.sender == owner, "owner only");
        _set(newAnswer);
    }

    /// @notice Refresh the timestamp without changing the price (keeps the feed fresh on testnets).
    function poke() external {
        updatedAt = block.timestamp;
        roundId++;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, updatedAt, updatedAt, roundId);
    }

    function _set(int256 a) internal {
        answer = a;
        updatedAt = block.timestamp;
        roundId++;
    }
}
