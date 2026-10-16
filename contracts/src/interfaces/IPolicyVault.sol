// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IPolicyVault — frozen interface between the contract, the agent and the UI.
/// @notice The agent key can only call the adapter functions below. There is no generic call path.
interface IPolicyVault {
    // ─────────────────────────────── Types ───────────────────────────────

    struct AssetPolicy {
        bool allowed;
        bool isStable; // depeg rule applies
        uint128 perTxCap; // T1 per-payment / per-swap cap
        uint128 dailyCap; // T1 24 h payment outflow cap
        uint128 t2Ceiling; // max owner-approved proposal; above = T3
        uint128 dailySwapCap; // 24 h swap-in volume cap
        uint128 lendingCap; // max supplied to the lending pool
        address oracle; // AggregatorV3, USD price
    }

    struct Payee {
        address wallet;
        uint64 activeFrom; // timestamp the payee becomes usable (cooling-off end)
        bool active;
        bool firstPaid; // first payment must be owner-approved (T2)
        bytes32 labelHash;
    }

    struct Action {
        uint8 kind; // 0 = PAY
        bytes32 payeeId;
        address asset;
        uint256 amount;
        bytes32 bucket;
    }

    struct Proposal {
        Action action;
        bytes32 intentHash;
        uint64 expiresAt;
        uint8 status; // 0 open, 1 executed, 2 cancelled
    }

    struct InitialPayee {
        bytes32 id;
        address wallet;
        bytes32 labelHash;
    }

    struct Config {
        address owner;
        address guardian;
        address agent;
        uint64 agentExpiresAt;
        address router;
        address lendingPool;
        uint32 coolingOff;
        uint32 timelockDelay;
        uint32 proposalTtl;
        uint16 maxSlippageBps;
        uint16 depegBps;
        uint32 maxOracleStaleness;
        bytes32 mandateHash;
    }

    // ─────────────────────────────── Errors ──────────────────────────────

    error T3_UnknownPayee(bytes32 payeeId);
    error T3_PairNotAllowed(address assetIn, address assetOut);
    error T3_AssetNotAllowed(address asset);
    error T3_AboveT2Ceiling(uint256 amount, uint256 ceiling);
    error T3_NotAgent();
    error T3_NotOwner();
    error T3_NotGuardian();
    error T3_AgentExpired();
    error T3_Depegged(address asset, int256 price);
    error T3_StaleOracle(address asset);
    error T3_ResidualApproval();
    error T3_SlippageFloor(uint256 received, uint256 minOut);
    error T3_InputMismatch(uint256 spent, uint256 expected);
    error T3_NoGenericCalls();
    error T2_PayeeCoolingOff(bytes32 payeeId, uint64 activeFrom);
    error T2_FirstPaymentNeedsOwner(bytes32 payeeId);
    error T2_AbovePerTxCap(uint256 amount, uint256 cap);
    error T2_DailyCapExceeded(uint256 wouldBe, uint256 cap);
    error T2_DailySwapCapExceeded(uint256 wouldBe, uint256 cap);
    error T2_LendingCapExceeded(uint256 wouldBe, uint256 cap);
    error ProposalExpired(uint256 id);
    error ProposalNotOpen(uint256 id);
    error InsufficientBucket(bytes32 bucket, uint256 available, uint256 needed);
    error InsufficientUnallocated(uint256 available, uint256 needed);
    error VaultPaused();
    error TimelockNotReady(bytes32 changeHash, uint64 eta);
    error ChangeNotQueued(bytes32 changeHash);
    error InvalidParams();

    // ─────────────────────────────── Events ──────────────────────────────

