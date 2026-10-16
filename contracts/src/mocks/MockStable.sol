// SPDX-License-Identifier: MIT
// MOCK — testnet only. A faucet-mintable 6-decimal stablecoin with an optional transfer memo.
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockStable is ERC20 {
    event Memo(address indexed from, address indexed to, uint256 amount, string memo);

    address public faucet;
    uint256 public constant FAUCET_LIMIT = 1_000_000e6;

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        faucet = msg.sender;
    }

    function isMock() external pure returns (bool) {
        return true;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function setFaucet(address newFaucet) external {
        require(msg.sender == faucet, "faucet only");
        faucet = newFaucet;
    }

    function mint(address to, uint256 amount) external {
        require(msg.sender == faucet, "faucet only");
        require(amount <= FAUCET_LIMIT, "limit");
        _mint(to, amount);
    }

    /// @notice A transfer that carries free text. The agent treats memos as untrusted data.
    function transferWithMemo(address to, uint256 amount, string calldata memo) external returns (bool) {
        _transfer(msg.sender, to, amount);
        emit Memo(msg.sender, to, amount, memo);
        return true;
    }
}
