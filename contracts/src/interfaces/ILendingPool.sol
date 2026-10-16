// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Aave-v3-shaped lending interface (written from the public ABI; no Aave code is used).
interface ILendingPool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}
