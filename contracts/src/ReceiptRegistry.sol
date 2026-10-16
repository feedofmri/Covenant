// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ReceiptRegistry — tamper-evident anchors for Verifiable Intent Receipts.
/// @notice Anyone may anchor; verifiers check that the anchoring address was the vault's agent at that block.
contract ReceiptRegistry {
    event Anchored(address indexed agent, bytes32 indexed receiptHash, bytes32 indexed intentHash);
    event BatchAnchored(address indexed agent, bytes32 merkleRoot, uint32 count);

    mapping(bytes32 => uint64) public anchoredAt; // receiptHash or merkleRoot => block timestamp

    function anchor(bytes32 receiptHash, bytes32 intentHash) external {
        if (anchoredAt[receiptHash] == 0) anchoredAt[receiptHash] = uint64(block.timestamp);
        emit Anchored(msg.sender, receiptHash, intentHash);
    }

    function anchorBatch(bytes32 merkleRoot, uint32 count) external {
        if (anchoredAt[merkleRoot] == 0) anchoredAt[merkleRoot] = uint64(block.timestamp);
        emit BatchAnchored(msg.sender, merkleRoot, count);
    }
}