    event Allocated(address indexed asset, bytes32[] buckets, uint256[] amounts, bytes32 intentHash);
    event Reallocated(address indexed asset, bytes32 from, bytes32 to, uint256 amount, bytes32 intentHash);
    event Paid(bytes32 indexed payeeId, address indexed asset, uint256 amount, bytes32 bucket, bytes32 intentHash);
    event Swapped(
        address indexed assetIn,
        address indexed assetOut,
        uint256 amountIn,
        uint256 amountOut,
        bytes32 bucket,
        bytes32 intentHash
    );
    event Supplied(address indexed asset, uint256 amount, bytes32 bucket, bytes32 intentHash);
    event Withdrawn(address indexed asset, uint256 amount, bytes32 bucket, bytes32 intentHash);
    event Proposed(uint256 indexed id, Action action, bytes32 intentHash, uint64 expiresAt);
    event Approved(uint256 indexed id, address signer);
    event Cancelled(uint256 indexed id, address by);
    event PayeeAdded(bytes32 indexed payeeId, address wallet, uint64 activeFrom, bytes32 labelHash);
    event PayeeRemoved(bytes32 indexed payeeId);
    event ChangeQueued(bytes32 indexed changeHash, bytes data, uint64 eta);
    event ChangeExecuted(bytes32 indexed changeHash);
    event ChangeCancelled(bytes32 indexed changeHash);
    event Paused(address by);
    event Unpaused(address by);
    event AgentSet(address agent, uint64 expiresAt);
    event GuardianSet(address guardian);
    event PolicyTightened(address indexed asset);
    event PairSet(address indexed assetIn, address indexed assetOut, bool allowed);
    event AssetPolicySet(address indexed asset);
    event MandateSet(bytes32 mandateHash);
    event OwnerWithdrawal(address indexed asset, address indexed to, uint256 amount);
    event OwnerWithdrawalQueued(bytes32 indexed changeHash, address asset, address to, uint256 amount, uint64 eta);

    // ─────────────────────────── Agent (T1 / T2) ─────────────────────────

    function allocate(address asset, bytes32[] calldata buckets, uint256[] calldata amounts, bytes32 intentHash)
        external;
    function reallocate(address asset, bytes32 from, bytes32 to, uint256 amount, bytes32 intentHash) external;
    function pay(bytes32 payeeId, address asset, uint256 amount, bytes32 bucket, bytes32 intentHash) external;
    function swap(bytes32 bucket, address assetIn, address assetOut, uint256 amountIn, bytes32 intentHash)
        external;
    function supply(bytes32 bucket, address asset, uint256 amount, bytes32 intentHash) external;
    function withdraw(bytes32 bucket, address asset, uint256 amount, bytes32 intentHash) external;
    function propose(Action calldata action, bytes32 intentHash) external returns (uint256 id);

    // ─────────────────────────────── Owner ───────────────────────────────

    function approve(uint256 id) external;
    function approveWithSig(uint256 id, uint256 deadline, bytes calldata signature) external;
    function cancel(uint256 id) external;
    function addPayee(bytes32 payeeId, address wallet, bytes32 labelHash) external;
    function removePayee(bytes32 payeeId) external;
    function lowerCaps(address asset, uint128 perTxCap, uint128 dailyCap, uint128 t2Ceiling, uint128 dailySwapCap)
        external;
    function removePair(address assetIn, address assetOut) external;
    function queueChange(bytes calldata data) external returns (bytes32 changeHash);
    function executeChange(bytes calldata data) external;
    function cancelChange(bytes32 changeHash) external;
    function ownerWithdraw(address asset, address to, uint256 amount) external;
    function unpause() external;

    // ────────────────────────── Owner or guardian ────────────────────────

    function pause() external;
    function revokeAgent() external;

    // ─────────────────────────────── Views ───────────────────────────────

    function unallocated(address asset) external view returns (uint256);
    function outflowLast24h(address asset) external view returns (uint256);
    function swapVolumeLast24h(address asset) external view returns (uint256);
    function getPayee(bytes32 payeeId) external view returns (Payee memory);
    function getProposal(uint256 id) external view returns (Proposal memory);
    function getAssetPolicy(address asset) external view returns (AssetPolicy memory);
}
