// SPDX-License-Identifier: MIT
// MOCK — red-team only. Hostile tokens and a hostile router used to prove the vault's defences.
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Its name is a prompt-injection payload. Airdropped to the vault to test the intent firewall.
contract MaliciousNameToken is ERC20 {
    constructor(string memory payload) ERC20(payload, "CLAIM") {
        _mint(msg.sender, 1_000_000e18);
    }
}

/// @notice Takes a 10 % fee on every transfer.
contract FeeOnTransferToken is ERC20 {
    constructor() ERC20("Fee Token", "FEE") {
        _mint(msg.sender, 1_000_000e6);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 10;
            super._update(from, address(0xdead), fee);
            value -= fee;
        }
        super._update(from, to, value);
    }
}

/// @notice A router that pulls only half the approved amount, leaving a residual allowance.
contract LeakyRouter {
    function swapExactIn(address tokenIn, address tokenOut, uint256 amountIn, uint256, address recipient)
        external
        returns (uint256)
    {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn / 2);
        uint256 out = IERC20(tokenOut).balanceOf(address(this));
        if (out > amountIn) out = amountIn;
        IERC20(tokenOut).transfer(recipient, out);
        return out;
    }

    function quote(address, address, uint256 amountIn) external pure returns (uint256) {
        return amountIn;
    }
}

/// @notice A router that ignores the recipient and keeps the output (proves the delta check).
contract ThievingRouter {
    function swapExactIn(address tokenIn, address, uint256 amountIn, uint256, address) external returns (uint256) {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        return amountIn; // claims success, sends nothing
    }

    function quote(address, address, uint256 amountIn) external pure returns (uint256) {
        return amountIn;
    }
}
