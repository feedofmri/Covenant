// Copies ABIs (and bytecode for contracts deployed outside Hardhat) into shared/abi/.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const artifacts = path.join(here, "..", "artifacts", "src");
const out = path.join(here, "..", "..", "shared", "abi");
mkdirSync(out, { recursive: true });

const contracts = {
  PolicyVault: "PolicyVault.sol",
  VaultFactory: "VaultFactory.sol",
  ReceiptRegistry: "ReceiptRegistry.sol",
  MockStable: "mocks/MockStable.sol",
  MockAggregator: "mocks/MockAggregator.sol",
  MockAmm: "mocks/MockAmm.sol",
  MockLendingPool: "mocks/MockLendingPool.sol",
  MaliciousNameToken: "mocks/AttackTokens.sol",
  FeeOnTransferToken: "mocks/AttackTokens.sol",
};

for (const [name, file] of Object.entries(contracts)) {
  const a = JSON.parse(readFileSync(path.join(artifacts, file, `${name}.json`), "utf8"));
  writeFileSync(path.join(out, `${name}.json`), JSON.stringify({ contractName: name, abi: a.abi, bytecode: a.bytecode }, null, 2) + "\n");
}
console.log(`exported ${Object.keys(contracts).length} artifacts to shared/abi`);
