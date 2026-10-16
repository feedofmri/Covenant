// Seeded random-sequence invariant harness.
// Drives random (often adversarial) calls against the vault and checks the six invariants after every step.
// CI default: INVARIANT_RUNS=25 × INVARIANT_STEPS=40. Nightly/pre-submission: 300 × 60.
import { decodeEventLog, getAddress, parseAbi } from "viem";
import { deployStack, expect, time, usdc, id, B, P, HOUR, INTENT } from "../helpers.js";

const RUNS = Number(process.env.INVARIANT_RUNS ?? 25);
const STEPS = Number(process.env.INVARIANT_STEPS ?? 40);
const SEED = Number(process.env.INVARIANT_SEED ?? 20261016);

const transferAbi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("PolicyVault invariants (random sequences)", function () {
  this.timeout(0);

  it(`holds I-1…I-6 over ${RUNS} sequences × ${STEPS} steps`, async () => {
    const s = await deployStack({ fund: 3000 });
    const { hre, publicClient, vault, vaultOwner, vaultGuardian, vaultAttacker, USDC, EURC } = s;
    const assets = [USDC.address, EURC.address];
    const buckets = [B.FAMILY, B.EMERGENCY, B.SAVINGS];
    const payeeIds = [P.MOTHER, P.SCHOOL, P.SCAMMER, id("payee:random")];
    const allowedRecipients = new Set(
      [s.mother.account.address, s.school.account.address, s.amm.address, s.lending.address].map((a) => getAddress(a)),
    );
    const policyBefore = JSON.stringify({
      owner: await vault.read.owner(),
      guardian: await vault.read.guardian(),
      usdc: await vault.read.getAssetPolicy([USDC.address]),
      eurc: await vault.read.getAssetPolicy([EURC.address]),
    }, (_, v) => (typeof v === "bigint" ? v.toString() : v));
    let snapshot = await hre.network.provider.send("evm_snapshot");

    const rnd = prng(SEED);
    const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
    const amount = () => {
      const r = rnd();
      if (r < 0.1) return 0n;
      if (r < 0.2) return usdc(10_000_000); // absurd
      if (r < 0.3) return usdc(250) + BigInt(Math.floor(rnd() * 3)) - 1n; // around the cap
      return usdc(Math.floor(rnd() * 400) + 1);
    };
    const stats = { ok: 0, reverted: 0, checks: 0 };

    for (let run = 0; run < RUNS; run++) {
      await hre.network.provider.send("evm_revert", [snapshot]); // a snapshot is consumed by revert…
      snapshot = await hre.network.provider.send("evm_snapshot"); // …so take a fresh one for the next run
      const pays = []; // { hour, amount, asset }
      let proposals = 0;

      for (let step = 0; step < STEPS; step++) {
        const r = rnd();
        let tx;
        let kind;
        let agentCall = true;
        try {
          if (r < 0.15) {
            kind = "allocate";
            tx = () => vault.write.allocate([USDC.address, [pick(buckets)], [amount()], INTENT]);
          } else if (r < 0.22) {
            kind = "reallocate";
            tx = () => vault.write.reallocate([pick(assets), pick(buckets), pick(buckets), amount(), INTENT]);
          } else if (r < 0.45) {
            kind = "pay";
            tx = () => vault.write.pay([pick(payeeIds), pick(assets), amount(), pick(buckets), INTENT]);
          } else if (r < 0.55) {
            kind = "swap";
            const a = pick(assets);
            tx = () => vault.write.swap([pick(buckets), a, a === USDC.address ? EURC.address : USDC.address, amount(), INTENT]);
          } else if (r < 0.6) {
            kind = "supply";
            tx = () => vault.write.supply([pick(buckets), USDC.address, amount(), INTENT]);
          } else if (r < 0.63) {
            kind = "withdraw";
            tx = () => vault.write.withdraw([pick(buckets), USDC.address, amount(), INTENT]);
          } else if (r < 0.7) {
            kind = "propose";
            tx = () => vault.write.propose([{ kind: 0, payeeId: pick(payeeIds), asset: USDC.address, amount: amount(), bucket: pick(buckets) }, INTENT]);
          } else if (r < 0.75) {
            kind = "approve";
            agentCall = false;
            tx = () => vaultOwner.write.approve([BigInt(Math.floor(rnd() * (proposals + 1)))]);
          } else if (r < 0.82) {
            kind = "attacker";
            agentCall = false;
            const calls = [
              () => vaultAttacker.write.pay([P.MOTHER, USDC.address, 1n, B.FAMILY, INTENT]),
              () => vaultAttacker.write.addPayee([id("evil"), s.attacker.account.address, INTENT]),
              () => vaultAttacker.write.ownerWithdraw([USDC.address, s.attacker.account.address, 1n]),
              () => vault.write.addPayee([id("evil"), s.attacker.account.address, INTENT]), // agent key, owner fn
              () => vault.write.ownerWithdraw([USDC.address, s.agent.account.address, 1n]),
              () => vault.write.queueChange(["0x00000000"]),
              () => vault.write.approve([0n]),
              () => vault.write.unpause(),
            ];
            tx = pick(calls);
          } else if (r < 0.88) {
            kind = "warp";
            agentCall = false;
            await time.increase(Math.floor(rnd() * 30) * Number(HOUR) + 1);
            await s.usdcFeed.write.poke();
            await s.eurcFeed.write.poke();
          } else if (r < 0.91) {
            kind = "oracle";
            agentCall = false;
            const feed = pick([s.usdcFeed, s.eurcFeed]);
            const base = feed === s.usdcFeed ? 100000000 : 108000000;
            await feed.write.setAnswer([BigInt(Math.round(base * (0.95 + rnd() * 0.1)))]);
          } else if (r < 0.94) {
            kind = "pause";
            agentCall = false;
            await vaultGuardian.write.pause();
          } else if (r < 0.97) {
            kind = "unpause";
            agentCall = false;
            await vaultOwner.write.unpause();
          } else {
            kind = "income";
            agentCall = false;
            await USDC.write.mint([s.vaultAddress, amount() % usdc(1000)]);
          }

          if (tx) {
            const paused = await vault.read.paused();
            const hash = await tx();
            const receipt = await publicClient.waitForTransactionReceipt({ hash });
            stats.ok++;
            // I-6: a paused vault accepts no agent adapter call.
            if (agentCall && kind !== "withdraw") expect(paused, `I-6 agent ${kind} succeeded while paused`).to.equal(false);
            if (kind === "propose") proposals++;
            // I-1: every token leaving the vault goes to a registered payee, the router or the lending pool.
            for (const log of receipt.logs) {
              if (!assets.map((a) => getAddress(a)).includes(getAddress(log.address))) continue;
              let ev;
              try {
                ev = decodeEventLog({ abi: transferAbi, data: log.data, topics: log.topics });
              } catch {
                continue;
              }
              if (getAddress(ev.args.from) !== s.vaultAddress) continue;
              expect(allowedRecipients.has(getAddress(ev.args.to)), `I-1 leak to ${ev.args.to} via ${kind}`).to.equal(true);
              if (kind === "pay" || kind === "approve") {
                const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
                pays.push({ hour: block.timestamp / 3600n, amount: ev.args.value, asset: getAddress(log.address) });
              }
            }
            if (kind === "attacker") expect.fail("I-5 an unauthorised call succeeded");
          }
        } catch (e) {
          if (e?.name === "AssertionError") throw e;
          stats.reverted++;
        }

        // I-2: the on-chain window equals the independently computed 24 h sum and never exceeds the daily cap
        //      after an agent payment.
        const now = BigInt(await time.latest()) / 3600n;
        for (const asset of assets) {
          const expected = pays.filter((p) => p.asset === getAddress(asset) && p.hour + 24n > now)
            .reduce((a, p) => a + p.amount, 0n);
          expect(await vault.read.outflowLast24h([asset]), "I-2 window mismatch").to.equal(expected);
          // I-3: bucket accounting is exact and solvent.
          const bal = await (asset === USDC.address ? USDC : EURC).read.balanceOf([s.vaultAddress]);
          let sum = 0n;
          for (const b of buckets) sum += await vault.read.bucketBalance([asset, b]);
          const total = await vault.read.totalAllocated([asset]);
          expect(total, "I-3 buckets ≠ total").to.equal(sum);
          expect(total <= bal, "I-3 insolvent").to.equal(true);
          // I-4: no residual approvals.
          const tok = asset === USDC.address ? USDC : EURC;
          expect(await tok.read.allowance([s.vaultAddress, s.amm.address]), "I-4 router allowance").to.equal(0n);
          expect(await tok.read.allowance([s.vaultAddress, s.lending.address]), "I-4 pool allowance").to.equal(0n);
        }
        stats.checks++;
      }
      // I-5: owner-only state never changed by the agent or an attacker.
      const policyNow = JSON.stringify({
        owner: await vault.read.owner(),
        guardian: await vault.read.guardian(),
        usdc: await vault.read.getAssetPolicy([USDC.address]),
        eurc: await vault.read.getAssetPolicy([EURC.address]),
      }, (_, v) => (typeof v === "bigint" ? v.toString() : v));
      expect(policyNow, "I-5 policy changed").to.equal(policyBefore);
    }
    console.log(`      invariant stats: ${stats.ok} successful calls, ${stats.reverted} reverts, ${stats.checks} checkpoints`);
    expect(stats.ok).to.be.greaterThan(0);
  });

  it("I-2: T1 payments never push the window past the daily cap", async () => {
    const s = await deployStack({ fund: 20000 });
    await s.vault.write.allocate([s.USDC.address, [B.FAMILY], [usdc(20000)], INTENT]);
    const cap = (await s.vault.read.getAssetPolicy([s.USDC.address])).dailyCap;
    const rnd = prng(SEED + 1);
    for (let i = 0; i < 120; i++) {
      try {
        await s.vault.write.pay([P.MOTHER, s.USDC.address, usdc(Math.floor(rnd() * 120) + 1), B.FAMILY, INTENT]);
      } catch {
        /* capped */
      }
      expect((await s.vault.read.outflowLast24h([s.USDC.address])) <= cap).to.equal(true);
      await time.increase(Math.floor(rnd() * 4 * 3600));
    }
  });
});
