// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {PolicyVault} from "./PolicyVault.sol";
import {IPolicyVault} from "./interfaces/IPolicyVault.sol";

/// @title VaultFactory — one owner-signed transaction puts the mandate on-chain.
/// @notice Vaults are EIP-1167 clones of a locked implementation, created and initialised atomically.
contract VaultFactory {
    error OwnerMustSign();

    event VaultCreated(address indexed owner, address indexed vault, bytes32 mandateHash);

    address public immutable implementation;
    address[] public vaults;
    mapping(address => address[]) internal _vaultsOf;

    constructor() {
        implementation = address(new PolicyVault());
    }

    /// @dev Only the future owner may create their vault, so the creation tx is the owner's signature on the mandate.
    function createVault(
        IPolicyVault.Config calldata cfg,
        IPolicyVault.InitialPayee[] calldata initialPayees,
        address[] calldata assets,
        IPolicyVault.AssetPolicy[] calldata policies,
        address[2][] calldata pairs
    ) external returns (address vault) {
        if (msg.sender != cfg.owner) revert OwnerMustSign();
        vault = Clones.clone(implementation);
        PolicyVault(payable(vault)).initialize(cfg, initialPayees, assets, policies, pairs);
        vaults.push(vault);
        _vaultsOf[msg.sender].push(vault);
        emit VaultCreated(msg.sender, vault, cfg.mandateHash);
    }

    function vaultsOf(address owner) external view returns (address[] memory) {
        return _vaultsOf[owner];
    }

    function vaultCount() external view returns (uint256) {
        return vaults.length;
    }
}
