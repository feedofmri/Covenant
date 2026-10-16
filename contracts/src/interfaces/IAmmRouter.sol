// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Router the vault swaps through. The vault always passes itself as recipient.
interface IAmmRouter {
    function swapExactIn(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address recipient)
        external
        returns (uint256 amountOut);

    function quote(address tokenIn, address tokenOut, uint256 amountIn) external view returns (uint256 amountOut);
}
