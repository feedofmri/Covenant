// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {IPolicyVault} from "./interfaces/IPolicyVault.sol";
import {IAggregatorV3} from "./interfaces/IAggregatorV3.sol";
import {IAmmRouter} from "./interfaces/IAmmRouter.sol";
import {ILendingPool} from "./interfaces/ILendingPool.sol";

/// @title PolicyVault — the contract that disposes.
/// @notice Holds a family's funds. An AI agent may act only through named adapters whose recipients are
///         fixed by construction: registered payees (pay) or the vault itself (swap, supply, withdraw).
///         Caps, cooling-off periods, oracle floors and the tier model are enforced here, regardless of
///         what the off-chain agent decided.
contract PolicyVault is IPolicyVault, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    uint8 internal constant KIND_PAY = 0;
    uint8 internal constant OPEN = 0;
    uint8 internal constant EXECUTED = 1;
    uint8 internal constant CANCELLED = 2;
    uint256 internal constant WINDOW_SLOTS = 24; // 24 h sliding window at 1 h granularity
    uint256 internal constant MAX_BUCKETS = 8;
    bytes32 internal constant APPROVE_TYPEHASH = keccak256("Approve(uint256 id,uint256 deadline)");

    // ───────────────────────────── Roles ─────────────────────────────
    address public owner;
    address public guardian;
    address public agent;
    uint64 public agentExpiresAt;
    bool public paused;

    // ───────────────────────────── Policy ────────────────────────────
    mapping(address => AssetPolicy) internal _assetPolicy;
    mapping(address => mapping(address => bool)) public allowedPair;
    mapping(bytes32 => Payee) internal _payees;
    mapping(address => bytes32) public payeeIdByWallet;
    bytes32 public mandateHash;
    uint32 public coolingOff;
    uint32 public timelockDelay;
    uint32 public proposalTtl;
    uint16 public maxSlippageBps;
    uint16 public depegBps;
    uint32 public maxOracleStaleness;
    address public router;
    address public lendingPool;

    // ──────────────────────────── Accounting ─────────────────────────
    mapping(address => mapping(bytes32 => uint256)) public bucketBalance;
    mapping(address => uint256) public totalAllocated;
    mapping(address => uint256) public supplied;
    bytes32[] internal _bucketIds;
    mapping(bytes32 => bool) internal _knownBucket;

    mapping(address => uint256[24]) internal _outflowSlots;
    mapping(address => uint64[24]) internal _outflowSlotHour;
    mapping(address => uint256[24]) internal _swapSlots;
    mapping(address => uint64[24]) internal _swapSlotHour;

    // ──────────────────────────── Governance ─────────────────────────
    mapping(uint256 => Proposal) internal _proposals;
    uint256 public nextProposalId;
    mapping(bytes32 => uint64) public queuedChanges; // changeHash => eta

    // ──────────────────────────── Modifiers ──────────────────────────
    modifier onlyOwner() {
        if (msg.sender != owner) revert T3_NotOwner();
        _;
    }

    modifier onlyAgent() {
        if (msg.sender != agent || agent == address(0)) revert T3_NotAgent();
        if (block.timestamp > agentExpiresAt) revert T3_AgentExpired();
        if (paused) revert VaultPaused();
        _;
    }

    modifier onlyOwnerOrGuardian() {
        if (msg.sender != owner && msg.sender != guardian) revert T3_NotGuardian();
        _;
    }

    modifier onlySelf() {
        if (msg.sender != address(this)) revert T3_NotOwner();
        _;
    }

    bool internal _initialized;

    /// @dev The implementation is locked; vaults are EIP-1167 clones initialised by the factory in one tx.
    constructor() EIP712("Covenant PolicyVault", "1") {
        _initialized = true;
    }

    function initialize(
        Config calldata cfg,
        InitialPayee[] calldata initialPayees,
        address[] calldata assets,
        AssetPolicy[] calldata policies,
        address[2][] calldata pairs
    ) external {
        if (_initialized) revert InvalidParams();
        _initialized = true;
        if (cfg.owner == address(0) || assets.length != policies.length) revert InvalidParams();
        if (cfg.maxSlippageBps > 1_000 || cfg.proposalTtl == 0) revert InvalidParams();
        owner = cfg.owner;
        guardian = cfg.guardian;
        agent = cfg.agent;
        agentExpiresAt = cfg.agentExpiresAt;
        router = cfg.router;
        lendingPool = cfg.lendingPool;
        coolingOff = cfg.coolingOff;
        timelockDelay = cfg.timelockDelay;
        proposalTtl = cfg.proposalTtl;
        maxSlippageBps = cfg.maxSlippageBps;
        depegBps = cfg.depegBps;
        maxOracleStaleness = cfg.maxOracleStaleness;
        mandateHash = cfg.mandateHash;

        // Deployment-ceremony payees are trusted by the owner at setup: no cooling-off, first payment allowed.
        for (uint256 i; i < initialPayees.length; ++i) {
            InitialPayee calldata p = initialPayees[i];
            _registerPayee(p.id, p.wallet, p.labelHash, uint64(block.timestamp), true);
        }
        for (uint256 i; i < assets.length; ++i) {
            _assetPolicy[assets[i]] = policies[i];
            emit AssetPolicySet(assets[i]);
        }
        for (uint256 i; i < pairs.length; ++i) {
            allowedPair[pairs[i][0]][pairs[i][1]] = true;
            emit PairSet(pairs[i][0], pairs[i][1], true);
        }
        emit AgentSet(cfg.agent, cfg.agentExpiresAt);
        emit GuardianSet(cfg.guardian);
        emit MandateSet(cfg.mandateHash);
    }

    /// @notice No generic call path exists. Any unknown selector or plain ETH transfer reverts.
    fallback() external payable {
        revert T3_NoGenericCalls();
    }

    receive() external payable {
        revert T3_NoGenericCalls();
    }

    // ═════════════════════════ Agent adapters (T1) ═════════════════════════

    /// @notice Split unallocated funds (e.g. an incoming salary) into buckets. Value never leaves the vault.
    function allocate(address asset, bytes32[] calldata buckets, uint256[] calldata amounts, bytes32 intentHash)
        external
        onlyAgent
    {
        if (buckets.length != amounts.length || buckets.length == 0) revert InvalidParams();
        if (!_assetPolicy[asset].allowed) revert T3_AssetNotAllowed(asset);
        uint256 total;
        for (uint256 i; i < amounts.length; ++i) {
            total += amounts[i];
        }
        uint256 free = unallocated(asset);
        if (total > free) revert InsufficientUnallocated(free, total);
        for (uint256 i; i < buckets.length; ++i) {
            _credit(asset, buckets[i], amounts[i]);
        }
        emit Allocated(asset, buckets, amounts, intentHash);
    }

    function reallocate(address asset, bytes32 from, bytes32 to, uint256 amount, bytes32 intentHash)
        external
        onlyAgent
    {
        _debit(asset, from, amount);
        _credit(asset, to, amount);
        emit Reallocated(asset, from, to, amount, intentHash);
    }

    /// @notice Pay a registered payee. The recipient comes from the registry, never from the caller.
    function pay(bytes32 payeeId, address asset, uint256 amount, bytes32 bucket, bytes32 intentHash)
        external
        onlyAgent
        nonReentrant
    {
        AssetPolicy memory ap = _assetPolicy[asset];
        if (!ap.allowed) revert T3_AssetNotAllowed(asset);
        Payee storage p = _payees[payeeId];
        if (!p.active) revert T3_UnknownPayee(payeeId);
        if (block.timestamp < p.activeFrom) revert T2_PayeeCoolingOff(payeeId, p.activeFrom);
        if (!p.firstPaid) revert T2_FirstPaymentNeedsOwner(payeeId);
        if (amount > ap.t2Ceiling) revert T3_AboveT2Ceiling(amount, ap.t2Ceiling);
        if (amount > ap.perTxCap) revert T2_AbovePerTxCap(amount, ap.perTxCap);
        uint256 wouldBe = outflowLast24h(asset) + amount;
        if (wouldBe > ap.dailyCap) revert T2_DailyCapExceeded(wouldBe, ap.dailyCap);

        _debit(asset, bucket, amount);
        _record(_outflowSlots[asset], _outflowSlotHour[asset], amount);
        IERC20(asset).safeTransfer(p.wallet, amount);
        emit Paid(payeeId, asset, amount, bucket, intentHash);
    }

    /// @notice Swap within the vault. Recipient is hard-coded to the vault; output is measured by balance delta
    ///         and must clear an oracle-derived floor.
    function swap(bytes32 bucket, address assetIn, address assetOut, uint256 amountIn, bytes32 intentHash)
        external
        onlyAgent
        nonReentrant
    {
        if (!allowedPair[assetIn][assetOut]) revert T3_PairNotAllowed(assetIn, assetOut);
        AssetPolicy memory pin = _assetPolicy[assetIn];
        AssetPolicy memory pout = _assetPolicy[assetOut];
        if (!pin.allowed) revert T3_AssetNotAllowed(assetIn);
        if (!pout.allowed) revert T3_AssetNotAllowed(assetOut);
        if (amountIn > pin.perTxCap) revert T2_AbovePerTxCap(amountIn, pin.perTxCap);
        uint256 wouldBe = swapVolumeLast24h(assetIn) + amountIn;
        if (wouldBe > pin.dailySwapCap) revert T2_DailySwapCapExceeded(wouldBe, pin.dailySwapCap);

        uint256 minOut = _swapMinOut(assetIn, pin, assetOut, pout, amountIn);
        _debit(assetIn, bucket, amountIn);
        _record(_swapSlots[assetIn], _swapSlotHour[assetIn], amountIn);
        uint256 received = _executeSwap(assetIn, assetOut, amountIn, minOut);
        _credit(assetOut, bucket, received);
        emit Swapped(assetIn, assetOut, amountIn, received, bucket, intentHash);
    }

    /// @notice Supply idle savings to the lending pool on behalf of the vault, within the lending cap.
    function supply(bytes32 bucket, address asset, uint256 amount, bytes32 intentHash)
        external
        onlyAgent
        nonReentrant
    {
        AssetPolicy memory ap = _assetPolicy[asset];
        if (!ap.allowed) revert T3_AssetNotAllowed(asset);
        if (ap.isStable) _price(asset, ap); // reverts when depegged or stale
        uint256 wouldBe = supplied[asset] + amount;
        if (wouldBe > ap.lendingCap) revert T2_LendingCapExceeded(wouldBe, ap.lendingCap);

        _debit(asset, bucket, amount);
        supplied[asset] = wouldBe;
        uint256 before = IERC20(asset).balanceOf(address(this));
        IERC20(asset).forceApprove(lendingPool, amount);
        ILendingPool(lendingPool).supply(asset, amount, address(this), 0);
        if (IERC20(asset).allowance(address(this), lendingPool) != 0) revert T3_ResidualApproval();
        uint256 spent = before - IERC20(asset).balanceOf(address(this));
        if (spent != amount) revert T3_InputMismatch(spent, amount);
        emit Supplied(asset, amount, bucket, intentHash);
    }

    /// @notice Withdraw from the lending pool back into the vault. Callable by the agent or the owner.
    function withdraw(bytes32 bucket, address asset, uint256 amount, bytes32 intentHash) external nonReentrant {
        if (msg.sender != owner) {
            if (msg.sender != agent || agent == address(0)) revert T3_NotAgent();
            if (block.timestamp > agentExpiresAt) revert T3_AgentExpired();
            if (paused) revert VaultPaused();
        }
        uint256 before = IERC20(asset).balanceOf(address(this));
        ILendingPool(lendingPool).withdraw(asset, amount, address(this)); // to = vault, hard-coded
        uint256 received = IERC20(asset).balanceOf(address(this)) - before;
        supplied[asset] = received >= supplied[asset] ? 0 : supplied[asset] - received;
        _credit(asset, bucket, received);
        emit Withdrawn(asset, received, bucket, intentHash);
    }

    /// @notice Tier 2: the agent proposes, the owner approves.
    function propose(Action calldata action, bytes32 intentHash) external onlyAgent returns (uint256 id) {
        _checkT2(action);
        id = nextProposalId++;
        uint64 expiresAt = uint64(block.timestamp) + proposalTtl;
        _proposals[id] = Proposal({action: action, intentHash: intentHash, expiresAt: expiresAt, status: OPEN});
        emit Proposed(id, action, intentHash, expiresAt);
    }

    // ═══════════════════════════════ Owner ═══════════════════════════════

    function approve(uint256 id) external onlyOwner nonReentrant {
        _execute(id, msg.sender);
    }

    /// @notice Owner co-signs off-chain (EIP-712); anyone (normally the agent) relays.
    function approveWithSig(uint256 id, uint256 deadline, bytes calldata signature) external nonReentrant {
        if (block.timestamp > deadline) revert ProposalExpired(id);
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(APPROVE_TYPEHASH, id, deadline)));
        if (ECDSA.recover(digest, signature) != owner) revert T3_NotOwner();
        _execute(id, owner);
    }

    function cancel(uint256 id) external {
        if (msg.sender != owner && msg.sender != agent) revert T3_NotOwner();
        Proposal storage pr = _proposals[id];
        if (pr.status != OPEN || pr.expiresAt == 0) revert ProposalNotOpen(id);
        pr.status = CANCELLED;
        emit Cancelled(id, msg.sender);
    }

    /// @notice New payees cool off before they can be paid. The cooling-off *is* the payee timelock.
    function addPayee(bytes32 payeeId, address wallet, bytes32 labelHash) external onlyOwner {
        _registerPayee(payeeId, wallet, labelHash, uint64(block.timestamp) + coolingOff, false);
    }

    /// @notice Tightening is instant.
    function removePayee(bytes32 payeeId) external onlyOwner {
        Payee storage p = _payees[payeeId];
        if (!p.active) revert T3_UnknownPayee(payeeId);
        p.active = false;
        delete payeeIdByWallet[p.wallet];
        emit PayeeRemoved(payeeId);
    }

    /// @notice Tightening is instant: each cap may only go down.
    function lowerCaps(address asset, uint128 perTxCap, uint128 dailyCap, uint128 t2Ceiling, uint128 dailySwapCap)
        external
        onlyOwner
    {
        AssetPolicy storage ap = _assetPolicy[asset];
        if (perTxCap > ap.perTxCap || dailyCap > ap.dailyCap || t2Ceiling > ap.t2Ceiling) revert InvalidParams();
        if (dailySwapCap > ap.dailySwapCap) revert InvalidParams();
        ap.perTxCap = perTxCap;
        ap.dailyCap = dailyCap;
        ap.t2Ceiling = t2Ceiling;
        ap.dailySwapCap = dailySwapCap;
        emit PolicyTightened(asset);
    }

    function removePair(address assetIn, address assetOut) external onlyOwner {
        allowedPair[assetIn][assetOut] = false;
        emit PairSet(assetIn, assetOut, false);
    }

    /// @notice The mandate hash only labels receipts; changing it grants no authority, so it is instant.
    function setMandateHash(bytes32 newMandateHash) external onlyOwner {
        mandateHash = newMandateHash;
        emit MandateSet(newMandateHash);
    }

    /// @notice Loosening changes are timelocked. `data` is a call to one of the `change*` functions below.
    function queueChange(bytes calldata data) external onlyOwner returns (bytes32 changeHash) {
        _checkChangeSelector(data);
        changeHash = keccak256(data);
        uint64 eta = uint64(block.timestamp) + timelockDelay;
        queuedChanges[changeHash] = eta;
        emit ChangeQueued(changeHash, data, eta);
    }

    function executeChange(bytes calldata data) external onlyOwner nonReentrant {
        bytes32 changeHash = keccak256(data);
        uint64 eta = queuedChanges[changeHash];
        if (eta == 0) revert ChangeNotQueued(changeHash);
        if (block.timestamp < eta) revert TimelockNotReady(changeHash, eta);
        delete queuedChanges[changeHash];
        (bool ok, bytes memory ret) = address(this).call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        emit ChangeExecuted(changeHash);
    }

    function cancelChange(bytes32 changeHash) external onlyOwner {
        if (queuedChanges[changeHash] == 0) revert ChangeNotQueued(changeHash);
        delete queuedChanges[changeHash];
        emit ChangeCancelled(changeHash);
    }

    /// @notice The owner's own key is guarded too: withdrawals go out instantly only to the owner or a
    ///         cooled-off payee. Any other destination waits out the cooling-off period.
    function ownerWithdraw(address asset, address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == owner || _isUsablePayeeWallet(to)) {
            _ownerWithdraw(asset, to, amount);
            return;
        }
        bytes memory data = abi.encodeCall(this.changeOwnerWithdrawal, (asset, to, amount));
        bytes32 changeHash = keccak256(data);
        uint64 eta = uint64(block.timestamp) + coolingOff;
        queuedChanges[changeHash] = eta;
        emit OwnerWithdrawalQueued(changeHash, asset, to, amount, eta);
        emit ChangeQueued(changeHash, data, eta);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused(msg.sender);
    }

    // ═════════════════════════ Owner or guardian ═════════════════════════

    function pause() external {
        if (msg.sender != owner && msg.sender != guardian && msg.sender != agent) revert T3_NotGuardian();
        paused = true;
        emit Paused(msg.sender);
    }

    function revokeAgent() external onlyOwnerOrGuardian {
        agent = address(0);
        agentExpiresAt = 0;
        emit AgentSet(address(0), 0);
    }

    // ═════════════════ Timelocked change targets (self-call only) ═════════════════

    function changeAssetPolicy(address asset, AssetPolicy calldata policy) external onlySelf {
        _assetPolicy[asset] = policy;
        emit AssetPolicySet(asset);
    }

    function changePair(address assetIn, address assetOut, bool allowed) external onlySelf {
        allowedPair[assetIn][assetOut] = allowed;
        emit PairSet(assetIn, assetOut, allowed);
    }

    /// @notice Rotate roles. The guardian can only ever be set to remove the agent (revokeAgent), never here.
    function changeRoles(address newOwner, address newGuardian, address newAgent, uint64 agentExpiry)
        external
        onlySelf
    {
        if (newOwner == address(0)) revert InvalidParams();
        owner = newOwner;
        guardian = newGuardian;
        agent = newAgent;
        agentExpiresAt = agentExpiry;
        emit GuardianSet(newGuardian);
        emit AgentSet(newAgent, agentExpiry);
    }

    function changeVenues(address newRouter, address newLendingPool) external onlySelf {
        router = newRouter;
        lendingPool = newLendingPool;
    }

    function changeParams(
        uint32 newCoolingOff,
        uint32 newTimelockDelay,
        uint32 newProposalTtl,
        uint16 newMaxSlippageBps,
        uint16 newDepegBps,
        uint32 newMaxOracleStaleness
    ) external onlySelf {
        if (newMaxSlippageBps > 1_000 || newProposalTtl == 0) revert InvalidParams();
        coolingOff = newCoolingOff;
        timelockDelay = newTimelockDelay;
        proposalTtl = newProposalTtl;
        maxSlippageBps = newMaxSlippageBps;
        depegBps = newDepegBps;
        maxOracleStaleness = newMaxOracleStaleness;
    }

    function changeOwnerWithdrawal(address asset, address to, uint256 amount) external onlySelf {
        _ownerWithdraw(asset, to, amount);
    }

    // ═══════════════════════════════ Views ═══════════════════════════════

    function unallocated(address asset) public view returns (uint256) {
        uint256 bal = IERC20(asset).balanceOf(address(this));
        uint256 alloc = totalAllocated[asset];
        return bal > alloc ? bal - alloc : 0;
    }

    function outflowLast24h(address asset) public view returns (uint256) {
        return _windowSum(_outflowSlots[asset], _outflowSlotHour[asset]);
    }

    function swapVolumeLast24h(address asset) public view returns (uint256) {
        return _windowSum(_swapSlots[asset], _swapSlotHour[asset]);
    }

    function getPayee(bytes32 payeeId) external view returns (Payee memory) {
        return _payees[payeeId];
    }

    function getProposal(uint256 id) external view returns (Proposal memory) {
        return _proposals[id];
    }

    function getAssetPolicy(address asset) external view returns (AssetPolicy memory) {
        return _assetPolicy[asset];
    }

    function bucketIds() external view returns (bytes32[] memory) {
        return _bucketIds;
    }

    // ═════════════════════════════ Internals ═════════════════════════════

    function _registerPayee(bytes32 id, address wallet, bytes32 labelHash, uint64 activeFrom, bool trusted)
        internal
    {
        if (wallet == address(0) || wallet == address(this) || _payees[id].active) revert InvalidParams();
        _payees[id] = Payee({
            wallet: wallet, activeFrom: activeFrom, active: true, firstPaid: trusted, labelHash: labelHash
        });
        payeeIdByWallet[wallet] = id;
        emit PayeeAdded(id, wallet, activeFrom, labelHash);
    }

    function _isUsablePayeeWallet(address wallet) internal view returns (bool) {
        bytes32 id = payeeIdByWallet[wallet];
        Payee storage p = _payees[id];
        return p.active && p.wallet == wallet && block.timestamp >= p.activeFrom;
    }

    function _checkT2(Action memory action) internal view {
        if (action.kind != KIND_PAY) revert InvalidParams();
        AssetPolicy memory ap = _assetPolicy[action.asset];
        if (!ap.allowed) revert T3_AssetNotAllowed(action.asset);
        Payee memory p = _payees[action.payeeId];
        if (!p.active) revert T3_UnknownPayee(action.payeeId);
        if (block.timestamp < p.activeFrom) revert T2_PayeeCoolingOff(action.payeeId, p.activeFrom);
        if (action.amount > ap.t2Ceiling) revert T3_AboveT2Ceiling(action.amount, ap.t2Ceiling);
    }

    function _execute(uint256 id, address signer) internal {
        Proposal storage pr = _proposals[id];
        if (pr.status != OPEN || pr.expiresAt == 0) revert ProposalNotOpen(id);
        if (block.timestamp > pr.expiresAt) revert ProposalExpired(id);
        Action memory a = pr.action;
        _checkT2(a); // re-check at execution time: the payee may have been removed meanwhile
        pr.status = EXECUTED;

        Payee storage p = _payees[a.payeeId];
        p.firstPaid = true;
        _debit(a.asset, a.bucket, a.amount);
        _record(_outflowSlots[a.asset], _outflowSlotHour[a.asset], a.amount);
        IERC20(a.asset).safeTransfer(p.wallet, a.amount);
        emit Approved(id, signer);
        emit Paid(a.payeeId, a.asset, a.amount, a.bucket, pr.intentHash);
    }

    function _ownerWithdraw(address asset, address to, uint256 amount) internal {
        uint256 free = unallocated(asset);
        if (amount > free) {
            uint256 need = amount - free;
            for (uint256 i; i < _bucketIds.length && need > 0; ++i) {
                bytes32 b = _bucketIds[i];
                uint256 bal = bucketBalance[asset][b];
                uint256 take = bal < need ? bal : need;
                if (take > 0) {
                    _debit(asset, b, take);
                    need -= take;
                }
            }
        }
        IERC20(asset).safeTransfer(to, amount);
        emit OwnerWithdrawal(asset, to, amount);
    }

    function _credit(address asset, bytes32 bucket, uint256 amount) internal {
        if (bucket == bytes32(0)) revert InvalidParams();
        if (!_knownBucket[bucket]) {
            if (_bucketIds.length >= MAX_BUCKETS) revert InvalidParams();
            _knownBucket[bucket] = true;
            _bucketIds.push(bucket);
        }
        bucketBalance[asset][bucket] += amount;
        totalAllocated[asset] += amount;
    }

    function _debit(address asset, bytes32 bucket, uint256 amount) internal {
        uint256 bal = bucketBalance[asset][bucket];
        if (bal < amount) revert InsufficientBucket(bucket, bal, amount);
        bucketBalance[asset][bucket] = bal - amount;
        totalAllocated[asset] -= amount;
    }

    function _record(uint256[24] storage slots, uint64[24] storage hours_, uint256 amount) internal {
        uint64 nowHour = uint64(block.timestamp / 1 hours);
        uint256 idx = nowHour % WINDOW_SLOTS;
        if (hours_[idx] != nowHour) {
            hours_[idx] = nowHour;
            slots[idx] = 0;
        }
        slots[idx] += amount;
    }

    function _windowSum(uint256[24] storage slots, uint64[24] storage hours_) internal view returns (uint256 sum) {
        uint64 nowHour = uint64(block.timestamp / 1 hours);
        for (uint256 i; i < WINDOW_SLOTS; ++i) {
            uint64 h = hours_[i];
            if (h != 0 && h + WINDOW_SLOTS > nowHour) sum += slots[i];
        }
    }

    function _swapMinOut(
        address assetIn,
        AssetPolicy memory pin,
        address assetOut,
        AssetPolicy memory pout,
        uint256 amountIn
    ) internal view returns (uint256) {
        (int256 priceIn, uint8 decIn) = _price(assetIn, pin);
        (int256 priceOut, uint8 decOut) = _price(assetOut, pout);
        return _fairOut(assetIn, assetOut, amountIn, priceIn, decIn, priceOut, decOut) * (10_000 - maxSlippageBps)
            / 10_000;
    }

    /// @dev Output is measured by balance delta, never trusted from the router's return value.
    function _executeSwap(address assetIn, address assetOut, uint256 amountIn, uint256 minOut)
        internal
        returns (uint256 received)
    {
        uint256 inBefore = IERC20(assetIn).balanceOf(address(this));
        uint256 outBefore = IERC20(assetOut).balanceOf(address(this));
        IERC20(assetIn).forceApprove(router, amountIn); // exact approval
        IAmmRouter(router).swapExactIn(assetIn, assetOut, amountIn, minOut, address(this));
        if (IERC20(assetIn).allowance(address(this), router) != 0) revert T3_ResidualApproval();
        uint256 spent = inBefore - IERC20(assetIn).balanceOf(address(this));
        if (spent != amountIn) revert T3_InputMismatch(spent, amountIn);
        received = IERC20(assetOut).balanceOf(address(this)) - outBefore;
        if (received < minOut) revert T3_SlippageFloor(received, minOut);
    }

    function _price(address asset, AssetPolicy memory ap) internal view returns (int256 answer, uint8 dec) {
        IAggregatorV3 feed = IAggregatorV3(ap.oracle);
        uint256 updatedAt;
        (, answer,, updatedAt,) = feed.latestRoundData();
        dec = feed.decimals();
        if (answer <= 0 || block.timestamp - updatedAt > maxOracleStaleness) revert T3_StaleOracle(asset);
        if (ap.isStable) {
            int256 one = int256(10 ** dec);
            int256 diff = answer > one ? answer - one : one - answer;
            if (uint256(diff) * 10_000 > uint256(depegBps) * uint256(one)) revert T3_Depegged(asset, answer);
        }
    }

    function _fairOut(
        address assetIn,
        address assetOut,
        uint256 amountIn,
        int256 priceIn,
        uint8 oracleDecIn,
        int256 priceOut,
        uint8 oracleDecOut
    ) internal view returns (uint256) {
        uint256 tokDecIn = IERC20Metadata(assetIn).decimals();
        uint256 tokDecOut = IERC20Metadata(assetOut).decimals();
        // value in USD with 18 decimals, then convert into assetOut units
        uint256 usd = amountIn * uint256(priceIn) * 1e18 / (10 ** (tokDecIn + oracleDecIn));
        return usd * (10 ** (tokDecOut + oracleDecOut)) / (uint256(priceOut) * 1e18);
    }

    function _checkChangeSelector(bytes calldata data) internal pure {
        if (data.length < 4) revert InvalidParams();
        bytes4 sel = bytes4(data[:4]);
        if (
            sel != this.changeAssetPolicy.selector && sel != this.changePair.selector
                && sel != this.changeRoles.selector && sel != this.changeVenues.selector
                && sel != this.changeParams.selector
        ) revert InvalidParams();
    }
}
