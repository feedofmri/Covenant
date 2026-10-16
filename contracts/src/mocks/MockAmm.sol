// SPDX-License-Identifier: MIT
// MOCK — testnet only. Our own minimal constant-product pool + router (no Uniswap code).
// Deliberately skewable so the price-manipulation red-team case can be demonstrated.
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IAmmRouter} from "../interfaces/IAmmRouter.sol";

contract MockAmm is IAmmRouter {
    using SafeERC20 for IERC20;

    uint256 public constant FEE_BPS = 5; // 0.05 %
    mapping(address => mapping(address => uint256)) public reserve; // reserve[pairKeyToken][token]

    event LiquidityAdded(address indexed a, address indexed b, uint256 amountA, uint256 amountB);
    event Swap(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, address to);

    function isMock() external pure returns (bool) {
        return true;
    }

    function addLiquidity(address a, address b, uint256 amountA, uint256 amountB) external {
        IERC20(a).safeTransferFrom(msg.sender, address(this), amountA);
        IERC20(b).safeTransferFrom(msg.sender, address(this), amountB);
        reserve[b][a] += amountA; // reserve of a in pool (a,b)
        reserve[a][b] += amountB; // reserve of b in pool (a,b)
        emit LiquidityAdded(a, b, amountA, amountB);
    }

    function getReserves(address tokenIn, address tokenOut) public view returns (uint256 rIn, uint256 rOut) {
        rIn = reserve[tokenOut][tokenIn];
        rOut = reserve[tokenIn][tokenOut];
    }

    function quote(address tokenIn, address tokenOut, uint256 amountIn) public view returns (uint256) {
        (uint256 rIn, uint256 rOut) = getReserves(tokenIn, tokenOut);
        if (rIn == 0 || rOut == 0) return 0;
        uint256 inWithFee = amountIn * (10_000 - FEE_BPS);
        return inWithFee * rOut / (rIn * 10_000 + inWithFee);
    }

    function swapExactIn(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address recipient)
        external
        returns (uint256 amountOut)
    {
        amountOut = quote(tokenIn, tokenOut, amountIn);
        require(amountOut >= minOut && amountOut > 0, "slippage");
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        reserve[tokenOut][tokenIn] += amountIn;
        reserve[tokenIn][tokenOut] -= amountOut;
        IERC20(tokenOut).safeTransfer(recipient, amountOut);
        emit Swap(tokenIn, tokenOut, amountIn, amountOut, recipient);
    }
}
