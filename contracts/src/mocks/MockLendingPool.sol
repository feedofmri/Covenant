// SPDX-License-Identifier: MIT
// MOCK — testnet only. Aave-shaped lending pool with a fixed simple APR, funded from a reserve.
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ILendingPool} from "../interfaces/ILendingPool.sol";

contract MockLendingPool is ILendingPool {
    using SafeERC20 for IERC20;

    uint256 public immutable aprBps;
    struct Position {
        uint256 principal;
        uint256 accrued;
        uint256 updatedAt;
    }
    mapping(address => mapping(address => Position)) public positions; // asset => account => position

    event Supply(address indexed asset, address indexed onBehalfOf, uint256 amount);
    event Withdraw(address indexed asset, address indexed account, address to, uint256 amount);

    constructor(uint256 aprBps_) {
        aprBps = aprBps_;
    }

    function isMock() external pure returns (bool) {
        return true;
    }

    function balanceOf(address asset, address account) public view returns (uint256) {
        Position memory p = positions[asset][account];
        return p.principal + p.accrued + _interest(p);
    }

    function supply(address asset, uint256 amount, address onBehalfOf, uint16) external {
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
        Position storage p = _touch(asset, onBehalfOf);
        p.principal += amount;
        emit Supply(asset, onBehalfOf, amount);
    }

    function withdraw(address asset, uint256 amount, address to) external returns (uint256) {
        Position storage p = _touch(asset, msg.sender);
        uint256 total = p.principal + p.accrued;
        if (amount == type(uint256).max || amount > total) amount = total;
        uint256 fromAccrued = amount <= p.accrued ? amount : p.accrued;
        p.accrued -= fromAccrued;
        p.principal -= amount - fromAccrued;
        IERC20(asset).safeTransfer(to, amount);
        emit Withdraw(asset, msg.sender, to, amount);
        return amount;
    }

    function _touch(address asset, address account) internal returns (Position storage p) {
        p = positions[asset][account];
        p.accrued += _interest(p);
        p.updatedAt = block.timestamp;
    }

    function _interest(Position memory p) internal view returns (uint256) {
        if (p.updatedAt == 0) return 0;
        return p.principal * aprBps * (block.timestamp - p.updatedAt) / (10_000 * 365 days);
    }
}
