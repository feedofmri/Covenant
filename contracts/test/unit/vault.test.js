import { encodeFunctionData, getAddress, parseAbi } from "viem";
import {
  deployStack, expectRevert, expect, time, usdc, id, B, P, HOUR, DAY, INTENT, zeroAddress, defaultPolicy,
} from "../helpers.js";

async function payday(s, amounts = [300, 200, 500]) {
  await s.vault.write.allocate([s.USDC.address, [B.FAMILY, B.EMERGENCY, B.SAVINGS], amounts.map(usdc), INTENT]);
}

describe("PolicyVault", () => {
  describe("initialisation", () => {
    it("stores roles, ceremony payees and policies", async () => {
      const s = await deployStack();
      expect(getAddress(await s.vault.read.owner())).to.equal(getAddress(s.owner.account.address));
      expect(getAddress(await s.vault.read.agent())).to.equal(getAddress(s.agent.account.address));
      const mom = await s.vault.read.getPayee([P.MOTHER]);
      expect(mom.active).to.equal(true);
      expect(mom.firstPaid).to.equal(true);
      const pol = await s.vault.read.getAssetPolicy([s.USDC.address]);
      expect(pol.perTxCap).to.equal(usdc(250));
      expect(await s.vault.read.allowedPair([s.USDC.address, s.EURC.address])).to.equal(true);
      expect(await s.vault.read.mandateHash()).to.equal(id("mandate-v1"));
    });

    it("cannot be initialised twice and the implementation is locked", async () => {
      const s = await deployStack();
      const args = [s.cfg, [], [], [], []];
      await expectRevert(s.vaultOwner.write.initialize(args), "InvalidParams");
      const impl = await s.hre.viem.getContractAt("PolicyVault", await s.factory.read.implementation());
      await expectRevert(impl.write.initialize(args), "InvalidParams");
    });

    it("factory refuses to create a vault for someone else", async () => {
      const s = await deployStack();
      await expectRevert(s.factory.write.createVault([s.cfg, [], [], [], []]), "OwnerMustSign");
      expect(await s.factory.read.vaultCount()).to.equal(1n);
    });

    it("rejects unknown selectors and plain ETH", async () => {
      const s = await deployStack();
      await expectRevert(
        s.attacker.sendTransaction({ to: s.vaultAddress, data: "0xb61d27f6" + "00".repeat(96) }),
        "T3_NoGenericCalls",
      );
      await expectRevert(s.attacker.sendTransaction({ to: s.vaultAddress, value: 1n }), "T3_NoGenericCalls");
    });
  });

  describe("buckets", () => {
    it("allocates unallocated funds and tracks totals", async () => {
      const s = await deployStack();
      expect(await s.vault.read.unallocated([s.USDC.address])).to.equal(usdc(1000));
      await payday(s);
      expect(await s.vault.read.bucketBalance([s.USDC.address, B.FAMILY])).to.equal(usdc(300));
      expect(await s.vault.read.unallocated([s.USDC.address])).to.equal(0n);
      expect(await s.vault.read.totalAllocated([s.USDC.address])).to.equal(usdc(1000));
      expect((await s.vault.read.bucketIds()).length).to.equal(3);
    });

    it("cannot allocate more than is unallocated", async () => {
      const s = await deployStack();
      await expectRevert(
        s.vault.write.allocate([s.USDC.address, [B.FAMILY], [usdc(1001)], INTENT]),
        "InsufficientUnallocated",
      );
      await expectRevert(s.vault.write.allocate([s.USDC.address, [B.FAMILY], [], INTENT]), "InvalidParams");
      await expectRevert(s.vault.write.allocate([s.attacker.account.address, [B.FAMILY], [1n], INTENT]),
        "T3_AssetNotAllowed");
      await expectRevert(s.vault.write.allocate([s.USDC.address, ["0x" + "00".repeat(32)], [1n], INTENT]),
        "InvalidParams");
    });

    it("reallocates between buckets", async () => {
      const s = await deployStack();
      await payday(s);
      await s.vault.write.reallocate([s.USDC.address, B.SAVINGS, B.FAMILY, usdc(100), INTENT]);
      expect(await s.vault.read.bucketBalance([s.USDC.address, B.FAMILY])).to.equal(usdc(400));
      await expectRevert(
        s.vault.write.reallocate([s.USDC.address, B.EMERGENCY, B.FAMILY, usdc(201), INTENT]),
        "InsufficientBucket",
      );
    });
  });

  describe("pay (T1)", () => {
    it("pays a registered payee from a bucket", async () => {
      const s = await deployStack();
      await payday(s);
      await s.vault.write.pay([P.MOTHER, s.USDC.address, usdc(200), B.FAMILY, INTENT]);
      expect(await s.USDC.read.balanceOf([s.mother.account.address])).to.equal(usdc(200));
      expect(await s.vault.read.outflowLast24h([s.USDC.address])).to.equal(usdc(200));
      expect(await s.vault.read.bucketBalance([s.USDC.address, B.FAMILY])).to.equal(usdc(100));
    });

    it("refuses unknown payees, non-agents, unknown assets and empty buckets", async () => {
      const s = await deployStack();
      await payday(s);
      await expectRevert(s.vault.write.pay([P.SCAMMER, s.USDC.address, 1n, B.FAMILY, INTENT]), "T3_UnknownPayee");
      await expectRevert(s.vaultAttacker.write.pay([P.MOTHER, s.USDC.address, 1n, B.FAMILY, INTENT]), "T3_NotAgent");
      await expectRevert(s.vaultOwner.write.pay([P.MOTHER, s.USDC.address, 1n, B.FAMILY, INTENT]), "T3_NotAgent");
      await expectRevert(s.vault.write.pay([P.MOTHER, s.attacker.account.address, 1n, B.FAMILY, INTENT]),
        "T3_AssetNotAllowed");
      await expectRevert(s.vault.write.pay([P.MOTHER, s.USDC.address, usdc(201), B.EMERGENCY, INTENT]),
        "InsufficientBucket");
    });

    it("enforces per-transaction cap, daily cap and the T2 ceiling", async () => {
      const s = await deployStack({ fund: 5000 });
      await s.vault.write.allocate([s.USDC.address, [B.FAMILY], [usdc(5000)], INTENT]);
      await expectRevert(s.vault.write.pay([P.MOTHER, s.USDC.address, usdc(251), B.FAMILY, INTENT]),
        "T2_AbovePerTxCap");
      await expectRevert(s.vault.write.pay([P.MOTHER, s.USDC.address, usdc(1001), B.FAMILY, INTENT]),
        "T3_AboveT2Ceiling");
      await s.vault.write.pay([P.MOTHER, s.USDC.address, usdc(200), B.FAMILY, INTENT]);
      await expectRevert(s.vault.write.pay([P.SCHOOL, s.USDC.address, usdc(101), B.FAMILY, INTENT]),
        "T2_DailyCapExceeded");
      await s.vault.write.pay([P.SCHOOL, s.USDC.address, usdc(100), B.FAMILY, INTENT]);
    });

    it("uses a 24 h sliding window, not a reset (no 2x across the boundary)", async () => {
      const s = await deployStack({ fund: 5000 });
      await s.vault.write.allocate([s.USDC.address, [B.FAMILY], [usdc(5000)], INTENT]);
      await s.vault.write.pay([P.MOTHER, s.USDC.address, usdc(200), B.FAMILY, INTENT]);
      await time.increase(Number(23n * HOUR));
      await s.vault.write.pay([P.MOTHER, s.USDC.address, usdc(100), B.FAMILY, INTENT]);
      await expectRevert(s.vault.write.pay([P.MOTHER, s.USDC.address, 1n, B.FAMILY, INTENT]), "T2_DailyCapExceeded");
      await time.increase(Number(2n * HOUR)); // first payment has left the window
      await s.vault.write.pay([P.MOTHER, s.USDC.address, usdc(200), B.FAMILY, INTENT]);
      await expectRevert(s.vault.write.pay([P.MOTHER, s.USDC.address, 1n, B.FAMILY, INTENT]), "T2_DailyCapExceeded");
      await time.increase(Number(DAY + HOUR));
      expect(await s.vault.read.outflowLast24h([s.USDC.address])).to.equal(0n);
    });

    it("new payees cool off, then need an owner-approved first payment", async () => {
      const s = await deployStack();
      await payday(s);
      const scam = s.attacker.account.address;
      await s.vaultOwner.write.addPayee([P.SCAMMER, scam, id("Customs office")]);
      await expectRevert(s.vault.write.pay([P.SCAMMER, s.USDC.address, usdc(50), B.FAMILY, INTENT]),
        "T2_PayeeCoolingOff");
      await expectRevert(
        s.vault.write.propose([{ kind: 0, payeeId: P.SCAMMER, asset: s.USDC.address, amount: usdc(50), bucket: B.FAMILY }, INTENT]),
        "T2_PayeeCoolingOff",
      );
      await time.increase(Number(DAY));
      await expectRevert(s.vault.write.pay([P.SCAMMER, s.USDC.address, usdc(50), B.FAMILY, INTENT]),
        "T2_FirstPaymentNeedsOwner");
    });

    it("rejects pay when paused or when the agent key is expired or revoked", async () => {
      const s = await deployStack();
      await payday(s);
      await s.vaultGuardian.write.pause();
      await expectRevert(s.vault.write.pay([P.MOTHER, s.USDC.address, 1n, B.FAMILY, INTENT]), "VaultPaused");
      await expectRevert(s.vaultGuardian.write.unpause(), "T3_NotOwner");
      await expectRevert(s.vault.write.unpause(), "T3_NotOwner");
      await s.vaultOwner.write.unpause();
      await s.vault.write.pay([P.MOTHER, s.USDC.address, 1n, B.FAMILY, INTENT]);
      await time.increase(Number(366n * DAY));
      await expectRevert(s.vault.write.pay([P.MOTHER, s.USDC.address, 1n, B.FAMILY, INTENT]), "T3_AgentExpired");
    });

    it("guardian can revoke the agent; attacker cannot pause", async () => {
      const s = await deployStack();
      await payday(s);
      await expectRevert(s.vaultAttacker.write.pause(), "T3_NotGuardian");
      await expectRevert(s.vaultAttacker.write.revokeAgent(), "T3_NotGuardian");
      await s.vaultGuardian.write.revokeAgent();
      await expectRevert(s.vault.write.pay([P.MOTHER, s.USDC.address, 1n, B.FAMILY, INTENT]), "T3_NotAgent");
    });

    it("the agent itself can trip the circuit breaker", async () => {
      const s = await deployStack();
      await s.vault.write.pause();
      expect(await s.vault.read.paused()).to.equal(true);
    });
  });

  describe("proposals (T2)", () => {
    const action = (s, amount, payeeId = P.MOTHER) => ({
      kind: 0, payeeId, asset: s.USDC.address, amount: usdc(amount), bucket: B.FAMILY,
    });

    it("agent proposes above the T1 cap, owner approves and it executes", async () => {
      const s = await deployStack({ fund: 2000 });
      await s.vault.write.allocate([s.USDC.address, [B.FAMILY], [usdc(2000)], INTENT]);
      await s.vault.write.propose([action(s, 400), id("hospital")]);
      const pr = await s.vault.read.getProposal([0n]);
      expect(pr.status).to.equal(0);
      await expectRevert(s.vault.write.approve([0n]), "T3_NotOwner");
      await s.vaultOwner.write.approve([0n]);
      expect(await s.USDC.read.balanceOf([s.mother.account.address])).to.equal(usdc(400));
      expect((await s.vault.read.getProposal([0n])).status).to.equal(1);
      await expectRevert(s.vaultOwner.write.approve([0n]), "ProposalNotOpen");
    });

    it("refuses proposals above the ceiling, to unknown payees, or of unknown kind", async () => {
      const s = await deployStack();
      await expectRevert(s.vault.write.propose([action(s, 1001), INTENT]), "T3_AboveT2Ceiling");
      await expectRevert(s.vault.write.propose([action(s, 10, P.SCAMMER), INTENT]), "T3_UnknownPayee");
      await expectRevert(s.vault.write.propose([{ ...action(s, 10), kind: 1 }, INTENT]), "InvalidParams");
      await expectRevert(s.vault.write.propose([{ ...action(s, 10), asset: s.attacker.account.address }, INTENT]),
        "T3_AssetNotAllowed");
      await expectRevert(s.vaultAttacker.write.propose([action(s, 10), INTENT]), "T3_NotAgent");
    });

    it("proposals expire and can be cancelled", async () => {
      const s = await deployStack();
      await payday(s);
      await s.vault.write.propose([action(s, 100), INTENT]);
      await s.vault.write.propose([action(s, 100), INTENT]);
      await expectRevert(s.vaultAttacker.write.cancel([1n]), "T3_NotOwner");
      await s.vault.write.cancel([1n]);
      await expectRevert(s.vaultOwner.write.approve([1n]), "ProposalNotOpen");
      await expectRevert(s.vaultOwner.write.cancel([1n]), "ProposalNotOpen");
      await expectRevert(s.vaultOwner.write.approve([9n]), "ProposalNotOpen");
      await time.increase(Number(DAY + 1n));
      await expectRevert(s.vaultOwner.write.approve([0n]), "ProposalExpired");
    });

    it("re-checks the payee at execution time", async () => {
      const s = await deployStack();
      await payday(s);
      await s.vault.write.propose([action(s, 100), INTENT]);
      await s.vaultOwner.write.removePayee([P.MOTHER]);
      await expectRevert(s.vaultOwner.write.approve([0n]), "T3_UnknownPayee");
    });

    it("owner approval unlocks the first payment to a cooled-off payee", async () => {
      const s = await deployStack();
      await payday(s);
      const wallet = s.employer.account.address;
      await s.vaultOwner.write.addPayee([P.SCAMMER, wallet, id("Landlord")]);
      await time.increase(Number(DAY));
      await s.vault.write.propose([action(s, 50, P.SCAMMER), INTENT]);
      await s.vaultOwner.write.approve([0n]);
      await s.vault.write.pay([P.SCAMMER, s.USDC.address, usdc(10), B.FAMILY, INTENT]);
    });

    it("approveWithSig accepts the owner's EIP-712 signature and nobody else's", async () => {
      const s = await deployStack();
      await payday(s);
      await s.vault.write.propose([action(s, 100), INTENT]);
      const deadline = BigInt(await time.latest()) + 3600n;
      const chainId = await s.publicClient.getChainId();
      const typed = {
        domain: { name: "Covenant PolicyVault", version: "1", chainId, verifyingContract: s.vaultAddress },
        types: { Approve: [{ name: "id", type: "uint256" }, { name: "deadline", type: "uint256" }] },
        primaryType: "Approve",
        message: { id: 0n, deadline },
      };
      const bad = await s.attacker.signTypedData(typed);
      await expectRevert(s.vault.write.approveWithSig([0n, deadline, bad]), "T3_NotOwner");
      const sig = await s.owner.signTypedData(typed);
      await expectRevert(s.vault.write.approveWithSig([0n, 1n, sig]), "ProposalExpired");
      await s.vault.write.approveWithSig([0n, deadline, sig]); // relayed by the agent
      expect(await s.USDC.read.balanceOf([s.mother.account.address])).to.equal(usdc(100));
    });
  });

  describe("swap adapter", () => {
    it("swaps within the vault above the oracle floor", async () => {
      const s = await deployStack();
      await payday(s);
      await s.vault.write.swap([B.SAVINGS, s.USDC.address, s.EURC.address, usdc(108), INTENT]);
      const eur = await s.vault.read.bucketBalance([s.EURC.address, B.SAVINGS]);
      expect(eur > usdc(99.4) && eur < usdc(100.1)).to.equal(true);
      expect(await s.EURC.read.balanceOf([s.vaultAddress])).to.equal(eur);
      expect(await s.USDC.read.allowance([s.vaultAddress, s.amm.address])).to.equal(0n);
      expect(await s.vault.read.swapVolumeLast24h([s.USDC.address])).to.equal(usdc(108));
    });

    it("refuses disallowed pairs and caps swap volume", async () => {
      const s = await deployStack({ fund: 2000 });
      await s.vault.write.allocate([s.USDC.address, [B.SAVINGS], [usdc(2000)], INTENT]);
      await expectRevert(s.vault.write.swap([B.SAVINGS, s.USDC.address, s.attacker.account.address, 1n, INTENT]),
        "T3_PairNotAllowed");
      await expectRevert(s.vault.write.swap([B.SAVINGS, s.USDC.address, s.EURC.address, usdc(251), INTENT]),
        "T2_AbovePerTxCap");
      await s.vault.write.swap([B.SAVINGS, s.USDC.address, s.EURC.address, usdc(250), INTENT]);
      await s.vault.write.swap([B.SAVINGS, s.USDC.address, s.EURC.address, usdc(250), INTENT]);
      await expectRevert(s.vault.write.swap([B.SAVINGS, s.USDC.address, s.EURC.address, 1n, INTENT]),
        "T2_DailySwapCapExceeded");
      await s.vaultOwner.write.removePair([s.USDC.address, s.EURC.address]);
      await expectRevert(s.vault.write.swap([B.SAVINGS, s.USDC.address, s.EURC.address, 1n, INTENT]),
        "T3_PairNotAllowed");
    });

    it("reverts when the pool is skewed below the oracle floor (price manipulation)", async () => {
      const s = await deployStack();
      await payday(s);
      // attacker dumps USDC into the pool, making EURC expensive
      await s.USDC.write.mint([s.deployer.account.address, usdc(500000)]);
      await s.USDC.write.approve([s.amm.address, usdc(500000)]);
      await s.amm.write.swapExactIn([s.USDC.address, s.EURC.address, usdc(500000), 0n, s.deployer.account.address]);
      await expectRevert(s.vault.write.swap([B.SAVINGS, s.USDC.address, s.EURC.address, usdc(100), INTENT]),
        "slippage");
    });

    it("reverts on depeg and on stale oracles; blocks lending too", async () => {
      const s = await deployStack();
      await payday(s);
      await s.usdcFeed.write.setAnswer([96000000n]);
      await expectRevert(s.vault.write.swap([B.SAVINGS, s.USDC.address, s.EURC.address, usdc(10), INTENT]),
        "T3_Depegged");
      await expectRevert(s.vault.write.supply([B.SAVINGS, s.USDC.address, usdc(10), INTENT]), "T3_Depegged");
      await s.usdcFeed.write.setAnswer([100000000n]);
      await time.increase(Number(DAY + 1n));
      await expectRevert(s.vault.write.swap([B.SAVINGS, s.USDC.address, s.EURC.address, usdc(10), INTENT]),
        "T3_StaleOracle");
    });

    it("detects residual approvals and routers that keep the output", async () => {
      const s = await deployStack({ timelockDelay: 3600 });
      await payday(s);
      const leaky = await s.hre.viem.deployContract("LeakyRouter");
      await s.EURC.write.mint([leaky.address, usdc(1000)]);
      const data = encodeFunctionData({
        abi: s.vault.abi, functionName: "changeVenues", args: [leaky.address, s.lending.address],
      });
      await s.vaultOwner.write.queueChange([data]);
      await time.increase(3600);
      await s.vaultOwner.write.executeChange([data]);
      await expectRevert(s.vault.write.swap([B.SAVINGS, s.USDC.address, s.EURC.address, usdc(10), INTENT]),
        "T3_ResidualApproval");

      const thief = await s.hre.viem.deployContract("ThievingRouter");
      const data2 = encodeFunctionData({
        abi: s.vault.abi, functionName: "changeVenues", args: [thief.address, s.lending.address],
      });
      await s.vaultOwner.write.queueChange([data2]);
      await time.increase(3600);
      await s.vaultOwner.write.executeChange([data2]);
      await expectRevert(s.vault.write.swap([B.SAVINGS, s.USDC.address, s.EURC.address, usdc(10), INTENT]),
        "T3_SlippageFloor");
    });
  });

  describe("lending adapter", () => {
    it("supplies within the cap and withdraws with interest back into the bucket", async () => {
      const s = await deployStack({ fund: 3000 });
      await s.vault.write.allocate([s.USDC.address, [B.SAVINGS], [usdc(3000)], INTENT]);
      await s.vault.write.supply([B.SAVINGS, s.USDC.address, usdc(800), INTENT]);
      expect(await s.vault.read.supplied([s.USDC.address])).to.equal(usdc(800));
      await expectRevert(s.vault.write.supply([B.SAVINGS, s.USDC.address, usdc(201), INTENT]),
        "T2_LendingCapExceeded");
      await time.increase(Number(30n * DAY));
      await s.vault.write.withdraw([B.SAVINGS, s.USDC.address, 2n ** 256n - 1n, INTENT]);
      expect(await s.vault.read.supplied([s.USDC.address])).to.equal(0n);
      const bal = await s.vault.read.bucketBalance([s.USDC.address, B.SAVINGS]);
      expect(bal > usdc(3000)).to.equal(true); // principal + interest
    });

    it("withdraw: owner allowed, attacker refused, paused agent refused", async () => {
      const s = await deployStack();
      await payday(s);
      await s.vault.write.supply([B.SAVINGS, s.USDC.address, usdc(100), INTENT]);
      await expectRevert(s.vaultAttacker.write.withdraw([B.SAVINGS, s.USDC.address, 1n, INTENT]), "T3_NotAgent");
      await s.vaultGuardian.write.pause();
      await expectRevert(s.vault.write.withdraw([B.SAVINGS, s.USDC.address, 1n, INTENT]), "VaultPaused");
      await s.vaultOwner.write.withdraw([B.SAVINGS, s.USDC.address, usdc(50), INTENT]);
      expect(await s.vault.read.supplied([s.USDC.address])).to.equal(usdc(50));
    });

    it("withdraw refuses an expired agent", async () => {
      const s = await deployStack();
      await time.increase(Number(366n * DAY));
      await expectRevert(s.vault.write.withdraw([B.SAVINGS, s.USDC.address, 1n, INTENT]), "T3_AgentExpired");
    });
  });

  describe("governance", () => {
    it("loosening is timelocked; agent cannot queue", async () => {
      const s = await deployStack();
      const looser = defaultPolicy(s.usdcFeed.address, { perTxCap: usdc(5000), dailyCap: usdc(10000) });
      const data = encodeFunctionData({ abi: s.vault.abi, functionName: "changeAssetPolicy", args: [s.USDC.address, looser] });
      await expectRevert(s.vault.write.queueChange([data]), "T3_NotOwner");
      await expectRevert(s.vaultOwner.write.executeChange([data]), "ChangeNotQueued");
      await s.vaultOwner.write.queueChange([data]);
      await expectRevert(s.vaultOwner.write.executeChange([data]), "TimelockNotReady");
      await time.increase(Number(HOUR));
      await s.vaultOwner.write.executeChange([data]);
      expect((await s.vault.read.getAssetPolicy([s.USDC.address])).perTxCap).to.equal(usdc(5000));
    });

    it("change targets cannot be called directly and only whitelisted selectors queue", async () => {
      const s = await deployStack();
      await expectRevert(s.vaultOwner.write.changeRoles([s.attacker.account.address, zeroAddress, zeroAddress, 0n]),
        "T3_NotOwner");
      await expectRevert(s.vault.write.changePair([s.USDC.address, s.attacker.account.address, true]), "T3_NotOwner");
      const bad = encodeFunctionData({ abi: s.vault.abi, functionName: "unpause" });
      await expectRevert(s.vaultOwner.write.queueChange([bad]), "InvalidParams");
      await expectRevert(s.vaultOwner.write.queueChange(["0x12"]), "InvalidParams");
    });

    it("rotates roles, pairs and params through the timelock; changes can be cancelled", async () => {
      const s = await deployStack();
      const calls = [
        ["changeRoles", [s.owner.account.address, s.school.account.address, s.employer.account.address, 2n ** 63n]],
        ["changePair", [s.EURC.address, s.USDC.address, false]],
        ["changeParams", [3600, 7200, 3600, 100, 300, 600]],
      ].map(([functionName, args]) => encodeFunctionData({ abi: s.vault.abi, functionName, args }));
      for (const d of calls) await s.vaultOwner.write.queueChange([d]);
      await time.increase(Number(HOUR));
      for (const d of calls) await s.vaultOwner.write.executeChange([d]);
      expect(getAddress(await s.vault.read.agent())).to.equal(getAddress(s.employer.account.address));
      expect(await s.vault.read.allowedPair([s.EURC.address, s.USDC.address])).to.equal(false);
      expect(await s.vault.read.coolingOff()).to.equal(3600);

      const bogus = encodeFunctionData({ abi: s.vault.abi, functionName: "changeParams", args: [0, 0, 0, 5000, 0, 0] });
      await s.vaultOwner.write.queueChange([bogus]);
      await time.increase(7200);
      await expectRevert(s.vaultOwner.write.executeChange([bogus]), "InvalidParams");

      const zeroOwner = encodeFunctionData({ abi: s.vault.abi, functionName: "changeRoles",
        args: [zeroAddress, zeroAddress, zeroAddress, 0n] });
      await s.vaultOwner.write.queueChange([zeroOwner]);
      const h = (await s.publicClient.getContractEvents({ address: s.vaultAddress, abi: s.vault.abi, eventName: "ChangeQueued" })).at(-1).args.changeHash;
      await s.vaultOwner.write.cancelChange([h]);
      await expectRevert(s.vaultOwner.write.cancelChange([h]), "ChangeNotQueued");
    });

    it("tightening is instant and may only go down", async () => {
      const s = await deployStack();
      await s.vaultOwner.write.lowerCaps([s.USDC.address, usdc(100), usdc(100), usdc(500), usdc(100)]);
      expect((await s.vault.read.getAssetPolicy([s.USDC.address])).perTxCap).to.equal(usdc(100));
      await expectRevert(s.vaultOwner.write.lowerCaps([s.USDC.address, usdc(101), usdc(100), usdc(500), usdc(100)]),
        "InvalidParams");
      await expectRevert(s.vaultOwner.write.lowerCaps([s.USDC.address, usdc(100), usdc(100), usdc(500), usdc(101)]),
        "InvalidParams");
      await expectRevert(s.vault.write.lowerCaps([s.USDC.address, 0n, 0n, 0n, 0n]), "T3_NotOwner");
      await expectRevert(s.vaultOwner.write.removePayee([P.SCAMMER]), "T3_UnknownPayee");
    });

    it("payee registry rejects duplicates, zero and self addresses", async () => {
      const s = await deployStack();
      await expectRevert(s.vaultOwner.write.addPayee([P.MOTHER, s.attacker.account.address, id("x")]), "InvalidParams");
      await expectRevert(s.vaultOwner.write.addPayee([id("z"), zeroAddress, id("x")]), "InvalidParams");
      await expectRevert(s.vaultOwner.write.addPayee([id("v"), s.vaultAddress, id("x")]), "InvalidParams");
      await expectRevert(s.vault.write.addPayee([id("a"), s.attacker.account.address, id("x")]), "T3_NotOwner");
    });

    it("mandate hash is owner-only", async () => {
      const s = await deployStack();
      await s.vaultOwner.write.setMandateHash([id("mandate-v2")]);
      expect(await s.vault.read.mandateHash()).to.equal(id("mandate-v2"));
      await expectRevert(s.vault.write.setMandateHash([id("evil")]), "T3_NotOwner");
    });
  });

  describe("owner self-protection", () => {
    it("instant to self or a cooled-off payee; anywhere else waits out the cooling-off", async () => {
      const s = await deployStack();
      await payday(s, [100, 100, 100]); // 700 unallocated
      await s.vaultOwner.write.ownerWithdraw([s.USDC.address, s.owner.account.address, usdc(100)]);
      await s.vaultOwner.write.ownerWithdraw([s.USDC.address, s.mother.account.address, usdc(100)]);
      expect(await s.USDC.read.balanceOf([s.mother.account.address])).to.equal(usdc(100));

      const scammer = s.attacker.account.address;
      await s.vaultOwner.write.ownerWithdraw([s.USDC.address, scammer, usdc(600)]);
      expect(await s.USDC.read.balanceOf([scammer])).to.equal(0n);
      const data = encodeFunctionData({ abi: s.vault.abi, functionName: "changeOwnerWithdrawal",
        args: [s.USDC.address, scammer, usdc(600)] });
      await expectRevert(s.vaultOwner.write.executeChange([data]), "TimelockNotReady");
      await time.increase(Number(DAY));
      await s.vaultOwner.write.executeChange([data]); // drains unallocated then buckets
      expect(await s.USDC.read.balanceOf([scammer])).to.equal(usdc(600));
      // 500 came from unallocated, the remaining 100 from buckets (300 → 200)
      expect(await s.vault.read.totalAllocated([s.USDC.address])).to.equal(usdc(200));
      await expectRevert(s.vaultAttacker.write.ownerWithdraw([s.USDC.address, scammer, 1n]), "T3_NotOwner");
    });
  });

  describe("ReceiptRegistry", () => {
    it("anchors receipts and batches once", async () => {
      const s = await deployStack();
      await s.registry.write.anchor([id("r1"), id("i1")]);
      const t = await s.registry.read.anchoredAt([id("r1")]);
      expect(t > 0n).to.equal(true);
      await time.increase(10);
      await s.registry.write.anchor([id("r1"), id("i1")]);
      expect(await s.registry.read.anchoredAt([id("r1")])).to.equal(t);
      await s.registry.write.anchorBatch([id("root"), 5]);
      await s.registry.write.anchorBatch([id("root"), 5]);
      expect((await s.registry.read.anchoredAt([id("root")])) > 0n).to.equal(true);
    });
  });

  describe("mocks used by the demo", () => {
    it("memo transfers and faucet limits", async () => {
      const s = await deployStack();
      await s.USDC.write.mint([s.employer.account.address, usdc(500)]);
      const usdcEmp = await s.hre.viem.getContractAt("MockStable", s.USDC.address, { client: { wallet: s.employer } });
      await usdcEmp.write.transferWithMemo([s.vaultAddress, usdc(500), "October wages"]);
      expect(await s.vault.read.unallocated([s.USDC.address])).to.equal(usdc(1500));
      await expectRevert(usdcEmp.write.mint([s.employer.account.address, 1n]), "faucet only");
      await expectRevert(s.USDC.write.mint([s.employer.account.address, usdc(2000000)]), "limit");
      expect(await s.amm.read.quote([s.USDC.address, s.attacker.account.address, 1n])).to.equal(0n);
      const abi = parseAbi(["function isMock() view returns (bool)"]);
      expect(await s.publicClient.readContract({ address: s.amm.address, abi, functionName: "isMock" })).to.equal(true);
    });
  });
});
